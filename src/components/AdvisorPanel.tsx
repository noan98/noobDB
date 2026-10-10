import { useCallback, useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Box, chakra, Flex, type SystemStyleObject } from "@chakra-ui/react";
import { motion } from "motion/react";

import { api, type HealthFinding, type SchemaHealthReport } from "../api/tauri";
import { useT } from "../i18n";
import { useSettings } from "../settings";
import { semanticColorToken } from "../semanticColors";
import {
  DEFAULT_ADVISOR_SORT,
  findingDescription,
  findingTarget,
  nextAdvisorSort,
  reasonTextKey,
  ruleTitleKey,
  severityLabelKey,
  severityRole,
  sortFindings,
  type AdvisorSort,
  type AdvisorSortKey,
} from "./advisor";
import { copyToClipboard } from "./clipboard";
import { AiAdvisorExplain } from "./AiAdvisorExplain";
import { CodePreview } from "./modalForm";
import { EmptyState } from "./EmptyState";
import { errorIllustration } from "./illustrations";
import { Icon, ICON_SIZES } from "./Icon";
import { Spinner } from "./Spinner";
import { SkeletonTableRows } from "./Skeleton";
import { Tooltip } from "./Tooltip";
import { Button } from "./ui";
import { useToast } from "./Toast";
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

export function SeverityBadge({ severity }: { severity: HealthFinding["severity"] }) {
  const t = useT();
  const role = severityRole(severity);
  return (
    <chakra.span
      display="inline-block"
      px="2"
      py="0.5"
      textStyle="overline"
      lineHeight={1.4}
      borderRadius="var(--radius-sm)"
      whiteSpace="nowrap"
      bg={semanticColorToken(role, "subtle")}
      color={semanticColorToken(role, "text")}
      border="1px solid"
      borderColor={semanticColorToken(role, "border")}
    >
      {t(severityLabelKey(severity))}
    </chakra.span>
  );
}

// 結果の差し替えはフェードで出す (reduced-motion は MotionConfig が即時化する)。
const MotionReveal = chakra(motion.div, {}, {
  forwardProps: ["initial", "animate", "transition"],
});

export function AdvisorPanel({
  sessionId,
  database,
  onInsertSql,
}: {
  sessionId: string;
  database: string;
  onInsertSql: (sql: string) => void;
}) {
  const t = useT();
  const toast = useToast();
  const aiEnabled = useSettings().ai.enabled;
  // 「AI に聞く」は AI 有効 + API キー設定済みのときだけ出す。キーの有無は行ごとではなく
  // ここで 1 回だけ確認する (#1468)。取得できなければ非表示のまま。
  const [hasAiKey, setHasAiKey] = useState(false);
  useEffect(() => {
    if (!aiEnabled) return;
    let alive = true;
    api
      .hasAiApiKey()
      .then((v) => {
        if (alive) setHasAiKey(v);
      })
      .catch(() => {
        /* 取得できなければ非表示のまま */
      });
    return () => {
      alive = false;
    };
  }, [aiEnabled]);

  const [report, setReport] = useState<SchemaHealthReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<AdvisorSort>(DEFAULT_ADVISOR_SORT);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const r = await api.analyzeSchemaHealth(sessionId, database);
      setReport(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  }, [sessionId, database]);

  const insertFix = useCallback(
    (sql: string) => {
      onInsertSql(sql);
      toast.success(t("advisorInserted"));
    },
    [onInsertSql, toast, t],
  );

  const findings = useMemo(() => {
    if (!report) return [];
    return sortFindings(report.findings, sort.key, sort.dir, (f, key) => {
      if (key === "rule") return t(ruleTitleKey(f.rule));
      const desc = findingDescription(f);
      return t(desc.key, desc.params);
    });
  }, [report, sort, t]);

  // 各ソートヘッダ共通のプロパティ (クリック / Enter・Space / aria-sort)。
  // th はネイティブに columnheader ロールを持つので role は上書きしない。
  const headerProps = (key: AdvisorSortKey) => ({
    tabIndex: 0,
    "aria-sort": (sort.key === key
      ? sort.dir === "asc"
        ? "ascending"
        : "descending"
      : "none") as "ascending" | "descending" | "none",
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
          <chakra.span marginLeft="1.5">
            {report ? t("advisorRerun") : t("advisorRun")}
          </chakra.span>
        </Button>
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
            </chakra.tr>
          </chakra.thead>
          <chakra.tbody>
            <SkeletonTableRows columns={4} rows={5} />
          </chakra.tbody>
        </chakra.table>
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
            </chakra.tr>
          </chakra.thead>
          <chakra.tbody>
            {findings.map((f, i) => {
              const desc = findingDescription(f);
              return (
                <chakra.tr key={`${f.rule}-${f.table}-${f.context.join(",")}-${i}`}>
                  <chakra.td css={tdCss}>
                    <SeverityBadge severity={f.severity} />
                  </chakra.td>
                  <chakra.td css={tdCss} fontWeight={600} whiteSpace="nowrap">
                    {t(ruleTitleKey(f.rule))}
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
                      <Box marginTop="2">
                        <CodePreview wrap>{f.fix_ddl}</CodePreview>
                        <Flex gap="1" marginTop="1.5">
                          <Tooltip label={t("advisorInsertFix")}>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => insertFix(f.fix_ddl as string)}
                              aria-label={t("advisorInsertFix")}
                            >
                              <Icon name="insert-sql" size={ICON_SIZES.sm} />
                            </Button>
                          </Tooltip>
                          <Tooltip label={t("advisorCopyFix")}>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => copyFix(f.fix_ddl as string)}
                              aria-label={t("advisorCopyFix")}
                            >
                              <Icon name="copy" size={ICON_SIZES.sm} />
                            </Button>
                          </Tooltip>
                        </Flex>
                      </Box>
                    )}
                    {aiEnabled && hasAiKey && report && (
                      <AiAdvisorExplain
                        sessionId={sessionId}
                        driver={report.driver}
                        database={database}
                        finding={f}
                      />
                    )}
                  </chakra.td>
                </chakra.tr>
              );
            })}
          </chakra.tbody>
        </chakra.table>
        </MotionReveal>
      )}
    </Box>
    </Box>
  );
}
