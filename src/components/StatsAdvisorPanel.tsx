import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, chakra, Flex } from "@chakra-ui/react";

import { api, type QueryResult } from "../api/tauri";
import { useT, type I18nKey } from "../i18n";
import type { PlanNode } from "./explainPlan";
import { Callout } from "./Callout";
import { ListboxSelect } from "./ListboxSelect";
import { FieldError } from "./modalForm";
import { Spinner } from "./Spinner";
import { SqlPreview } from "./SqlPreview";
import { Tooltip } from "./Tooltip";
import { Button, Checkbox, Input } from "./ui";
import {
  analyzeStatements,
  columnsSql,
  createStatisticsStatements,
  dropHistogramStatements,
  dropStatisticsStatements,
  freshnessSql,
  histogramStatements,
  HISTOGRAM_BUCKETS_DEFAULT,
  parseExtendedStatistics,
  parseFreshness,
  parseHistograms,
  parseServerVersion,
  pgRelationNameFromSql,
  pickFilterColumns,
  planConditionIdentifiers,
  planStatsTables,
  relationSchemaSql,
  serverVersionSql,
  setStatisticsTargetStatements,
  sqliteOptimizeStatements,
  STATS_BLOCK_REASON_KEYS,
  statsObjectsSql,
  supportsHistogram,
  supportsMcvStatistics,
  type ColumnHistogram,
  type ExtendedStatKind,
  type ExtendedStatistic,
  type ServerVersion,
  type StatsBlockReason,
  type StatsBuild,
  type StatsFreshness,
  type StatsTable,
} from "./statsAdvisor";

/** 実行計画の画面から統計の手当てを流すための接続情報と経路。 */
export interface StatsAdvisorConfig {
  sessionId: string;
  database: string | null;
  /** EXPLAIN した元の SQL。PostgreSQL でテーブルのスキーマを解決するのに使う (修飾名を探す)。 */
  sql: string | null;
  /** read_only 接続 (バックエンドが書き込みを拒否する。ボタンも無効にする)。 */
  readOnly: boolean;
  /** 確認 (confirm_writes / is_production) を通してから流す。キャンセル / 失敗は false。 */
  runStatements: (statements: string[]) => Promise<StatsRunOutcome>;
  /** 同じ SQL でもう一度 EXPLAIN する (結果は親の result に流れてくる)。実際に始めたら true。 */
  onReexplain: () => boolean;
}

/** 流した結果。cancelled は確認でやめた (何も流していない)、failed は途中で失敗した。 */
export type StatsRunOutcome = "done" | "failed" | "cancelled";

type Draft = { id: string; statements: string[] };

const LOOKUP_ROW_CAP = 500;
const LOOKUP_TIMEOUT_SECS = 5;

interface Loaded {
  /** 実際に操作するテーブル。PostgreSQL はスキーマ解決済み。解決できなければ null (打ち手を塞ぐ)。 */
  table: StatsTable | null;
  version: ServerVersion | null;
  columns: string[];
  freshness: StatsFreshness | null;
  freshnessError: string | null;
  extended: ExtendedStatistic[];
  histograms: ColumnHistogram[];
}

async function lookup(config: StatsAdvisorConfig, sql: string): Promise<QueryResult> {
  return api.runLookupQuery({
    sessionId: config.sessionId,
    sql,
    database: config.database,
    rowCap: LOOKUP_ROW_CAP,
    queryTimeoutSecs: LOOKUP_TIMEOUT_SECS,
  });
}

async function settle(config: StatsAdvisorConfig, sql: string | null): Promise<QueryResult | null> {
  if (!sql) return null;
  try {
    return await lookup(config, sql);
  } catch {
    return null;
  }
}

