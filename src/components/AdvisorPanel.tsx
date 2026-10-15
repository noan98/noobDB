import { useCallback, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Box, chakra, Flex, type SystemStyleObject } from "@chakra-ui/react";
import { motion } from "motion/react";

import { api, type HealthFinding, type SchemaHealthReport } from "../api/tauri";
import { useT } from "../i18n";
import { useAiAvailable } from "../ai/useAiAvailable";
import { semanticColorToken } from "../semanticColors";
import {
  DEFAULT_ADVISOR_SORT,
  findingDescription,
  findingSizeText,
  findingsToTable,
  findingTarget,
  newFindingSet,
  nextAdvisorSort,
  reasonTextKey,
  reclaimableSummary,
  ruleTitleKey,
  severityLabelKey,
  sortFindings,
  type AdvisorSort,
  type AdvisorSortKey,
} from "./advisor";
import { copyToClipboard } from "./clipboard";
import { AiAdvisorExplain } from "./AiAdvisorExplain";
import { SeverityBadge } from "./severityBadge";
import { Callout } from "./Callout";
import { formatBytes } from "./tableSize";
import { CodePreview } from "./modalForm";
import { EmptyState } from "./EmptyState";
import { errorIllustration } from "./illustrations";
import { Icon, ICON_SIZES } from "./Icon";
import { Spinner } from "./Spinner";
import { SkeletonTableRows } from "./Skeleton";
import { Tooltip } from "./Tooltip";
import { Button } from "./ui";
import { useToast } from "./Toast";
import { TextExportButton } from "./TextExportButton";
import { tableToCsv, tableToMarkdown } from "./tabularText";
import { transitions, variants } from "../motion";

/**
 * スキーマ健全性アドバイザ (#741): 決定的なルールベースで接続先スキーマを
 * 一覧診断する明示実行パネル。
 *
 * - **明示実行**: 「診断を実行」ボタンで `analyze_schema_health` を呼ぶ。すべて
 *   読み取りの introspection (テーブル/カラム/インデックス/FK メタデータ +
 *   未使用インデックス統計) で、read_only セッションでも動く。
 * - **表示**: ルール / 対象 / 重要度 / 説明 / 修正 DDL の一覧。重要度は semantic
 *   トークン (#664) で色分けする。統計依存の指摘 (未使用インデックス) には
 *   観測期間依存の注記を添える。
 * - **修正は生成 → エディタ挿入まで**。ワンクリック一括適用はしない (Diff/Sync の
 *   「生成と適用の分離」と同方針)。実行は既存安全網 (read_only 拒否・危険クエリ
 *   確認) を通る。
 * - **縮退の明示**: 前提を満たさずスキップしたルール (未使用インデックスなど) は
 *   理由コードを有効化手順つきの文言にして表示し、黙って 0 件にしない (#587)。
 *
 * - **AI 解説 (#1468)**: AI 有効 + キー設定済みのときだけ、各指摘に「AI に聞く」を出す。
 *   解説は行内に展開し、AI は説明を返すだけで SQL は実行しない (本体の「読み取りのみ・
 *   自動実行しない」は変えない)。
 *
 * ルール判定の純ロジックはバック `db::advisor` にあり、表示ロジック (ルール →
 * i18n キー/パラメータ) は `advisor.ts` に分離してテストする。
 */

const thCss: SystemStyleObject = {
  position: "sticky",
  top: 0,
  zIndex: 1,
  background: "var(--bg-muted)",
  borderBottom: "1px solid var(--border)",
  padding: "var(--space-1-5) var(--space-2-5)",
  textAlign: "left",
  textStyle: "overline",
  color: "var(--text-secondary)",
  whiteSpace: "nowrap",
};
// クリックで並び替えできるヘッダ。th 自体をフォーカス可能にする (TableStatisticsPanel と同じ作法)。
const sortableThCss: SystemStyleObject = {
  ...thCss,
  cursor: "pointer",
  userSelect: "none",
  _hover: { color: "var(--text)" },
  _focusVisible: { outline: "none", boxShadow: "inset var(--focus-ring)" },
};
const tdCss: SystemStyleObject = {
  borderBottom: "1px solid var(--border-subtle, var(--border))",
  padding: "var(--space-2) var(--space-2-5)",
  fontSize: "var(--text-sm)",
  color: "var(--text)",
  verticalAlign: "top",
};

