import { useCallback, useEffect, useState } from "react";
import { Box, chakra, Flex, type SystemStyleObject } from "@chakra-ui/react";

import { api, type PerfStatus } from "../api/tauri";
import { useT } from "../i18n";
import { setPerfMeasureEnabled, useSettings } from "../settings";
import { Callout } from "./Callout";
import { EmptyState } from "./EmptyState";
import { Icon, ICON_SIZES } from "./Icon";
import { formatPerfBytes, formatPerfMs, slowestSqlExecuteMs, toPerfRows } from "./perfPanel";
import { Button, Heading, Switch } from "./ui";
import { useToast } from "./Toast";

/**
 * パフォーマンス計測の診断タブ (#1622 / ボトムパネルの診断グループ)。
 *
 * 設定のトグル (または環境変数 `NOOBDB_PERF_LOG`) が ON のとき、バックエンドが SQL 実行
 * (`sql_execute_ms`)・IPC への送出 (`emit_ms`)・概算ペイロードを直近 20 件だけメモリに
 * 持つ。ここではそれを新しい順に表示する。**SQL 本文・行データは載らない。**
 * 接続に依存しないため、未接続でも開ける。
 */

const REFRESH_INTERVAL_MS = 3000;

const thCss: SystemStyleObject = {
  position: "sticky",
  top: 0,
  background: "var(--bg-muted)",
  borderBottom: "1px solid var(--border)",
  padding: "var(--space-1-5) var(--space-2-5)",
  textStyle: "overline",
  color: "var(--text-secondary)",
  whiteSpace: "nowrap",
  textAlign: "right",
};
const tdCss: SystemStyleObject = {
  borderBottom: "1px solid var(--border-subtle, var(--border))",
  padding: "var(--space-1-25) var(--space-2-5)",
  fontSize: "var(--text-sm)",
  fontFamily: "var(--font-mono)",
  textStyle: "numeric",
  color: "var(--text)",
  whiteSpace: "nowrap",
  textAlign: "right",
};

export function PerfPanel() {
  const t = useT();
  const toast = useToast();
  const settings = useSettings();
  const [status, setStatus] = useState<PerfStatus | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.getPerfStatus());
    } catch {
      // 一時的な取得失敗は次のポーリングで回復する。
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const clear = async () => {
    try {
      await api.clearPerfSamples();
      await refresh();
    } catch (e) {
      toast.error(String(e));
    }
  };

  const rows = toPerfRows(status?.samples ?? []);
  const slowest = slowestSqlExecuteMs(rows);

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
        <Heading>{t("perfTitle")}</Heading>
        <Flex align="center" gap="3">
          <chakra.label htmlFor="perf-panel-toggle" fontSize="sm" color="app.textSecondary">
            {t("perfMeasure")}
          </chakra.label>
          <Switch
            id="perf-panel-toggle"
            checked={settings.perfMeasureEnabled}
            onChange={setPerfMeasureEnabled}
          />
          <Button type="button" size="sm" onClick={() => void refresh()}>
            <Icon name="refresh" size={ICON_SIZES.sm} /> {t("perfRefresh")}
          </Button>
          <Button type="button" size="sm" onClick={() => void clear()} disabled={rows.length === 0}>
            {t("perfClear")}
          </Button>
        </Flex>
      </chakra.header>

      <chakra.p margin={0} fontSize="sm" color="app.textMuted">
        {t("perfDesc", { count: 20 })}
      </chakra.p>

      {status?.env_enabled && (
        <Callout tone="info" data-testid="perf-env-enabled">
          {t("perfEnvEnabled")}
        </Callout>
      )}

      {rows.length === 0 ? (
        <EmptyState
          compact
          icon="clock"
          title={status?.enabled ? t("perfEmptyOn") : t("perfEmptyOff")}
          description={status?.enabled ? undefined : t("perfEmptyOffHint")}
        />
      ) : (
        <>
          {slowest != null && (
            <chakra.p margin={0} fontSize="sm" color="app.text" data-testid="perf-slowest">
              {t("perfSlowest", { ms: formatPerfMs(slowest) })}
            </chakra.p>
          )}
          <Box overflowX="auto">
            <chakra.table width="100%" borderCollapse="collapse">
              <thead>
                <tr>
                  <chakra.th css={{ ...thCss, textAlign: "left" }}>{t("perfColTime")}</chakra.th>
                  <chakra.th css={{ ...thCss, textAlign: "left" }}>{t("perfColKind")}</chakra.th>
                  <chakra.th css={thCss}>{t("perfColSql")}</chakra.th>
                  <chakra.th css={thCss}>{t("perfColEmit")}</chakra.th>
                  <chakra.th css={thCss}>{t("perfColPayload")}</chakra.th>
                  <chakra.th css={thCss}>{t("perfColRows")}</chakra.th>
                  <chakra.th css={thCss}>{t("perfColColumns")}</chakra.th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.atMs}-${r.kind}-${r.rows}-${r.sqlExecuteMs}`} data-testid="perf-row">
                    <chakra.td css={{ ...tdCss, textAlign: "left" }}>
                      {new Date(r.atMs).toLocaleTimeString()}
                    </chakra.td>
                    <chakra.td css={{ ...tdCss, textAlign: "left" }}>
                      {r.kind === "stream" ? t("perfKindStream") : t("perfKindQuery")}
                    </chakra.td>
                    <chakra.td css={tdCss}>{formatPerfMs(r.sqlExecuteMs)}</chakra.td>
                    <chakra.td css={tdCss}>{formatPerfMs(r.emitMs)}</chakra.td>
                    <chakra.td css={tdCss}>{formatPerfBytes(r.payloadBytes)}</chakra.td>
                    <chakra.td css={tdCss}>{r.rows}</chakra.td>
                    <chakra.td css={tdCss}>{r.columns}</chakra.td>
                  </tr>
                ))}
              </tbody>
            </chakra.table>
          </Box>
        </>
      )}
    </Box>
  );
}
