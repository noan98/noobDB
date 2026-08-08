import { useEffect, useMemo, useRef, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { api, type TableColumnInfo } from "../api/tauri";
import { useT } from "../i18n";
import {
  buildColumnJumpSql,
  buildTableJumpSql,
  buildTableScanSql,
  DEFAULT_SCAN_ROW_THRESHOLD,
  parseScanRow,
  shouldSkipTableForScan,
  type MatchMode,
  type ScanColumn,
} from "./dataSearch";
import { useConfirm } from "./ConfirmDialog";
import { EmptyState } from "./EmptyState";
import { ErrorNote, FieldLabel, FormSection } from "./modalForm";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, Checkbox, Input, Radio, Select } from "./ui";
import { LoadingButton } from "./LoadingButton";
import { Icon, ICON_SIZES } from "./Icon";
import { Spinner } from "./Spinner";

/**
 * DB 全体からの値検索 (#748)。「この値はどのテーブル・どの列にあるか」を、対象
 * データベースのテーブルを順に走査して調べる横断検索モーダル。
 *
 * `api.runQuery` (非ストリーミング) をテーブルごとに順次呼ぶオーケストレーション。
 * `planWatch` と同じ理由 (履歴を汚さない) で `run_query_stream` ではなくこちらを
 * 使う。生成する SQL はすべて `SELECT` (集計 `SUM(CASE...)` によるヒット件数取得と
 * ヒット一覧クリック時の `SELECT * ... WHERE` のみ) なので、読み取り専用セッションでも
 * 完全に動作する。純ロジック (列型による絞り込み・SQL 生成・スキップ判定) は
 * `dataSearch.ts` に分離してテストする。
 */

interface Props {
  sessionId: string;
  database: string;
  driver: string;
  isProduction: boolean;
  profileName: string;
  /** ヒット行クリック時、絞り込み結果を新規タブで開くためのコールバック。 */
  onOpenHit: (sql: string, title: string) => void;
  onClose: () => void;
}

type ScopeMode = "all" | "selected";

type MetaState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; tables: string[]; estimates: Record<string, number | null> };

interface HitEntry {
  table: string;
  status: "hit";
  columns: ScanColumn[];
  hits: { column: string; count: number }[];
}

interface SkippedEntry {
  table: string;
  status: "skipped";
  reason: "row-threshold" | "no-searchable-columns" | "error";
  detail?: string;
}

interface NoHitEntry {
  table: string;
  status: "no-hit";
}

type ResultEntry = HitEntry | SkippedEntry | NoHitEntry;

interface Progress {
  index: number;
  total: number;
  currentTable: string | null;
}

const MATCH_MODES: MatchMode[] = ["contains", "prefix", "exact"];

