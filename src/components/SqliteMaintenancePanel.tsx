import { useState } from "react";
import { Box, chakra, Flex, type SystemStyleObject } from "@chakra-ui/react";

import { api, type SqliteMaintenanceAction, type SqliteMaintenanceResult } from "../api/tauri";
import { useT } from "../i18n";
import { SurfaceRule } from "./SurfaceRule";
import { Callout } from "./Callout";
import { EmptyState } from "./EmptyState";
import { StatTile } from "./StatTile";
import { RunQueryIllustration } from "./illustrations";
import {
  groupFkViolations,
  freelistRatio,
  shouldSuggestVacuum,
  VACUUM_HINT_MIN_PAGES,
  VACUUM_HINT_RATIO,
} from "./sqliteMaintenance";
import { CodePreview } from "./modalForm";
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
const tdNumCss: SystemStyleObject = { ...tdCss, textStyle: "numeric" };

const PURPOSE_KEYS = [
  "sqliteMaintPurposeIntegrity",
  "sqliteMaintPurposeForeignKey",
  "sqliteMaintPurposeOptimize",
  "sqliteMaintPurposeAnalyze",
] as const;

/** 空き率メーター。VACUUM を提案する閾値の位置にマーカーを置く (0〜100% の目盛り)。 */
function FreelistMeter({ ratio }: { ratio: number }) {
  const t = useT();
  const pct = Math.min(100, Math.max(0, ratio * 100));
  const thresholdPct = VACUUM_HINT_RATIO * 100;
  const over = ratio >= VACUUM_HINT_RATIO;
  return (
    <Box data-testid="sqlite-maint-meter">
      <Box
        role="meter"
        aria-label={t("sqliteMaintMeterAria", { threshold: thresholdPct })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        position="relative"
        h="2"
        borderRadius="sm"
        bg="app.surfaceMuted"
        overflow="visible"
      >
        <Box
          h="100%"
          borderRadius="sm"
          bg={over ? "app.warningBg" : "app.accent"}
          style={{ width: `${pct}%` }}
          data-testid="sqlite-maint-meter-fill"
        />
        <Box
          aria-hidden
          position="absolute"
          top="-1"
          bottom="-1"
          w="0.5"
          bg="app.text"
          style={{ left: `${thresholdPct}%` }}
          data-testid="sqlite-maint-meter-threshold"
        />
      </Box>
      <chakra.div position="relative" h="4" mt="1" textStyle="caption" color="app.textMuted" aria-hidden>
        <chakra.span position="absolute" textStyle="numeric" style={{ left: `${thresholdPct}%` }}>
          {t("sqliteMaintMeterThreshold", { threshold: thresholdPct })}
        </chakra.span>
      </chakra.div>
    </Box>
  );
}

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
        position="relative"
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
        <SurfaceRule />
      </chakra.header>

      <chakra.p margin={0} fontSize="sm" color="app.textMuted">
        {t("sqliteMaintDesc")}
      </chakra.p>

      {result === null ? (
        <>
          <EmptyState
            illustration={<RunQueryIllustration />}
            icon="check"
            title={t("sqliteMaintEmpty")}
            description={t("sqliteMaintEmptyDesc")}
          />
          <chakra.ul
            margin={0}
            padding={0}
            listStyleType="none"
            display="flex"
            flexDirection="column"
            gap="1.5"
            fontSize="sm"
            color="app.textMuted"
            data-testid="sqlite-maint-purposes"
          >
            {PURPOSE_KEYS.map((k) => (
              <li key={k}>{t(k)}</li>
            ))}
          </chakra.ul>
        </>
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

          {result.messages.length > 0 && <CodePreview>{result.messages.join("\n")}</CodePreview>}

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
                      <chakra.td css={tdNumCss}>{g.count}</chakra.td>
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
            <Flex direction="column" gap="2" data-testid="sqlite-maint-pages">
              <Flex gap="2" wrap="wrap">
                <StatTile label={t("sqliteMaintStatPages")} value={result.page_count.toLocaleString()} />
                <StatTile label={t("sqliteMaintStatFree")} value={result.freelist_count.toLocaleString()} />
                <StatTile
                  label={t("sqliteMaintStatRatio")}
                  value={ratio === null ? "–" : `${Math.round(ratio * 100)}%`}
                />
                <StatTile
                  label={t("sqliteMaintStatElapsed")}
                  value={`${result.elapsed_ms.toLocaleString()} ms`}
                />
              </Flex>
              {ratio !== null && <FreelistMeter ratio={ratio} />}
            </Flex>
          )}
          {shouldSuggestVacuum(result) && ratio !== null && (
            <Callout tone="warning" data-testid="sqlite-maint-vacuum">
              {t("sqliteMaintVacuumHint")}{" "}
              {t("sqliteMaintVacuumReason", {
                percent: Math.round(ratio * 100),
                threshold: VACUUM_HINT_RATIO * 100,
                minPages: VACUUM_HINT_MIN_PAGES,
              })}
            </Callout>
          )}
        </>
      )}
    </Box>
  );
}
