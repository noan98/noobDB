import { useCallback, useState } from "react";
import { Box, chakra, Flex, type SystemStyleObject } from "@chakra-ui/react";

import { api, type HealthFinding, type SchemaHealthReport } from "../api/tauri";
import { useT } from "../i18n";
import { semanticColorToken } from "../semanticColors";
import {
  findingDescription,
  findingTarget,
  reasonTextKey,
  ruleTitleKey,
  severityLabelKey,
  severityRole,
} from "./advisor";
import { copyToClipboard } from "./clipboard";
import { Icon } from "./Icon";
import { Spinner } from "./Spinner";
import { Button } from "./ui";
import { useToast } from "./Toast";

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
 * ルール判定の純ロジックはバック `db::advisor` にあり、表示ロジック (ルール →
 * i18n キー/パラメータ) は `advisor.ts` に分離してテストする。
 */

const thCss: SystemStyleObject = {
  position: "sticky",
  top: 0,
  zIndex: 1,
  background: "var(--bg-muted)",
  borderBottom: "1px solid var(--border)",
  padding: "6px 10px",
  textAlign: "left",
  fontSize: "var(--text-sm)",
  fontWeight: 600,
  color: "var(--text-secondary)",
  whiteSpace: "nowrap",
};
const tdCss: SystemStyleObject = {
  borderBottom: "1px solid var(--border-subtle, var(--border))",
  padding: "8px 10px",
  fontSize: "var(--text-sm)",
  color: "var(--text)",
  verticalAlign: "top",
};

function SeverityBadge({ severity }: { severity: HealthFinding["severity"] }) {
  const t = useT();
  const role = severityRole(severity);
  return (
    <chakra.span
      display="inline-block"
      px="2"
      py="0.5"
      fontSize="var(--text-xs)"
      fontWeight={600}
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

export function AdvisorPanel({
  sessionId,
  database,
  onInsertSql,
  onClose,
}: {
  sessionId: string;
  database: string;
  onInsertSql: (sql: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();

  const [report, setReport] = useState<SchemaHealthReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const copyFix = useCallback(
    async (sql: string) => {
      const ok = await copyToClipboard(sql);
      if (ok) toast.success(t("advisorCopied"));
      else toast.error(t("advisorCopyFailed"));
    },
    [toast, t],
  );

  return (
    <Box flex="1" overflowY="auto" py="5" px="6" display="flex" flexDirection="column" gap="14px">
      <chakra.header
        display="flex"
        alignItems="center"
        justifyContent="space-between"
        gap="3"
        borderBottom="1px solid"
        borderColor="app.border"
        paddingBottom="2.5"
      >
        <chakra.h2 margin={0} fontSize="lg" fontWeight={600} color="app.text">
          {t("advisorTitle")}
        </chakra.h2>
        <Button
          minWidth="28px"
          px="2"
          py="1"
          fontSize="base"
          lineHeight={1}
          onClick={onClose}
          aria-label={t("advisorClose")}
          title={t("advisorClose")}
        >
          <Icon name="close" size={13} />
        </Button>
      </chakra.header>

      <chakra.p margin={0} fontSize="sm" color="app.textMuted">
        {t("advisorDesc")}
      </chakra.p>

      <Flex align="center" gap="3" flexWrap="wrap">
        <Button type="button" variant="primary" onClick={run} disabled={running}>
          <Icon name="refresh" size={13} />
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

      {error && (
        <chakra.p margin={0} fontSize="sm" color="var(--status-error)">
          {t("advisorError", { error })}
        </chakra.p>
      )}

      {report && report.skipped.length > 0 && (
        <Box
          borderRadius="var(--radius-sm)"
          border="1px solid"
          borderColor={semanticColorToken("warning", "border")}
          bg={semanticColorToken("warning", "subtle")}
          color={semanticColorToken("warning", "text")}
          px="3"
          py="2.5"
        >
          <chakra.div fontSize="sm" fontWeight={600} marginBottom="1">
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

      {report && report.findings.length > 0 && (
        <chakra.table width="100%" style={{ borderCollapse: "collapse" }}>
          <chakra.thead>
            <chakra.tr>
              <chakra.th css={thCss}>{t("advisorColSeverity")}</chakra.th>
              <chakra.th css={thCss}>{t("advisorColRule")}</chakra.th>
              <chakra.th css={thCss}>{t("advisorColTarget")}</chakra.th>
              <chakra.th css={thCss}>{t("advisorColDetail")}</chakra.th>
            </chakra.tr>
          </chakra.thead>
          <chakra.tbody>
            {report.findings.map((f, i) => {
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
                        color="var(--status-warning, var(--text-secondary))"
                      >
                        {t("advisorStatisticalNote")}
                      </chakra.div>
                    )}
                    {f.fix_ddl && (
                      <Box marginTop="2">
                        <chakra.pre
                          margin={0}
                          padding="6px 8px"
                          fontSize="var(--text-xs)"
                          fontFamily="var(--font-mono)"
                          background="var(--bg-muted)"
                          border="1px solid var(--border-subtle, var(--border))"
                          borderRadius="var(--radius-sm)"
                          overflowX="auto"
                          whiteSpace="pre-wrap"
                          wordBreak="break-all"
                        >
                          {f.fix_ddl}
                        </chakra.pre>
                        <Flex gap="2" marginTop="1.5">
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            onClick={() => insertFix(f.fix_ddl as string)}
                          >
                            {t("advisorInsertFix")}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => copyFix(f.fix_ddl as string)}
                            aria-label={t("advisorCopyFix")}
                            title={t("advisorCopyFix")}
                          >
                            <Icon name="copy" size={12} />
                          </Button>
                        </Flex>
                      </Box>
                    )}
                  </chakra.td>
                </chakra.tr>
              );
            })}
          </chakra.tbody>
        </chakra.table>
      )}
    </Box>
  );
}