async function loadStats(driver: string, config: StatsAdvisorConfig, planTable: StatsTable): Promise<Loaded> {
  let table: StatsTable = planTable;
  if (driver === "postgres" && !table.schema) {
    // 計画 (VERBOSE なし) にスキーマが無い。タブのスキーマで代用せず、実際の relation のスキーマを確かめる。
    const res = await settle(config, relationSchemaSql(pgRelationNameFromSql(config.sql, table.table)));
    const ns = res?.rows[0]?.[0];
    if (ns === null || ns === undefined || ns === "") {
      return {
        table: null,
        version: null,
        columns: [],
        freshness: null,
        freshnessError: null,
        extended: [],
        histograms: [],
      };
    }
    table = { schema: String(ns), table: table.table };
  }
  const verRes = await settle(config, serverVersionSql(driver));
  const version = parseServerVersion(driver, verRes ? String(verRes.rows[0]?.[0] ?? "") : null);
  const colRes = await settle(config, columnsSql(driver, table, config.database));
  const columns = (colRes?.rows ?? []).map((r) => String(r[0]));
  let freshness: StatsFreshness | null = null;
  let freshnessError: string | null = null;
  try {
    const sqls = freshnessSql(driver, table, config.database);
    const results: (QueryResult | null)[] = [];
    for (const sql of sqls) {
      try {
        results.push(await lookup(config, sql));
      } catch (e) {
        // SQLite の sqlite_stat1 が無い場合は失敗が普通なので、最初のクエリだけエラーとして扱う。
        if (results.length === 0) throw e;
        results.push(null);
      }
    }
    freshness = parseFreshness(driver, results);
  } catch (e) {
    freshnessError = String(e);
  }
  const objSql = statsObjectsSql(driver, table, config.database);
  const objRes = await settle(config, objSql);
  return {
    table,
    version,
    columns,
    freshness,
    freshnessError,
    extended: driver === "postgres" ? parseExtendedStatistics(objRes) : [],
    histograms: driver === "mysql" ? parseHistograms(objRes) : [],
  };
}

const KINDS: ExtendedStatKind[] = ["dependencies", "ndistinct", "mcv"];

