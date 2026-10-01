import { useEffect, useMemo, useRef, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { motion, useReducedMotion } from "motion/react";
import {
  api,
  listenDataSearchStream,
  type DataSearchEntry,
  type ScanColumn,
} from "../api/tauri";
import { useT } from "../i18n";
import {
  buildColumnJumpSql,
  buildTableJumpSql,
  DEFAULT_SCAN_ROW_THRESHOLD,
  type MatchMode,
} from "./dataSearch";
import { useConfirm } from "./ConfirmDialog";
import { EmptyState } from "./EmptyState";
import { ErrorNote, FieldLabel, FormSection } from "./modalForm";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, Checkbox, Input, Radio, Select } from "./ui";
import { LoadingButton } from "./LoadingButton";
import { Icon, ICON_SIZES } from "./Icon";
import { SkeletonSearchRows } from "./Skeleton";
import { shouldStaggerEntrance } from "./commandPaletteSearch";
import { staggerContainer, variants } from "../motion";

/**
 * DB 全体からの値検索 (#748)。「この値はどのテーブル・どの列にあるか」を、対象
 * データベースのテーブルを順に走査して調べる横断検索モーダル。
 *
 * 走査は Rust の `data_search_stream` (#1261) が行う。列メタデータの一括取得・テーブルごとの
 * 走査 SQL (`SUM(CASE...)`) の生成・行数しきい値によるスキップ判定・同時実行数を絞った並列発行
 * をバックエンドが担い、進捗とテーブルごとの結果 (指定順) を Tauri Channel で逐次返す。
 * `planWatch` と同じ理由 (履歴を汚さない) で `run_query_stream` は使わない。生成される SQL は
 * すべて `SELECT` で読み取り専用ガードを通るので、読み取り専用セッションでも完全に動作する。
 * キャンセルは `cancel_stream` で、走査中のテーブルごと中断できる。ここは入力・確認ダイアログ・
 * 結果の描画と、ヒット行クリック時のジャンプ SQL (`dataSearch.ts`) だけを担う。
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

// CommandPalette と同じ stagger 語彙 (#1212)。
const MotionHitList = chakra(motion.div, {}, { forwardProps: ["variants", "initial", "animate"] });
const MotionHitCard = chakra(motion.div, {}, { forwardProps: ["variants"] });

const MATCH_MODES: MatchMode[] = ["contains", "prefix", "exact"];

let dataSearchStreamSeq = 0;
/** 走査 1 回ごとの一意な stream id (進捗・結果の宛先とキャンセルの宛先)。 */
function makeDataSearchStreamId(): string {
  dataSearchStreamSeq += 1;
  return `datasearch_${Date.now().toString(36)}_${dataSearchStreamSeq.toString(36)}`;
}

