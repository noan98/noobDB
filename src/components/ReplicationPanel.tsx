import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, chakra, Flex, type SystemStyleObject } from "@chakra-ui/react";

import {
  api,
  type DriverKind,
  type ReplicationLink,
  type ReplicationRole,
  type ReplicationStatus,
} from "../api/tauri";
import { useT, type I18nKey } from "../i18n";
import { AUTO_REFRESH_INTERVAL_OPTIONS } from "../settings";
import { semanticColorToken } from "../semanticColors";
import { Callout } from "./Callout";
import { EmptyState } from "./EmptyState";
import { Icon, ICON_SIZES } from "./Icon";
import { useKeepAliveActive, useRefreshOnReactivate } from "./KeepAlive";
import { ListboxSelect } from "./ListboxSelect";
import { Spinner } from "./Spinner";
import { StatTile } from "./StatTile";
import { SurfaceRule } from "./SurfaceRule";
import { Tooltip } from "./Tooltip";
import { ErrorNote } from "./modalForm";
import { Button, Checkbox, Heading } from "./ui";
import { formatBytes } from "./tableSize";
import {
  formatLagSecs,
  isLagWarning,
  lagMeterPercent,
  lagWarnPercent,
  LAG_WARN_SECS,
  linkNeedsAttention,
  slotsHoldingWal,
  slotsLost,
  SLOT_WAL_WARN_BYTES,
  sortLinks,
} from "./replication";