export function DataSearchModal({
  sessionId,
  database,
  driver,
  isProduction,
  profileName,
  onOpenHit,
  onClose,
}: Props) {
  const t = useT();
  const { confirm, dialog: confirmDialog } = useConfirm();

  const [term, setTerm] = useState("");
  const [matchMode, setMatchMode] = useState<MatchMode>("contains");
  const [scope, setScope] = useState<ScopeMode>("all");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [tableFilter, setTableFilter] = useState("");
  const [threshold, setThreshold] = useState(DEFAULT_SCAN_ROW_THRESHOLD);

  const [meta, setMeta] = useState<MetaState>({ kind: "loading" });
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [results, setResults] = useState<ResultEntry[]>([]);
  const cancelledRef = useRef(false);

  // 対象データベースのテーブル一覧 + 概算行数を先読みする (SchemaExportModal と
  // 同じ取得パターン)。列詳細 (describeTable) はスキャン実行時にテーブルごとに
  // 取得する — 全テーブル先読みだと describeTable の並列発行が重く、スキャン開始前の
  // 待ち時間が長くなるため。
  useEffect(() => {
    let cancelled = false;
    setMeta({ kind: "loading" });
    (async () => {
      const [tables, estimates] = await Promise.all([
        api.listTables(sessionId, database),
        api.tableRowEstimates(sessionId, database),
      ]);
      if (cancelled) return;
      const estimateMap: Record<string, number | null> = {};
      for (const e of estimates) estimateMap[e.name] = e.estimate;
      setMeta({ kind: "ready", tables, estimates: estimateMap });
    })().catch((e) => {
      if (!cancelled) setMeta({ kind: "error", message: String(e) });
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, database]);

  // モーダルのアンマウント (切断・クローズ) 時にスキャンループを止める。
  useEffect(() => () => { cancelledRef.current = true; }, []);

  const allTables = meta.kind === "ready" ? meta.tables : [];
  const estimates = meta.kind === "ready" ? meta.estimates : {};

  const filteredTables = useMemo(() => {
    const q = tableFilter.trim().toLowerCase();
    if (!q) return allTables;
    return allTables.filter((tb) => tb.toLowerCase().includes(q));
  }, [allTables, tableFilter]);

  const targetTables = useMemo(
    () => (scope === "all" ? allTables : allTables.filter((tb) => selected.has(tb))),
    [scope, allTables, selected],
  );

  const targetEstimateTotal = useMemo(() => {
    let sum = 0;
    let hasUnknown = false;
    for (const tb of targetTables) {
      const e = estimates[tb];
      if (e === null || e === undefined) hasUnknown = true;
      else sum += e;
    }
    return { sum, hasUnknown };
  }, [targetTables, estimates]);

  const toggleTable = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const emptySelection = scope === "selected" && selected.size === 0;
  const canStart = meta.kind === "ready" && term.trim() !== "" && !emptySelection && targetTables.length > 0;

  const appendResult = (entry: ResultEntry) => {
    setResults((prev) => [...prev, entry]);
  };

  const handleCancel = () => {
    cancelledRef.current = true;
    setScanning(false);
  };

  const handleStart = async () => {
    if (!canStart) return;
    const rowsLabel = targetEstimateTotal.hasUnknown
      ? t("dataSearchEstimateUnknownRows", { rows: targetEstimateTotal.sum })
      : t("dataSearchEstimateRows", { rows: targetEstimateTotal.sum });
    // 実行前確認 (常時)。本番接続では追加でトーンを警告に上げ、専用の注意文を
    // 挿入する — この機能は SELECT のみで書き込みリスクは無いため、破壊的操作
    // 用のタイプ入力ゲート (typeToConfirm) までは要求せず、警告トーンの確認
    // ダイアログ 1 回に留める (サーバ負荷への注意喚起が主目的のため)。
    const bodyText = t("dataSearchConfirmBody", { count: targetTables.length, rows: rowsLabel });
    const ok = await confirm({
      title: t("dataSearchConfirmTitle", { count: targetTables.length }),
      message: isProduction ? (
        <chakra.div display="flex" flexDirection="column" gap="2">
          <chakra.span>{bodyText}</chakra.span>
          <chakra.span fontWeight={600}>
            {t("dataSearchProductionConfirm", { name: profileName })}
          </chakra.span>
        </chakra.div>
      ) : (
        bodyText
      ),
      tone: isProduction ? "warning" : "primary",
      confirmLabel: t("dataSearchStart"),
    });
    if (!ok) return;

    cancelledRef.current = false;
    setResults([]);
    setProgress({ index: 0, total: targetTables.length, currentTable: null });
    setScanning(true);

    const searchTerm = term.trim();
    for (let i = 0; i < targetTables.length; i++) {
      if (cancelledRef.current) break;
      const table = targetTables[i];
      setProgress({ index: i, total: targetTables.length, currentTable: table });

      const estimate = estimates[table] ?? null;
      if (shouldSkipTableForScan(estimate, threshold)) {
        appendResult({ table, status: "skipped", reason: "row-threshold" });
        continue;
      }

      let columns: TableColumnInfo[];
      try {
        columns = await api.describeTable(sessionId, database, table);
      } catch (e) {
        if (cancelledRef.current) break;
        appendResult({ table, status: "skipped", reason: "error", detail: String(e) });
        continue;
      }
      if (cancelledRef.current) break;

      const scanColumns: ScanColumn[] = columns.map((c) => ({ name: c.name, dataType: c.data_type }));
      const scan = buildTableScanSql(driver, database, table, scanColumns, searchTerm, matchMode);
      if (!scan) {
        appendResult({ table, status: "skipped", reason: "no-searchable-columns" });
        continue;
      }

      try {
        const result = await api.runQuery(sessionId, scan.sql, database);
        if (cancelledRef.current) break;
        const hits = parseScanRow(scan.columns, result.rows[0] ?? []);
        if (hits.length > 0) {
          appendResult({ table, status: "hit", columns: scanColumns, hits });
        } else {
          appendResult({ table, status: "no-hit" });
        }
      } catch (e) {
        if (cancelledRef.current) break;
        appendResult({ table, status: "skipped", reason: "error", detail: String(e) });
      }
    }
    setProgress((p) => (p ? { ...p, index: targetTables.length, currentTable: null } : p));
    setScanning(false);
  };

  const handleReset = () => {
    setResults([]);
    setProgress(null);
  };

  const openColumnHit = (table: string, column: string, dataType: string) => {
    const sql = buildColumnJumpSql(driver, database, table, column, dataType, term.trim(), matchMode);
    if (!sql) return;
    onOpenHit(sql, `${table}.${column}`);
  };

  const openTableHits = (entry: HitEntry) => {
    const sql = buildTableJumpSql(
      driver,
      database,
      entry.table,
      entry.columns,
      entry.hits.map((h) => h.column),
      term.trim(),
      matchMode,
    );
    if (!sql) return;
    onOpenHit(sql, entry.table);
  };

  const hitEntries = results.filter((r): r is HitEntry => r.status === "hit");
  const skippedEntries = results.filter((r): r is SkippedEntry => r.status === "skipped");
  const noHitCount = results.filter((r) => r.status === "no-hit").length;
  const finished = !scanning && progress !== null;

  return (
    <Modal
      width="680px"
      onClose={onClose}
      closeOnInteractOutside={!scanning}
      closeOnEscape={!scanning}
    >
      <ModalHeader onClose={onClose} closeLabel={t("dataSearchClose")} closeDisabled={scanning}>
        {t("dataSearchTitle", { database })}
      </ModalHeader>

      <ModalBody display="flex" flexDirection="column" gap="4">
        <chakra.div fontSize="sm" color="app.textMuted" lineHeight={1.5}>
          {t("dataSearchNote")}
        </chakra.div>

        {meta.kind === "loading" && (
          <chakra.div display="flex" alignItems="center" gap="2" fontSize="sm" color="app.textSecondary">
            <Spinner size={14} />
            {t("dataSearchLoadingMeta")}
          </chakra.div>
        )}
        {meta.kind === "error" && <ErrorNote>{meta.message}</ErrorNote>}

        {meta.kind === "ready" && (
          <>
            <FormSection>
              <FieldLabel htmlFor="data-search-term">{t("dataSearchTermLabel")}</FieldLabel>
              <chakra.div display="flex" gap="2">
                <Input
                  id="data-search-term"
                  flex="1"
                  minW={0}
                  type="text"
                  value={term}
                  onChange={(e) => setTerm(e.target.value)}
                  placeholder={t("dataSearchTermPlaceholder")}
                  disabled={scanning}
                  autoComplete="off"
                  spellCheck={false}
                />
                <Select
                  minW="140px"
                  value={matchMode}
                  onChange={(e) => setMatchMode(e.target.value as MatchMode)}
                  disabled={scanning}
                  aria-label={t("dataSearchMatchModeLabel")}
                >
                  {MATCH_MODES.map((m) => (
                    <option key={m} value={m}>
                      {t(
                        m === "exact"
                          ? "dataSearchMatchExact"
                          : m === "prefix"
                            ? "dataSearchMatchPrefix"
                            : "dataSearchMatchContains",
                      )}
                    </option>
                  ))}
                </Select>
              </chakra.div>
            </FormSection>

            <FormSection>
              <FieldLabel as="div">{t("dataSearchScopeLabel")}</FieldLabel>
              <chakra.div role="radiogroup" aria-label={t("dataSearchScopeLabel")} display="flex" gap="4">
                {(["all", "selected"] as const).map((sc) => (
                  <chakra.label key={sc} display="inline-flex" alignItems="center" gap="1.5" cursor="pointer" userSelect="none">
                    <Radio
                      name="data-search-scope"
                      value={sc}
                      checked={scope === sc}
                      onChange={() => setScope(sc)}
                      disabled={scanning}
                      m={0}
                    />
                    <chakra.span fontSize="md">
                      {sc === "all" ? t("dataSearchScopeAll") : t("dataSearchScopeSelected")}
                    </chakra.span>
                  </chakra.label>
                ))}
              </chakra.div>
            </FormSection>

            {scope === "selected" && (
              <FormSection>
                <Input
                  type="text"
                  value={tableFilter}
                  onChange={(e) => setTableFilter(e.target.value)}
                  placeholder={t("dataSearchFilterPlaceholder")}
                  disabled={scanning}
                  mb="1.5"
                />
                <chakra.div
                  maxH="160px"
                  overflowY="auto"
                  border="1px solid"
                  borderColor="app.border"
                  borderRadius="md"
                  p="1.5"
                  display="flex"
                  flexDirection="column"
                >
                  {filteredTables.map((tb) => (
                    <chakra.label
                      key={tb}
                      display="flex"
                      alignItems="center"
                      gap="2"
                      py="0.5"
                      px="1"
                      borderRadius="sm"
                      cursor="pointer"
                      userSelect="none"
                      _hover={{ bg: "app.rowHover" }}
                    >
                      <Checkbox checked={selected.has(tb)} onChange={() => toggleTable(tb)} disabled={scanning} />
                      <chakra.span fontSize="sm" fontFamily="mono" minW={0} truncate>
                        {tb}
                      </chakra.span>
                    </chakra.label>
                  ))}
                  {filteredTables.length === 0 && (
                    // テーブル名フィルタで 0 件になったケース: 「検索一致なし」の
                    // 軽量アイコンを compact で使う (#847)。
                    <EmptyState compact icon="search" title={t("dataSearchNoFilterMatch")} />
                  )}
                </chakra.div>
                <chakra.div fontSize="xs" color="app.textMuted" mt="1">
                  {emptySelection
                    ? t("dataSearchNoSelection")
                    : t("dataSearchSelectedCount", { selected: selected.size, total: allTables.length })}
                </chakra.div>
              </FormSection>
            )}

            <FormSection>
              <FieldLabel htmlFor="data-search-threshold">{t("dataSearchThresholdLabel")}</FieldLabel>
              <Input
                id="data-search-threshold"
                type="number"
                min={0}
                step={1000}
                value={threshold}
                onChange={(e) => setThreshold(Math.max(0, Number(e.target.value) || 0))}
                disabled={scanning}
                maxW="160px"
              />
              <chakra.span fontSize="xs" color="app.textMuted">
                {t("dataSearchThresholdHint")}
              </chakra.span>
            </FormSection>

            {!scanning && !finished && targetTables.length > 0 && (
              <chakra.div fontSize="sm" color="app.textSecondary">
                {t("dataSearchSummary", {
                  count: targetTables.length,
                  rows: targetEstimateTotal.hasUnknown
                    ? t("dataSearchEstimateUnknownRows", { rows: targetEstimateTotal.sum })
                    : t("dataSearchEstimateRows", { rows: targetEstimateTotal.sum }),
                })}
              </chakra.div>
            )}

            {(scanning || finished) && progress && (
              <chakra.div display="flex" alignItems="center" gap="2" fontSize="sm">
                {scanning && <Spinner size={14} />}
                <chakra.span fontWeight={500} color="app.text">
                  {scanning
                    ? t("dataSearchProgress", {
                        index: progress.index + 1,
                        total: progress.total,
                        table: progress.currentTable ?? "",
                      })
                    : t("dataSearchDone", {
                        hits: hitEntries.length,
                        noHits: noHitCount,
                        skipped: skippedEntries.length,
                      })}
                </chakra.span>
              </chakra.div>
            )}

            {finished && hitEntries.length === 0 && (
              // 全走査テーブルを終えて 1 件もヒットしなかったケース:
              // 「検索一致なし」の軽量アイコンを compact で使う (#847)。
              <EmptyState compact icon="search" title={t("dataSearchNoHits")} />
            )}

            {hitEntries.length > 0 && (
              <FormSection>
                <FieldLabel as="div">{t("dataSearchHitsHeading")}</FieldLabel>
                <chakra.div display="flex" flexDirection="column" gap="2">
                  {hitEntries.map((entry) => (
                    <chakra.div
                      key={entry.table}
                      border="1px solid"
                      borderColor="app.border"
                      borderRadius="md"
                      p="2"
                      display="flex"
                      flexDirection="column"
                      gap="1"
                    >
                      <chakra.div display="flex" alignItems="center" justifyContent="space-between" gap="2">
                        <chakra.span textStyle="subheading" fontFamily="mono">
                          {entry.table}
                        </chakra.span>
                        <Button type="button" variant="ghost" onClick={() => openTableHits(entry)}>
                          {t("dataSearchOpenTable")}
                        </Button>
                      </chakra.div>
                      {entry.hits.map((h) => {
                        const col = entry.columns.find((c) => c.name === h.column);
                        return (
                          <chakra.button
                            key={h.column}
                            type="button"
                            onClick={() => col && openColumnHit(entry.table, h.column, col.dataType)}
                            display="flex"
                            alignItems="center"
                            gap="2"
                            w="100%"
                            textAlign="left"
                            px="2"
                            py="1"
                            border="none"
                            borderRadius="sm"
                            cursor="pointer"
                            bg="transparent"
                            color="app.text"
                            _hover={{ bg: "app.rowHover" }}
                          >
                            <Icon name="columns" size={ICON_SIZES.sm} />
                            <chakra.span fontSize="sm" fontFamily="mono" flex="1" minW={0} truncate>
                              {h.column}
                            </chakra.span>
                            <chakra.span fontSize="xs" color="app.textMuted" flexShrink={0}>
                              {t("dataSearchHitCount", { count: h.count })}
                            </chakra.span>
                          </chakra.button>
                        );
                      })}
                    </chakra.div>
                  ))}
                </chakra.div>
              </FormSection>
            )}

            {skippedEntries.length > 0 && (
              <FormSection>
                <FieldLabel as="div">{t("dataSearchSkippedHeading")}</FieldLabel>
                <chakra.div
                  maxH="120px"
                  overflowY="auto"
                  border="1px solid"
                  borderColor="app.border"
                  borderRadius="md"
                  p="1.5"
                  display="flex"
                  flexDirection="column"
                  gap="0.5"
                >
                  {skippedEntries.map((entry) => (
                    <chakra.div key={entry.table} display="flex" gap="2" fontSize="xs" color="app.textMuted">
                      <chakra.span fontFamily="mono" fontWeight={600} flexShrink={0}>
                        {entry.table}
                      </chakra.span>
                      <chakra.span minW={0} truncate>
                        {entry.reason === "row-threshold" && t("dataSearchSkipReasonThreshold")}
                        {entry.reason === "no-searchable-columns" && t("dataSearchSkipReasonNoColumns")}
                        {entry.reason === "error" && t("dataSearchSkipReasonError", { error: entry.detail ?? "" })}
                      </chakra.span>
                    </chakra.div>
                  ))}
                </chakra.div>
              </FormSection>
            )}
          </>
        )}
      </ModalBody>

      <ModalFooter>
        <div style={{ flex: 1 }} />
        {scanning ? (
          <Button type="button" variant="secondary" onClick={handleCancel}>
            {t("dataSearchCancel")}
          </Button>
        ) : (
          <>
            {finished && (
              <Button type="button" variant="secondary" onClick={handleReset}>
                {t("dataSearchNewSearch")}
              </Button>
            )}
            <Button type="button" variant="secondary" onClick={onClose}>
              {t("dataSearchClose")}
            </Button>
          </>
        )}
        {!finished && (
          <LoadingButton
            pressable
            type="button"
            variant="primary"
            loading={scanning}
            onClick={handleStart}
            disabled={scanning || !canStart}
          >
            {scanning ? t("dataSearchRunning") : t("dataSearchStart")}
          </LoadingButton>
        )}
      </ModalFooter>
      {confirmDialog}
    </Modal>
  );
}