// 結果の差し替えはフェードで出す (reduced-motion は MotionConfig が即時化する)。
const MotionReveal = chakra(
  motion.div,
  {},
  {
    forwardProps: ["initial", "animate", "transition"],
  },
);

export function AdvisorPanel({
  sessionId,
  database,
  isProduction = false,
  onInsertSql,
}: {
  sessionId: string;
  database: string;
  /** 本番接続か。AI への送信前に確認を挟む (UI レベルの誤送信防止)。 */
  isProduction?: boolean;
  onInsertSql: (sql: string) => void;
}) {
  const t = useT();
  const toast = useToast();
  // 「AI に聞く」は AI 有効 + API キー設定済みのときだけ出す (設定画面の保存 / 削除に即時追従)。
  const aiAvailable = useAiAvailable();

  const [report, setReport] = useState<SchemaHealthReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<AdvisorSort>(DEFAULT_ADVISOR_SORT);
  // 前回診断で無かった指摘 (参照の集合)。「対応しない」への移動で添字がずれないよう、取得時に参照へ直す。
  const [newFindings, setNewFindings] = useState<Set<HealthFinding>>(() => new Set());
  const [showIgnored, setShowIgnored] = useState(false);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const r = await api.analyzeSchemaHealth(sessionId, database);
      setReport(r);
      setNewFindings(newFindingSet(r.findings, r.diff));
    } catch (e) {
      // 失敗した再実行の下に前回の診断結果が残ると、古い指摘が現在の結果として
      // 表示・書き出し (CSV / Markdown) されてしまうので破棄する。
      setReport(null);
      setError(String(e));
    } finally {
      setRunning(false);
    }
  }, [sessionId, database]);

  // 「対応しない」(#1621): 保存してから、再診断せずに画面上で本表 ⇔ 別枠を移す。
  const moveFinding = useCallback(
    async (finding: HealthFinding, toIgnored: boolean) => {
      try {
        if (toIgnored) await api.ignoreAdvisorFinding(sessionId, database, finding);
        else await api.unignoreAdvisorFinding(sessionId, database, finding);
      } catch (e) {
        toast.error(t("advisorIgnoreError", { error: String(e) }));
        return;
      }
      setReport((cur) =>
        cur
          ? {
              ...cur,
              findings: toIgnored ? cur.findings.filter((f) => f !== finding) : [...cur.findings, finding],
              ignored: toIgnored ? [...cur.ignored, finding] : cur.ignored.filter((f) => f !== finding),
            }
          : cur,
      );
      if (toIgnored) setShowIgnored(true);
    },
    [sessionId, database, toast, t],
  );

  const insertFix = useCallback(
    (sql: string) => {
      onInsertSql(sql);
      toast.success(t("advisorInserted"));
    },
    [onInsertSql, toast, t],
  );

  const reclaimable = useMemo(() => (report ? reclaimableSummary(report.findings) : null), [report]);

  const findings = useMemo(() => {
    if (!report) return [];
    return sortFindings(report.findings, sort.key, sort.dir, (f, key) => {
      if (key === "rule") return t(ruleTitleKey(f.rule));
      const desc = findingDescription(f);
      return t(desc.key, desc.params);
    });
  }, [report, sort, t]);

  // 行の key は内容ベース (並べ替えで AiAdvisorExplain が作り直され、実行中の要求や結果が
  // 消えないようにする)。同一内容の重複だけ出現順の連番で区別する。
  const rowKeys = useMemo(() => {
    const seen = new Map<string, number>();
    return findings.map((f) => {
      const base = `${f.rule}|${f.table}|${f.columns.join(",")}|${f.context.join(",")}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return n === 0 ? base : `${base}#${n}`;
    });
  }, [findings]);

  // 各ソートヘッダ共通のプロパティ (クリック / Enter・Space / aria-sort)。
  // th はネイティブに columnheader ロールを持つので role は上書きしない。
  const headerProps = (key: AdvisorSortKey) => ({
    tabIndex: 0,
    "aria-sort": (sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : "none") as
      | "ascending"
      | "descending"
      | "none",
    onClick: () => setSort((cur) => nextAdvisorSort(cur, key)),
    onKeyDown: (e: ReactKeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setSort((cur) => nextAdvisorSort(cur, key));
      }
    },
  });
  const sortableTh = (key: AdvisorSortKey, label: string) => (
    <chakra.th css={sortableThCss} {...headerProps(key)}>
      <chakra.span display="inline-flex" alignItems="center" gap="1">
        {label}
        <chakra.span
          display="inline-flex"
          color={sort.key === key ? "app.accent" : "app.textMuted"}
          opacity={sort.key === key ? 1 : 0.5}
          aria-hidden
        >
          <Icon
            name={sort.key === key ? (sort.dir === "asc" ? "sort-asc" : "sort-desc") : "sort"}
            size={ICON_SIZES.sm}
          />
        </chakra.span>
      </chakra.span>
    </chakra.th>
  );

  // 診断結果の書き出し (#1539): 画面の並び順のまま、修正 DDL まで含めて CSV / Markdown にする。
  const buildExport = (kind: "csv" | "markdown") => {
    const table = findingsToTable(findings, {
      headers: {
        severity: t("advisorColSeverity"),
        rule: t("advisorColRule"),
        table: t("advisorExportColTable"),
        columns: t("advisorExportColColumns"),
        detail: t("advisorColDetail"),
        fixDdl: t("advisorExportColFixDdl"),
        fixDdlOnline: t("advisorExportColFixDdlOnline"),
        statistical: t("advisorExportColStatistical"),
        size: t("advisorExportColSize"),
      },
      severity: (s) => t(severityLabelKey(s)),
      rule: (f) => t(ruleTitleKey(f.rule)),
      detail: (f) => {
        const d = findingDescription(f);
        return t(d.key, d.params);
      },
    });
    return kind === "csv" ? tableToCsv(table.header, table.rows) : tableToMarkdown(table.header, table.rows);
  };

  const copyFix = useCallback(
    async (sql: string) => {
      const ok = await copyToClipboard(sql);
      if (ok) toast.success(t("advisorCopied"));
      else toast.error(t("advisorCopyFailed"));
    },
    [toast, t],
  );

  return (
    // 説明・実行ボタンは固定し、表だけをスクロールさせる。スクロール領域に上余白が
    // あると sticky ヘッダの上を行が透けて流れ、ヘッダが浮いて見えていた。
    <Box flex="1" minH={0} display="flex" flexDirection="column">
      <Box flexShrink={0} pt="3.5" pb="3" px="4" display="flex" flexDirection="column" gap="3">
        <chakra.p margin={0} fontSize="sm" color="app.textMuted">
          {t("advisorDesc")}
        </chakra.p>

        <Flex align="center" gap="3" flexWrap="wrap">
          <Button type="button" variant="primary" onClick={run} disabled={running}>
            <Icon name="refresh" size={ICON_SIZES.sm} />
            <chakra.span marginLeft="1.5">{report ? t("advisorRerun") : t("advisorRun")}</chakra.span>
          </Button>
          {report && !running && report.findings.length > 0 && (
            <TextExportButton
              filenameBase={`schema-health-${database}`}
              formats={[
                { id: "csv", label: "CSV", build: () => buildExport("csv") },
                { id: "markdown", label: "Markdown", build: () => buildExport("markdown") },
              ]}
            />
          )}
          {running && (
            <Flex align="center" gap="2">
              <Spinner size={14} />
              <chakra.span fontSize="sm" color="app.textMuted">
                {t("advisorRunning")}
              </chakra.span>
            </Flex>
          )}
          {report && !running && (
            <chakra.span fontSize="sm" color="app.textMuted">
              {report.findings.length === 0
                ? t("advisorNoFindings", { tables: String(report.tables_analyzed) })
                : t("advisorSummary", {
                    findings: String(report.findings.length),
                    tables: String(report.tables_analyzed),
                  })}
            </chakra.span>
          )}
        </Flex>
      </Box>

      <Box flex="1" minH={0} overflowY="auto" px="4" pb="3.5" display="flex" flexDirection="column" gap="3.5">
        {report && !running && report.diff && (
          // 前回診断との差分 (#1621): 修正 DDL を適用した後にどれだけ改善したかをその場で確認できる。
          <Callout
            tone={
              report.diff.resolved.length > 0 || report.diff.new_indexes.length === 0 ? "success" : "warning"
            }
          >
            <chakra.div data-testid="advisor-diff-summary">
              {t("advisorDiffSummary", {
                time: new Date(report.diff.previous_at).toLocaleString(),
                added: String(report.diff.new_indexes.length),
                resolved: String(report.diff.resolved.length),
                unchanged: String(report.diff.unchanged),
              })}
            </chakra.div>
            {report.diff.resolved.length > 0 && (
              <chakra.ul
                margin={0}
                marginTop="1"
                paddingLeft="4"
                fontSize="sm"
                data-testid="advisor-diff-resolved"
              >
                {report.diff.resolved.map((f) => (
                  <li key={f.rule + findingTarget(f) + (f.context[0] ?? "")}>
                    {t("advisorDiffResolvedItem", {
                      rule: t(ruleTitleKey(f.rule)),
                      target: findingTarget(f),
                    })}
                  </li>
                ))}
              </chakra.ul>
            )}
          </Callout>
        )}

        {report && !running && reclaimable && (
          <Callout tone="info">
            <chakra.span data-testid="advisor-reclaimable">
              {t("advisorReclaimable", { size: formatBytes(reclaimable.bytes) })}
              {reclaimable.unknown > 0 &&
                ` ${t("advisorReclaimableUnknown", { count: String(reclaimable.unknown) })}`}
            </chakra.span>
          </Callout>
        )}

        {error && (
          // 診断失敗: errorHints の分類結果から共有イラストを割り当て、既存の
          // 実行/再実行ボタンと同じ導線を再取得アクションに配線する (#848)。
          <EmptyState
            illustration={errorIllustration(error)}
            icon="warning"
            title={t("advisorError", { error })}
            action={{ label: t("advisorRetry"), onClick: () => void run() }}
          />
        )}

        {report && !running && report.skipped.length > 0 && (
          <Box
            borderRadius="var(--radius-sm)"
            border="1px solid"
            borderColor={semanticColorToken("warning", "border")}
            bg={semanticColorToken("warning", "subtle")}
            color={semanticColorToken("warning", "text")}
            px="3"
            py="2.5"
          >
            <chakra.div textStyle="subheading" marginBottom="1">
              {t("advisorSkippedTitle")}
            </chakra.div>
            {report.skipped.map((s) => (
              <chakra.div key={`${s.rule}-${s.reason}`} fontSize="sm" lineHeight={1.5}>
                {t("advisorSkippedRule", {
                  rule: t(ruleTitleKey(s.rule)),
                  reason: t(reasonTextKey(s.reason)),
                })}
              </chakra.div>
            ))}
          </Box>
        )}

        {running && (
          // 実行中は結果 (findings 表) の形を模したシマーを出し、完了時の
          // レイアウトジャンプを抑える (#1211)。待機の告知は上の status が担う。
          <chakra.table width="100%" style={{ borderCollapse: "collapse" }} aria-hidden>
            <chakra.thead>
              <chakra.tr>
                <chakra.th css={thCss}>{t("advisorColSeverity")}</chakra.th>
                <chakra.th css={thCss}>{t("advisorColRule")}</chakra.th>
                <chakra.th css={thCss}>{t("advisorColTarget")}</chakra.th>
                <chakra.th css={thCss}>{t("advisorColDetail")}</chakra.th>
                <chakra.th css={thCss}>{t("advisorColSize")}</chakra.th>
              </chakra.tr>
            </chakra.thead>
            <chakra.tbody>
              <SkeletonTableRows columns={5} rows={5} />
            </chakra.tbody>
          </chakra.table>
        )}

        {report && !running && report.table_plans.length > 0 && (
          // テーブル単位のまとめ DDL (#1540)。2 件以上の機械的に直せる指摘があるテーブルだけ。
          <Box
            borderRadius="var(--radius-sm)"
            border="1px solid"
            borderColor="app.border"
            px="3"
            py="2.5"
            data-testid="advisor-table-plans"
          >
            <Flex align="center" gap="3" flexWrap="wrap">
              <chakra.div textStyle="subheading">{t("advisorPlansTitle")}</chakra.div>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() =>
                  insertFix(report.table_plans.map((p) => `-- ${p.table}\n${p.ddl}`).join("\n\n"))
                }
              >
                <Icon name="insert-sql" size={ICON_SIZES.sm} />
                <chakra.span marginLeft="1.5">{t("advisorPlansInsertAll")}</chakra.span>
              </Button>
            </Flex>
            <chakra.div fontSize="var(--text-xs)" color="app.textMuted" marginTop="1" lineHeight={1.5}>
              {t("advisorPlansNote")}
            </chakra.div>
            {report.table_plans.map((p) => (
              <Box key={p.table} marginTop="2.5">
                <chakra.div fontFamily="var(--font-mono)" fontWeight={600}>
                  {p.table}{" "}
                  <chakra.span textStyle="caption">
                    {t("advisorPlanChanges", { count: String(p.change_count) })}
                  </chakra.span>
                </chakra.div>
                <FixDdlBlock
                  ddl={p.ddl}
                  label={p.ddl_online ? t("advisorFixStandard") : null}
                  note={p.ddl_online ? t("advisorFixStandardNote") : null}
                  onInsert={insertFix}
                  onCopy={copyFix}
                />
                {p.ddl_online && (
                  <FixDdlBlock
                    ddl={p.ddl_online}
                    label={t("advisorFixOnline")}
                    note={
                      report.driver === "postgres"
                        ? t("advisorFixOnlineNotePostgres")
                        : t("advisorFixOnlineNoteMysql")
                    }
                    onInsert={insertFix}
                    onCopy={copyFix}
                  />
                )}
              </Box>
            ))}
          </Box>
        )}

        {report && !running && report.findings.length > 0 && (
          <MotionReveal
            initial={variants.fade.initial}
            animate={variants.fade.animate}
            transition={transitions.enter}
          >
            <chakra.table width="100%" style={{ borderCollapse: "collapse" }}>
              <chakra.thead>
                <chakra.tr>
                  {sortableTh("severity", t("advisorColSeverity"))}
                  {sortableTh("rule", t("advisorColRule"))}
                  {sortableTh("target", t("advisorColTarget"))}
                  {sortableTh("detail", t("advisorColDetail"))}
                  {sortableTh("size", t("advisorColSize"))}
                </chakra.tr>
              </chakra.thead>
              <chakra.tbody>
                {findings.map((f, i) => {
                  const desc = findingDescription(f);
                  return (
                    <chakra.tr key={rowKeys[i]}>
                      <chakra.td css={tdCss}>
                        <SeverityBadge severity={f.severity} />
                      </chakra.td>
                      <chakra.td css={tdCss} fontWeight={600} whiteSpace="nowrap">
                        {t(ruleTitleKey(f.rule))}
                        {newFindings.has(f) && (
                          <chakra.span
                            marginLeft="1.5"
                            px="1.5"
                            textStyle="overline"
                            borderRadius="var(--radius-sm)"
                            bg={semanticColorToken("info", "subtle")}
                            color={semanticColorToken("info", "text")}
                            border="1px solid"
                            borderColor={semanticColorToken("info", "border")}
                            data-testid="advisor-new-badge"
                          >
                            {t("advisorDiffNewBadge")}
                          </chakra.span>
                        )}
                      </chakra.td>
                      <chakra.td css={tdCss} fontFamily="var(--font-mono)">
                        {findingTarget(f)}
                      </chakra.td>
                      <chakra.td css={tdCss}>
                        <chakra.div lineHeight={1.5} color="app.textMuted">
                          {t(desc.key, desc.params)}
                        </chakra.div>
                        {f.statistical && (
                          <chakra.div
                            marginTop="1.5"
                            fontSize="var(--text-xs)"
                            color={semanticColorToken("warning", "text")}
                          >
                            {t("advisorStatisticalNote")}
                          </chakra.div>
                        )}
                        {f.fix_ddl && (
                          <FixDdlBlock
                            ddl={f.fix_ddl}
                            label={f.fix_ddl_online ? t("advisorFixStandard") : null}
                            note={f.fix_ddl_online ? t("advisorFixStandardNote") : null}
                            onInsert={insertFix}
                            onCopy={copyFix}
                          />
                        )}
                        {f.fix_ddl_online && (
                          <FixDdlBlock
                            ddl={f.fix_ddl_online}
                            label={t("advisorFixOnline")}
                            note={
                              report?.driver === "postgres"
                                ? t("advisorFixOnlineNotePostgres")
                                : t("advisorFixOnlineNoteMysql")
                            }
                            onInsert={insertFix}
                            onCopy={copyFix}
                          />
                        )}
                        <Flex gap="1" marginTop="1.5" align="center" flexWrap="wrap">
                          <Tooltip label={t("advisorIgnoreTooltip")}>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => void moveFinding(f, true)}
                            >
                              {t("advisorIgnore")}
                            </Button>
                          </Tooltip>
                        </Flex>
                        {aiAvailable && report && (
                          <AiAdvisorExplain
                            sessionId={sessionId}
                            driver={report.driver}
                            database={database}
                            finding={f}
                            isProduction={isProduction}
                          />
                        )}
                      </chakra.td>
                      <chakra.td css={tdCss} textStyle="numeric" whiteSpace="nowrap">
                        {findingSizeText(f)}
                      </chakra.td>
                    </chakra.tr>
                  );
                })}
              </chakra.tbody>
            </chakra.table>
          </MotionReveal>
        )}

        {report && !running && report.ignored.length > 0 && (
          // 「対応しない」にした指摘 (#1621): 本表には出さず、別枠に折りたたむ。
          <Box
            borderRadius="var(--radius-sm)"
            border="1px solid"
            borderColor="app.border"
            data-testid="advisor-ignored"
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-expanded={showIgnored}
              onClick={() => setShowIgnored((v) => !v)}
            >
              <Icon name={showIgnored ? "chevron-down" : "chevron-right"} size={ICON_SIZES.sm} />
              <chakra.span marginLeft="1.5">
                {t("advisorIgnoredTitle", { count: String(report.ignored.length) })}
              </chakra.span>
            </Button>
            {showIgnored && (
              <Box px="3" pb="2.5">
                <chakra.div
                  fontSize="var(--text-xs)"
                  color="app.textMuted"
                  marginBottom="1.5"
                  lineHeight={1.5}
                >
                  {t("advisorIgnoredNote")}
                </chakra.div>
                {report.ignored.map((f) => {
                  const desc = findingDescription(f);
                  return (
                    <Flex
                      key={f.rule + findingTarget(f) + (f.context[0] ?? "")}
                      align="center"
                      gap="3"
                      paddingY="1.5"
                      borderTop="1px solid"
                      borderColor="app.border"
                    >
                      <Box flex="1" minW={0}>
                        <chakra.div fontWeight={600} fontSize="sm">
                          {t(ruleTitleKey(f.rule))}{" "}
                          <chakra.span fontFamily="var(--font-mono)" fontWeight={400}>
                            {findingTarget(f)}
                          </chakra.span>
                        </chakra.div>
                        <chakra.div fontSize="var(--text-xs)" color="app.textMuted" lineHeight={1.5}>
                          {t(desc.key, desc.params)}
                        </chakra.div>
                      </Box>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => void moveFinding(f, false)}
                      >
                        {t("advisorUnignore")}
                      </Button>
                    </Flex>
                  );
                })}
              </Box>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
}

/** 修正 DDL 1 本ぶんの表示 (コードプレビュー + エディタへ挿入 / コピー)。通常版とオンライン版
 *  (#1534) を並べるときは `label` / `note` で違いを説明する。 */
function FixDdlBlock({
  ddl,
  label,
  note,
  onInsert,
  onCopy,
}: {
  ddl: string;
  label: string | null;
  note: string | null;
  onInsert: (ddl: string) => void;
  onCopy: (ddl: string) => void;
}) {
  const t = useT();
  return (
    <Box marginTop="2">
      {label && (
        <chakra.div fontSize="var(--text-xs)" fontWeight={600} color="app.text" marginBottom="1">
          {label}
        </chakra.div>
      )}
      <CodePreview wrap>{ddl}</CodePreview>
      {note && (
        <chakra.div fontSize="var(--text-xs)" color="app.textMuted" marginTop="1" lineHeight={1.5}>
          {note}
        </chakra.div>
      )}
      <Flex gap="1" marginTop="1.5">
        <Tooltip label={t("advisorInsertFix")}>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => onInsert(ddl)}
            aria-label={label ? `${t("advisorInsertFix")} (${label})` : t("advisorInsertFix")}
          >
            <Icon name="insert-sql" size={ICON_SIZES.sm} />
          </Button>
        </Tooltip>
        <Tooltip label={t("advisorCopyFix")}>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => onCopy(ddl)}
            aria-label={label ? `${t("advisorCopyFix")} (${label})` : t("advisorCopyFix")}
          >
            <Icon name="copy" size={ICON_SIZES.sm} />
          </Button>
        </Tooltip>
      </Flex>
    </Box>
  );
}