export function StatsAdvisorPanel({
  node,
  driver,
  config,
  onBeforeRun,
  onReexplainCompare,
}: {
  node: PlanNode;
  driver: string;
  config: StatsAdvisorConfig;
  /** 変更の前に呼ぶ (計画を自動で固定する)。 */
  onBeforeRun: () => void;
  /** 再 EXPLAIN して固定した計画と比較する。 */
  onReexplainCompare: () => void;
}) {
  const t = useT();
  const tables = useMemo(() => planStatsTables(node, driver), [node, driver]);
  const candidates = useMemo(() => planConditionIdentifiers(node, driver), [node, driver]);
  const [tableIdx, setTableIdx] = useState(0);
  const table: StatsTable | null = tables[tableIdx] ?? tables[0] ?? null;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const [picked, setPicked] = useState<string[]>([]);
  const [kinds, setKinds] = useState<ExtendedStatKind[]>(["dependencies", "ndistinct"]);
  const [buckets, setBuckets] = useState(String(HISTOGRAM_BUCKETS_DEFAULT));
  const [targetCol, setTargetCol] = useState("");
  const [target, setTarget] = useState("1000");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [blockedKey, setBlockedKey] = useState<I18nKey | null>(null);

  // 別のノード / テーブルを選んだら作り直す。
  // biome-ignore lint/correctness/useExhaustiveDependencies: node 変更時に選択を初期化するトリガー
  useEffect(() => {
    setTableIdx(0);
    setDraft(null);
    setDone(false);
    setBlockedKey(null);
  }, [node]);

  const tableKey = table ? `${table.schema ?? ""}.${table.table}` : "";
  // 別のテーブルに替わったら、統計目標の列は前のテーブルのものを引きずらない。
  // biome-ignore lint/correctness/useExhaustiveDependencies: tableKey の変化だけを契機にする
  useEffect(() => {
    setTargetCol("");
  }, [tableKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tableKey は table の同一性、tick は再取得のトリガー
  useEffect(() => {
    if (!table) return;
    let cancelled = false;
    setLoading(true);
    setLoaded(null);
    void loadStats(driver, config, table).then((res) => {
      if (cancelled) return;
      setLoaded(res);
      setPicked(pickFilterColumns(candidates, res.columns));
      setTargetCol((prev) => prev || res.columns[0] || "");
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [driver, config.sessionId, config.database, tableKey, tick, candidates]);

  const propose = useCallback((id: string, build: StatsBuild) => {
    setDone(false);
    if (!build.ok) {
      setDraft(null);
      setBlockedKey(blockedKeyOf(build.reason));
      return;
    }
    setBlockedKey(null);
    setDraft({ id, statements: build.statements });
  }, []);

  if (!table) return null;
  const version = loaded?.version ?? null;
  const columns = loaded?.columns ?? [];
  const orderedColumns = [...picked, ...columns.filter((c) => !picked.includes(c))];
  // 操作対象は解決済みのテーブル。PostgreSQL は未解決 (読み取り前 / 解決失敗) のあいだ SQL を作れない。
  const opTable = loaded?.table ?? table;
  const base = { driver, table: opTable, database: config.database };
  const togglePick = (c: string) => setPicked((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]));
  const writeDisabledReason = config.readOnly ? t("statsAdvReadOnly") : null;
  // 列一覧が取れない = 表を特定できない (計画に出ているのが別名など)。存在しない表に対する SQL は流さない。
  const unresolvedReason =
    loaded && (loaded.table === null || loaded.columns.length === 0) ? t("statsAdvUnresolvedTable") : null;
  const histogramOk = supportsHistogram(driver, version);

  const run = async () => {
    if (!draft || running) return;
    setRunning(true);
    try {
      onBeforeRun();
      const outcome = await config.runStatements(draft.statements);
      if (outcome !== "cancelled") {
        // 失敗でも途中まで変わっていることがあるので、統計は読み直す。
        setTick((n) => n + 1);
        setDraft(null);
        setDone(outcome === "done");
      }
    } finally {
      setRunning(false);
    }
  };

  const actionButton = (
    id: string,
    label: string,
    build: () => StatsBuild,
    disabledReason?: string | null,
  ) => {
    const reason = writeDisabledReason ?? unresolvedReason ?? disabledReason ?? null;
    return (
      <Tooltip label={reason ?? undefined} focusableWrapper={!!reason}>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!!reason || running}
          onClick={() => propose(id, build())}
        >
          {label}
        </Button>
      </Tooltip>
    );
  };

  const f = loaded?.freshness ?? null;
  return (
    <Box css={panelCss} data-testid="stats-advisor">
      <chakra.div textStyle="overline">{t("statsAdvTitle")}</chakra.div>
      {tables.length > 1 && (
        <Flex gap="1.5" wrap="wrap" align="center">
          <chakra.span textStyle="caption">{t("statsAdvTable")}</chakra.span>
          {tables.map((tb, i) => (
            <Button
              key={`${tb.schema ?? ""}.${tb.table}`}
              type="button"
              size="sm"
              variant={tb === table ? "primary" : "secondary"}
              onClick={() => {
                setTableIdx(i);
                setDraft(null);
                setDone(false);
              }}
            >
              {tb.table}
            </Button>
          ))}
        </Flex>
      )}
      {tables.length === 1 && (
        <chakra.div textStyle="caption">
          {t("statsAdvTable")}: <chakra.strong>{table.table}</chakra.strong>
        </chakra.div>
      )}

      {loading && (
        <Flex align="center" gap="2" role="status" textStyle="caption">
          <Spinner size={14} />
          {t("statsAdvLoading")}
        </Flex>
      )}
      {loaded?.freshnessError && (
        <FieldError tone="warning">{t("statsAdvReadFailed", { error: loaded.freshnessError })}</FieldError>
      )}
      {f && (
        <chakra.dl css={freshCss}>
          {driver !== "sqlite" && (
            <>
              <dt>{driver === "postgres" ? t("statsAdvLastAnalyze") : t("statsAdvLastUpdate")}</dt>
              <dd>{f.lastAnalyze ?? t("statsAdvNever")}</dd>
            </>
          )}
          {driver === "postgres" && (
            <>
              <dt>{t("statsAdvLastAutoAnalyze")}</dt>
              <dd>{f.lastAutoAnalyze ?? t("statsAdvNever")}</dd>
              <dt>{t("statsAdvModsSince")}</dt>
              <dd>{f.modsSinceAnalyze ?? "—"}</dd>
            </>
          )}
          {f.sqlite && (
            <>
              <dt>sqlite_stat1</dt>
              <dd>{f.sqlite.hasStat1 ? t("statsAdvPresent") : t("statsAdvAbsent")}</dd>
              <dt>sqlite_stat4</dt>
              <dd>{f.sqlite.hasStat4 ? t("statsAdvPresent") : t("statsAdvAbsent")}</dd>
              {f.sqlite.entries.map((e, i) => (
                <chakra.div key={i} display="contents">
                  <dt>{e.index ?? t("statsAdvTableRow")}</dt>
                  <dd>{e.stat}</dd>
                </chakra.div>
              ))}
            </>
          )}
        </chakra.dl>
      )}
      {f && !f.found && !f.sqlite && <chakra.div textStyle="caption">{t("statsAdvNotFound")}</chakra.div>}

      {unresolvedReason && <FieldError tone="warning">{unresolvedReason}</FieldError>}

      <Flex gap="1.5" wrap="wrap">
        {actionButton("analyze", t("statsAdvActAnalyze"), () =>
          analyzeStatements(driver, opTable, config.database),
        )}
        {driver === "postgres" &&
          actionButton(
            "analyzeCols",
            t("statsAdvActAnalyzeCols"),
            () => analyzeStatements(driver, opTable, config.database, picked),
            picked.length === 0 ? t("statsAdvBlockedNoColumns") : null,
          )}
        {driver === "sqlite" &&
          actionButton("optimize", t("statsAdvActOptimize"), () => sqliteOptimizeStatements(driver))}
      </Flex>

      {(driver === "postgres" || driver === "mysql") && columns.length > 0 && (
        <Box>
          <chakra.div textStyle="caption">{t("statsAdvColumns")}</chakra.div>
          <Box css={columnListCss}>
            {orderedColumns.map((c) => (
              <chakra.label key={c} display="flex" alignItems="center" gap="2" fontSize="sm" cursor="pointer">
                <Checkbox checked={picked.includes(c)} onChange={() => togglePick(c)} />
                <chakra.span>{c}</chakra.span>
              </chakra.label>
            ))}
          </Box>
        </Box>
      )}

      {driver === "postgres" && (
        <>
          <Flex gap="1.5" wrap="wrap" align="center">
            {KINDS.map((k) => (
              <chakra.label
                key={k}
                display="flex"
                alignItems="center"
                gap="1.5"
                fontSize="sm"
                cursor="pointer"
              >
                <Checkbox
                  checked={kinds.includes(k)}
                  disabled={k === "mcv" && !supportsMcvStatistics(driver, version)}
                  onChange={() => setKinds((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]))}
                />
                {k}
              </chakra.label>
            ))}
            {actionButton("createStats", t("statsAdvActCreateStats"), () =>
              createStatisticsStatements({
                ...base,
                columns: picked,
                kinds,
                version,
                takenNames: new Set((loaded?.extended ?? []).map((e) => e.name)),
              }),
            )}
          </Flex>
          <Flex gap="1.5" wrap="wrap" align="center">
            <ListboxSelect
              value={targetCol}
              options={columns.map((c) => ({ value: c }))}
              onChange={setTargetCol}
              ariaLabel={t("statsAdvTargetColumn")}
            />
            <Input
              width="90px"
              inputMode="numeric"
              value={target}
              aria-label={t("statsAdvTarget")}
              onChange={(e) => setTarget(e.target.value)}
            />
            {actionButton("setTarget", t("statsAdvActSetTarget"), () =>
              setStatisticsTargetStatements({ ...base, column: targetCol, target: Number(target) }),
            )}
          </Flex>
        </>
      )}

      {driver === "mysql" && (
        <Flex gap="1.5" wrap="wrap" align="center">
          <Input
            width="90px"
            inputMode="numeric"
            value={buckets}
            aria-label={t("statsAdvBuckets")}
            onChange={(e) => setBuckets(e.target.value)}
          />
          {actionButton(
            "histogram",
            t("statsAdvActHistogram"),
            () => histogramStatements({ ...base, columns: picked, buckets: Number(buckets), version }),
            histogramOk ? null : t("statsAdvBlockedVersion"),
          )}
        </Flex>
      )}

      {blockedKey && <FieldError>{t(blockedKey)}</FieldError>}

      {driver === "postgres" && loaded && (
        <ExistingList title={t("statsAdvExistingExtended")} empty={t("statsAdvNoneExisting")}>
          {loaded.extended.map((e) => (
            <ExistingRow
              key={`${e.schema}.${e.name}`}
              label={`${e.schema}.${e.name}`}
              detail={e.definition}
              dropLabel={t("statsAdvDrop")}
              dropDisabled={writeDisabledReason}
              onDrop={() => propose(`drop:${e.name}`, dropStatisticsStatements(driver, e.schema, e.name))}
            />
          ))}
        </ExistingList>
      )}
      {driver === "mysql" && loaded && histogramOk && (
        <ExistingList title={t("statsAdvExistingHistograms")} empty={t("statsAdvNoneExisting")}>
          {loaded.histograms.map((h) => (
            <ExistingRow
              key={h.column}
              label={h.column}
              detail={[h.type, h.buckets !== null ? `${h.buckets} buckets` : null, h.lastUpdated]
                .filter(Boolean)
                .join(" / ")}
              dropLabel={t("statsAdvDrop")}
              dropDisabled={writeDisabledReason}
              onDrop={() =>
                propose(
                  `dropHist:${h.column}`,
                  dropHistogramStatements({ ...base, columns: [h.column], version }),
                )
              }
            />
          ))}
        </ExistingList>
      )}

      {draft && (
        <Box css={previewCss}>
          <chakra.div textStyle="caption">{t("statsAdvPreviewTitle")}</chakra.div>
          <SqlPreview sql={draft.statements.join("\n")} driver={driver} wrap maxH="30vh" />
          <Flex gap="2" justify="flex-end">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={running}
              onClick={() => setDraft(null)}
            >
              {t("statsAdvCancel")}
            </Button>
            <Button type="button" size="sm" variant="primary" disabled={running} onClick={() => void run()}>
              {t("statsAdvRun")}
            </Button>
          </Flex>
        </Box>
      )}

      {done && (
        <Callout
          tone="success"
          role="status"
          action={
            <Button type="button" size="sm" variant="primary" onClick={onReexplainCompare}>
              {t("statsAdvReexplain")}
            </Button>
          }
        >
          {t("statsAdvDone")}
        </Callout>
      )}
    </Box>
  );
}

function blockedKeyOf(reason: StatsBlockReason): I18nKey {
  return STATS_BLOCK_REASON_KEYS[reason];
}

function ExistingList({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: React.ReactNode[];
}) {
  return (
    <Box>
      <chakra.div textStyle="caption">{title}</chakra.div>
      {children.length === 0 ? <chakra.div textStyle="caption">{empty}</chakra.div> : children}
    </Box>
  );
}

function ExistingRow({
  label,
  detail,
  dropLabel,
  dropDisabled,
  onDrop,
}: {
  label: string;
  detail: string;
  dropLabel: string;
  dropDisabled: string | null;
  onDrop: () => void;
}) {
  return (
    <Flex align="center" gap="2" py="1">
      <Box flex="1" minW="0">
        <chakra.div fontSize="sm">{label}</chakra.div>
        <chakra.div textStyle="caption" wordBreak="break-all">
          {detail}
        </chakra.div>
      </Box>
      <Tooltip label={dropDisabled ?? undefined} focusableWrapper={!!dropDisabled}>
        <Button type="button" size="sm" variant="dangerOutline" disabled={!!dropDisabled} onClick={onDrop}>
          {dropLabel}
        </Button>
      </Tooltip>
    </Flex>
  );
}

const panelCss = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  marginTop: "var(--space-3)",
  paddingTop: "var(--space-3)",
  borderTop: "1px solid var(--border)",
} as const;

const freshCss = {
  display: "grid",
  gridTemplateColumns: "max-content 1fr",
  columnGap: "var(--space-3)",
  rowGap: "var(--space-0-5)",
  margin: 0,
  fontSize: "var(--text-sm)",
  "& dt": { color: "var(--text-muted)" },
  "& dd": { margin: 0, wordBreak: "break-all" },
} as const;

const columnListCss = {
  maxHeight: "calc(10 * var(--space-4))",
  overflow: "auto",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  padding: "var(--space-1-5)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-md)",
} as const;

const previewCss = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
} as const;