/**
 * レプリケーション監視タブ (#2180 / ボトムパネルの診断グループ)。
 *
 * `api.getReplicationStatus` を表示中だけポーリングする (接続ヘルスと同じ。履歴には残さない)。
 * 役割・接続先ごとの遅延・スロットの WAL 保持量を見せ、使われていないスロットが WAL を
 * 溜めているときは先頭で警告する。権限不足はエラーではなく「足りない権限名」として返るので、
 * 読めた範囲 (スロット一覧など) と一緒に警告を出す。SQLite は概念が無く、導線側で無効にしてあるが、
 * 開かれた場合は理由を出す。
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

const ROLE_KEY: Record<ReplicationRole, I18nKey> = {
  primary: "replicationRolePrimary",
  replica: "replicationRoleReplica",
  standalone: "replicationRoleStandalone",
};

const STATE_KEY: Record<string, I18nKey> = {
  running: "replicationStateRunning",
  io_stopped: "replicationStateIoStopped",
  sql_stopped: "replicationStateSqlStopped",
  "io_stopped+sql_stopped": "replicationStateBothStopped",
};

/** 遅延メーター。警告の閾値の位置にマーカーを置く (0〜目盛り上限)。 */
function LagMeter({ secs }: { secs: number | null }) {
  const t = useT();
  const pct = lagMeterPercent(secs);
  const warnPct = lagWarnPercent();
  const over = isLagWarning(secs);
  return (
    <Box data-testid="replication-meter">
      <Box
        role="meter"
        aria-label={t("replicationMeterAria", { threshold: LAG_WARN_SECS })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-valuetext={secs == null ? t("replicationLagUnknown") : formatLagSecs(secs)}
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
          data-testid="replication-meter-fill"
        />
        <Box
          aria-hidden
          position="absolute"
          top="-1"
          bottom="-1"
          w="0.5"
          bg="app.text"
          style={{ left: `${warnPct}%` }}
          data-testid="replication-meter-threshold"
        />
      </Box>
      <chakra.div position="relative" h="4" mt="1" textStyle="caption" color="app.textMuted" aria-hidden>
        <chakra.span position="absolute" textStyle="numeric" style={{ left: `${warnPct}%` }}>
          {t("replicationMeterThreshold", { threshold: LAG_WARN_SECS })}
        </chakra.span>
      </chakra.div>
    </Box>
  );
}

function LinkCard({ link }: { link: ReplicationLink }) {
  const t = useT();
  const attention = linkNeedsAttention(link);
  const stateLabel = link.state ? (STATE_KEY[link.state] ? t(STATE_KEY[link.state]) : link.state) : null;
  const thread = (v: boolean | null) =>
    v === null ? null : v ? t("replicationThreadRunning") : t("replicationThreadStopped");
  return (
    <Flex
      direction="column"
      gap="2"
      p="3"
      borderRadius="md"
      borderWidth="1px"
      borderColor={attention ? semanticColorToken("warning", "border") : "app.border"}
      bg="app.surface"
      data-testid="replication-link"
      data-attention={attention ? "true" : "false"}
    >
      <Flex align="baseline" gap="2" wrap="wrap">
        <chakra.span fontWeight={600} fontFamily="var(--font-mono)">
          {link.name}
        </chakra.span>
        {stateLabel && (
          <chakra.span textStyle="caption" color="app.textMuted">
            {t("replicationState")}: {stateLabel}
          </chakra.span>
        )}
        {link.sync_state && (
          <chakra.span textStyle="caption" color="app.textMuted">
            {t("replicationSyncState")}: {link.sync_state}
          </chakra.span>
        )}
      </Flex>
      <Flex gap="2" wrap="wrap">
        <StatTile
          label={t("replicationLag")}
          value={link.lag_secs ?? t("replicationLagUnknown")}
          formatter={formatLagSecs}
        />
        {link.write_lag_secs != null && (
          <StatTile label={t("replicationLagWrite")} value={link.write_lag_secs} formatter={formatLagSecs} />
        )}
        {link.flush_lag_secs != null && (
          <StatTile label={t("replicationLagFlush")} value={link.flush_lag_secs} formatter={formatLagSecs} />
        )}
        {link.lag_bytes != null && (
          <StatTile label={t("replicationLagBytes")} value={link.lag_bytes} formatter={formatBytes} />
        )}
        {link.io_running !== null && (
          <StatTile label={t("replicationIoThread")} value={thread(link.io_running)} />
        )}
        {link.sql_running !== null && (
          <StatTile label={t("replicationSqlThread")} value={thread(link.sql_running)} />
        )}
      </Flex>
      {link.lag_secs !== null && <LagMeter secs={link.lag_secs} />}
      {link.last_error && (
        <ErrorNote role="alert" title={t("replicationLastError")} data-testid="replication-last-error">
          {link.last_error}
        </ErrorNote>
      )}
    </Flex>
  );
}

export function ReplicationPanel({ sessionId, driver }: { sessionId: string; driver: DriverKind }) {
  const t = useT();
  const unsupported = driver === "sqlite";
  const [status, setStatus] = useState<ReplicationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [intervalSecs, setIntervalSecs] = useState<number>(AUTO_REFRESH_INTERVAL_OPTIONS[0]);
  // 前回の取得が終わるまでティックを飛ばし、低速な接続でリクエストを積み重ねない。
  const busyRef = useRef(false);
  // セッション切替より前に始まった取得の遅延応答を捨てる世代番号。
  const seqRef = useRef(0);

  const load = useCallback(
    async (force = false) => {
      if (unsupported || (busyRef.current && !force)) return;
      const seq = ++seqRef.current;
      busyRef.current = true;
      setLoading(true);
      try {
        const res = await api.getReplicationStatus(sessionId);
        if (seq !== seqRef.current) return;
        setStatus(res);
        setError(null);
        setUpdatedAt(new Date());
      } catch (e) {
        if (seq !== seqRef.current) return;
        setError(String(e));
      } finally {
        if (seq === seqRef.current) {
          busyRef.current = false;
          setLoading(false);
        }
      }
    },
    [sessionId, unsupported],
  );

  useEffect(() => {
    setStatus(null);
    setError(null);
    void load(true);
  }, [load]);

  // 別のタブへ移っている間 (keep-alive で非表示) は止め、戻ったら 1 度取り直す。
  const active = useKeepAliveActive();
  useEffect(() => {
    if (unsupported || !autoRefresh || !active) return;
    const handle = setInterval(() => {
      void load();
    }, intervalSecs * 1000);
    return () => clearInterval(handle);
  }, [unsupported, autoRefresh, active, intervalSecs, load]);
  useRefreshOnReactivate(active && !unsupported, load);

  const stuckSlots = useMemo(() => (status ? slotsHoldingWal(status.slots) : []), [status]);
  const lostSlots = useMemo(() => (status ? slotsLost(status.slots) : []), [status]);
  const downstream = useMemo(
    () => sortLinks(status?.links.filter((l) => l.direction === "downstream") ?? []),
    [status],
  );
  const upstream = useMemo(
    () => sortLinks(status?.links.filter((l) => l.direction === "upstream") ?? []),
    [status],
  );

  const header = (
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
      <Heading>{t("replicationTitle")}</Heading>
      {!unsupported && (
        <Flex align="center" gap="3" wrap="wrap">
          <Tooltip label={t("replicationRefresh")} focusableWrapper={loading}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={t("replicationRefresh")}
              onClick={() => void load(true)}
              disabled={loading}
            >
              <Icon name="refresh" size={ICON_SIZES.md} />
            </Button>
          </Tooltip>
          <chakra.label
            display="inline-flex"
            alignItems="center"
            gap="1.5"
            fontSize="sm"
            color="app.textSecondary"
          >
            <Checkbox
              checked={autoRefresh}
              aria-label={t("autoRefreshAria")}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            {t("autoRefreshLabel")}
          </chakra.label>
          <ListboxSelect
            ariaLabel={t("autoRefreshIntervalAria")}
            value={String(intervalSecs)}
            options={AUTO_REFRESH_INTERVAL_OPTIONS.map((s) => ({
              value: String(s),
              label:
                s % 60 === 0
                  ? t("autoRefreshIntervalMins", { mins: s / 60 })
                  : t("autoRefreshIntervalSecs", { secs: s }),
            }))}
            onChange={(v) => setIntervalSecs(Number(v))}
          />
          {loading && <Spinner size={14} />}
          {updatedAt && (
            <chakra.span textStyle="caption" color="app.textMuted">
              {t("replicationUpdatedAt", { time: updatedAt.toLocaleTimeString() })}
            </chakra.span>
          )}
        </Flex>
      )}
      <SurfaceRule />
    </chakra.header>
  );

  return (
    <Box flex="1" overflowY="auto" py="5" px="6" display="flex" flexDirection="column" gap="3.5">
      {header}
      <chakra.p margin={0} fontSize="sm" color="app.textMuted">
        {t("replicationDesc")}
      </chakra.p>

      {unsupported ? (
        <Callout tone="info" role="status" data-testid="replication-unsupported">
          {t("replicationUnsupported")}
        </Callout>
      ) : (
        <>
          {error && (
            <ErrorNote role="alert" data-testid="replication-error">
              {t("replicationLoadError", { error })}
            </ErrorNote>
          )}

          {status?.missing_privilege && (
            <Callout tone="warning" role="status" data-testid="replication-privilege">
              {t("replicationMissingPrivilege", { privilege: status.missing_privilege })}
            </Callout>
          )}

          {lostSlots.length > 0 && (
            <Callout tone="warning" role="status" data-testid="replication-slot-lost">
              {t("replicationSlotLost", { names: lostSlots.map((s) => s.name).join(", ") })}
            </Callout>
          )}

          {stuckSlots.length > 0 && (
            <Callout tone="warning" role="status" data-testid="replication-slot-warning">
              {t("replicationSlotWarn", {
                count: stuckSlots.length,
                threshold: formatBytes(SLOT_WAL_WARN_BYTES),
                names: stuckSlots.map((s) => `${s.name} (${formatBytes(s.retained_bytes)})`).join(", "),
              })}
            </Callout>
          )}

          {status && (
            <Flex gap="2" wrap="wrap">
              <StatTile label={t("replicationRole")} value={t(ROLE_KEY[status.role])} />
            </Flex>
          )}

          {status && status.role === "standalone" && !status.missing_privilege && (
            <EmptyState
              icon="check"
              title={t("replicationStandaloneTitle")}
              description={t("replicationStandaloneDesc")}
            />
          )}

          {downstream.length > 0 && (
            <Flex direction="column" gap="2" data-testid="replication-downstream">
              <Heading as="h3">{t("replicationSectionDownstream")}</Heading>
              {downstream.map((l, i) => (
                <LinkCard key={`d:${i}:${l.name}:${l.address ?? ""}`} link={l} />
              ))}
            </Flex>
          )}

          {upstream.length > 0 && (
            <Flex direction="column" gap="2" data-testid="replication-upstream">
              <Heading as="h3">{t("replicationSectionUpstream")}</Heading>
              {upstream.map((l, i) => (
                <LinkCard key={`u:${i}:${l.name}:${l.address ?? ""}`} link={l} />
              ))}
            </Flex>
          )}

          {status && status.slots.length > 0 && (
            <Flex direction="column" gap="2" data-testid="replication-slots">
              <Heading as="h3">{t("replicationSectionSlots")}</Heading>
              <Box overflowX="auto">
                <chakra.table width="100%" borderCollapse="collapse">
                  <thead>
                    <tr>
                      <chakra.th css={thCss}>{t("replicationColName")}</chakra.th>
                      <chakra.th css={thCss}>{t("replicationColType")}</chakra.th>
                      <chakra.th css={thCss}>{t("replicationColPlugin")}</chakra.th>
                      <chakra.th css={thCss}>{t("replicationColActive")}</chakra.th>
                      <chakra.th css={thCss}>{t("replicationColRetained")}</chakra.th>
                      <chakra.th css={thCss}>{t("replicationColWalStatus")}</chakra.th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.slots.map((s) => {
                      const stuck = s.wal_status === "lost" || stuckSlots.some((x) => x.name === s.name);
                      return (
                        <tr key={s.name} data-testid="replication-slot" data-stuck={stuck ? "true" : "false"}>
                          <chakra.td css={tdCss}>{s.name}</chakra.td>
                          <chakra.td css={tdCss}>{s.slot_type}</chakra.td>
                          <chakra.td css={tdCss}>{s.plugin ?? "—"}</chakra.td>
                          <chakra.td css={tdCss} color={stuck ? "app.textWarning" : undefined}>
                            {s.active ? t("replicationActiveYes") : t("replicationActiveNo")}
                          </chakra.td>
                          <chakra.td css={tdNumCss} color={stuck ? "app.textWarning" : undefined}>
                            {formatBytes(s.retained_bytes)}
                          </chakra.td>
                          <chakra.td css={tdCss}>{s.wal_status ?? "—"}</chakra.td>
                        </tr>
                      );
                    })}
                  </tbody>
                </chakra.table>
              </Box>
            </Flex>
          )}
        </>
      )}
    </Box>
  );
}