/** バックエンドの結果 1 件を画面の状態へ写す。 */
function toResultEntry(entry: DataSearchEntry): ResultEntry {
  switch (entry.status) {
    case "hit":
      return { table: entry.table, status: "hit", columns: entry.columns, hits: entry.hits };
    case "no-hit":
      return { table: entry.table, status: "no-hit" };
    case "skipped":
      return { table: entry.table, status: "skipped", reason: entry.reason, detail: entry.detail };
  }
}

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
  const reduced = useReducedMotion() ?? false;
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
  const [scanError, setScanError] = useState<string | null>(null);
  /** 走査中のストリーム。キャンセル・アンマウントで止める。 */
  const activeRef = useRef<{ streamId: string; unlisten: () => void } | null>(null);

  // 対象データベースのテーブル一覧 + 概算行数を先読みする (SchemaExportModal と
  // 同じ取得パターン)。列メタデータはスキャン実行時にバックエンドが取得する。
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

  // モーダルのアンマウント (切断・クローズ) 時に走査を止める。
  useEffect(
    () => () => {
      const active = activeRef.current;
      if (!active) return;
      activeRef.current = null;
      active.unlisten();
      void api.cancelStream(active.streamId).catch(() => {});
    },
    [],
  );

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

  /** 走査を終えた状態にする (進捗を完了表示にして購読を外す)。 */
  const finishScan = (slot: { streamId: string; unlisten: () => void }) => {
    if (activeRef.current !== slot) return;
    activeRef.current = null;
    slot.unlisten();
    setProgress((p) => (p ? { ...p, index: p.total, currentTable: null } : p));
    setScanning(false);
  };

  const handleCancel = () => {
    const active = activeRef.current;
    if (!active) return;
    void api.cancelStream(active.streamId).catch(() => {});
    finishScan(active);
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

    const streamId = makeDataSearchStreamId();
    const slot = { streamId, unlisten: () => {} };
    activeRef.current = slot;
    const isActive = () => activeRef.current === slot;
    setResults([]);
    setScanError(null);
    setProgress({ index: 0, total: targetTables.length, currentTable: null });
    setScanning(true);

    try {
      slot.unlisten = await listenDataSearchStream(streamId, {
        onProgress: ({ index, total, table }) => {
          if (isActive()) setProgress({ index, total, currentTable: table });
        },
        onTable: ({ entry }) => {
          if (isActive()) appendResult(toResultEntry(entry));
        },
        onDone: () => finishScan(slot),
        onCancelled: () => finishScan(slot),
        onError: ({ error }) => {
          if (!isActive()) return;
          setScanError(error);
          finishScan(slot);
        },
      });
      if (!isActive()) {
        // listen の完了を待つ間にキャンセル / アンマウントされた。
        slot.unlisten();
        return;
      }
      await api.dataSearchStream({
        sessionId,
        streamId,
        request: {
          database,
          term: term.trim(),
          mode: matchMode,
          tables: targetTables,
          rowThreshold: threshold,
        },
      });
    } catch (e) {
      if (!isActive()) return;
      setScanError(String(e));
      finishScan(slot);
    }
  };

  const handleReset = () => {
    setScanError(null);
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
      onSubmit={handleStart}
      submitDisabled={scanning || finished || !canStart}
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
          <chakra.div display="flex" flexDirection="column" gap="2" aria-busy>
            <chakra.div fontSize="sm" color="app.textSecondary">
              {t("dataSearchLoadingMeta")}
            </chakra.div>
            <SkeletonSearchRows rows={3} />
          </chakra.div>
        )}
        {meta.kind === "error" && <ErrorNote>{meta.message}</ErrorNote>}
        {scanError && <ErrorNote>{scanError}</ErrorNote>}

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

            {(hitEntries.length > 0 || scanning) && (
              <FormSection>
                <FieldLabel as="div">{t("dataSearchHitsHeading")}</FieldLabel>
                <MotionHitList
                  display="flex"
                  flexDirection="column"
                  gap="2"
                  aria-busy={scanning}
                  variants={staggerContainer(reduced)}
                  initial="initial"
                  animate="animate"
                >
                  {hitEntries.map((entry, entryIndex) => (
                    <MotionHitCard
                      key={entry.table}
                      variants={shouldStaggerEntrance(entryIndex) ? variants.staggerItem : undefined}
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
                    </MotionHitCard>
                  ))}
                  {/* スキャン中は結果行の形を模した skeleton を末尾に出す (#1212)。 */}
                  {scanning && <SkeletonSearchRows rows={hitEntries.length === 0 ? 3 : 1} />}
                </MotionHitList>
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
        {!scanning && finished && (
          <Button type="button" variant="secondary" onClick={handleReset}>
            {t("dataSearchNewSearch")}
          </Button>
        )}
        <div style={{ flex: 1 }} />
        {scanning ? (
          <Button type="button" variant="secondary" onClick={handleCancel}>
            {t("dataSearchCancel")}
          </Button>
        ) : (
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("dataSearchClose")}
          </Button>
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
