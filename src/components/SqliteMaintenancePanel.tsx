import { useState } from "react";
import { Box, chakra, Flex, type SystemStyleObject } from "@chakra-ui/react";

import { api, type SqliteMaintenanceAction, type SqliteMaintenanceResult } from "../api/tauri";
import { useT } from "../i18n";
import { Callout } from "./Callout";
import { EmptyState } from "./EmptyState";
import { groupFkViolations, freelistRatio, shouldSuggestVacuum } from "./sqliteMaintenance";
import { Tooltip } from "./Tooltip";
import { Button, Heading } from "./ui";
import { useToast } from "./Toast";

/**
 * SQLite のメンテナンス診断タブ (#1625 / ボトムパネルの診断グループ)。
 *
 * `PRAGMA integrity_check` (破損ページの有無)・`PRAGMA foreign_key_check` (参照整合性違反の
 * 行)・`PRAGMA optimize`・`ANALYZE` を実行して結果を出す。前 2 つは読み取りのみ。後 2 つは
 * 統計を更新するので読み取り専用接続ではバックエンドが拒否し、ここでも無効にする。
 * ANALYZE 後は実行計画が変わりうるため、実行計画ウォッチでの確認を案内する。
 */

const thCss: SystemStyleObject = {
  position: "sticky",
  top: 0,
  background: "var(--bg-muted)",
  borderBottom: "1px solid var(--border)",
  padding: "var(--space-1-5) var(--space-2-5)",
  textStyle: "overline",
  color: "var(--text-secondary)",
  whiteSpace: "nowrap",
  textAlign: "left",
};
const tdCss: SystemStyleObject = {
  borderBottom: "1px solid var(--border-subtle, var(--border))",
  padding: "var(--space-1-25) var(--space-2-5)",
  fontSize: "var(--text-sm)",
  fontFamily: "var(--font-mono)",
  color: "var(--text)",
  whiteSpace: "nowrap",
};

const ACTIONS: Array<{ action: SqliteMaintenanceAction; writes: boolean }> = [
  { action: "integrity_check", writes: false },
  { action: "foreign_key_check", writes: false },
  { action: "optimize", writes: true },
  { action: "analyze", writes: true },
];

export function SqliteMaintenancePanel({ sessionId, readOnly }: { sessionId: string; readOnly: boolean }) {
  const t = useT();
  const toast = useToast();
  const [running, setRunning] = useState<SqliteMaintenanceAction | null>(null);
  const [result, setResult] = useState<SqliteMaintenanceResult | null>(null);

  const label = (a: SqliteMaintenanceAction) =>
    a === "integrity_check"
      ? t("sqliteMaintIntegrity")
      : a === "foreign_key_check"
        ? t("sqliteMaintForeignKey")
        : a === "optimize"
          ? t("sqliteMaintOptimize")
          : t("sqliteMaintAnalyze");

  const run = async (action: SqliteMaintenanceAction) => {
    setRunning(action);
    try {
      setResult(await api.sqliteMaintenance(sessionId, action));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setRunning(null);
    }
  };

  const ratio = result ? freelistRatio(result) : null;
  const violationGroups = result ? groupFkViolations(result.fk_violations) : [];

  return (
    <Box flex="1" overflowY="auto" py="5" px="6" display="flex" flexDirection="column" gap="3.5">
      <chakra.header
        display="flex"
        alignItems="center"
        justifyContent="space-between"
        gap="3"
        borderBottom="1px solid"
        borderColor="app.border"
        paddingBottom="2.5"
      >
        <Heading>{t("sqliteMaintTitle")}</Heading>
        <Flex align="center" gap="2" wrap="wrap">
          {ACTIONS.map(({ action, writes }) => {
            const blocked = writes && readOnly;
            return (
              <Tooltip
                key={action}
                label={blocked ? t("sqliteMaintReadOnly") : undefined}
                focusableWrapper={blocked}
              >
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void run(action)}
                  disabled={blocked || running !== null}
                  data-testid={`sqlite-maint-${action}`}
                >
                  {running === action ? t("sqliteMaintRunning") : label(action)}
                </Button>
              </Tooltip>
            );
          })}
        </Flex>
      </chakra.header>

      <chakra.p margin={0} fontSize="sm" color="app.textMuted">
        {t("sqliteMaintDesc")}
      </chakra.p>

      {result === null ? (
        <EmptyState compact icon="check" title={t("sqliteMaintEmpty")} />
      ) : (
        <>
          {(result.action === "integrity_check" || result.action === "foreign_key_check") &&
            (result.ok ? (
              <Callout tone="success" role="status" data-testid="sqlite-maint-ok">
                {result.action === "integrity_check" ? t("sqliteMaintIntegrityOk") : t("sqliteMaintFkOk")}
              </Callout>
            ) : (
              <Callout tone="danger" role="alert" data-testid="sqlite-maint-problem">
                {result.action === "integrity_check"
                  ? t("sqliteMaintIntegrityNg", { count: result.messages.length })
                  : t("sqliteMaintFkNg", { count: result.fk_violations.length })}
                {result.truncated && ` ${t("sqliteMaintTruncated")}`}
              </Callout>
            ))}
          {(result.action === "optimize" || result.action === "analyze") && (
            <Callout tone="info" role="status" data-testid="sqlite-maint-done">
              {t("sqliteMaintDone", { action: label(result.action), ms: result.elapsed_ms })}{" "}
              {t("sqliteMaintPlanChange")}
            </Callout>
          )}

          {result.messages.length > 0 && (
            <Box as="pre" margin={0} fontSize="sm" fontFamily="var(--font-mono)" whiteSpace="pre-wrap">
              {result.messages.join("\n")}
            </Box>
          )}

          {violationGroups.length > 0 && (
            <Box overflowX="auto">
              <chakra.table width="100%" borderCollapse="collapse">
                <thead>
                  <tr>
                    <chakra.th css={thCss}>{t("sqliteMaintColTable")}</chakra.th>
                    <chakra.th css={thCss}>{t("sqliteMaintColParent")}</chakra.th>
                    <chakra.th css={thCss}>{t("sqliteMaintColCount")}</chakra.th>
                    <chakra.th css={thCss}>{t("sqliteMaintColRowids")}</chakra.th>
                  </tr>
                </thead>
                <tbody>
                  {violationGroups.map((g) => (
                    <tr key={`${g.table}->${g.parent}`} data-testid="sqlite-maint-violation">
                      <chakra.td css={tdCss}>{g.table}</chakra.td>
                      <chakra.td css={tdCss}>{g.parent}</chakra.td>
                      <chakra.td css={tdCss}>{g.count}</chakra.td>
                      <chakra.td css={tdCss}>
                        {result.fk_violations
                          .filter((v) => v.table === g.table && v.parent === g.parent)
                          .slice(0, 20)
                          .map((v) => v.rowid ?? "—")
                          .join(", ")}
                      </chakra.td>
                    </tr>
                  ))}
                </tbody>
              </chakra.table>
            </Box>
          )}

          {result.page_count != null && result.freelist_count != null && (
            <chakra.p margin={0} fontSize="sm" color="app.text" data-testid="sqlite-maint-pages">
              {t("sqliteMaintPages", {
                pages: result.page_count,
                free: result.freelist_count,
                percent: ratio === null ? 0 : Math.round(ratio * 100),
              })}
            </chakra.p>
          )}
          {shouldSuggestVacuum(result) && (
            <Callout tone="warning" data-testid="sqlite-maint-vacuum">
              {t("sqliteMaintVacuumHint")}
            </Callout>
          )}
        </>
      )}
    </Box>
  );
}
