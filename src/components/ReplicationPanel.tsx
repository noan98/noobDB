import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { useConfirm } from "./ConfirmDialog";
import { ReplicationTopology } from "./ReplicationTopology";
import { SqlPreview } from "./SqlPreview";
import { EmptyState } from "./EmptyState";
import { Icon, ICON_SIZES } from "./Icon";
import { useKeepAliveActive, useRefreshOnReactivate } from "./KeepAlive";
import { ListboxSelect } from "./ListboxSelect";
import { LiveCell, LiveFlashOverlay, LiveRow, LiveRowsPresence, useLiveChanges } from "./LiveRows";
import { uniqueByKey } from "./liveDiff";
import { Skeleton } from "./Skeleton";
import { Spinner } from "./Spinner";
import { StatTile, STAT_TILE_MIN_WIDTH } from "./StatTile";
import { SurfaceRule } from "./SurfaceRule";
import { Tooltip } from "./Tooltip";
import { ErrorNote } from "./modalForm";
import { Button, Checkbox, Heading } from "./ui";
import { formatBytes } from "./tableSize";
import {
  appendReplicationHistory,
  buildDropSlotSql,
  EMPTY_REPLICATION_HISTORY,
  type ReplicationHistory,
  sampleDelta,
  summarizeReplication,
  dropSlotBlockedReason,
  formatLagSecs,
  isLagWarning,
  lagMeterPercent,
  lagWarnPercent,
  LAG_WARN_SECS,
  keyedLinkKey,
  keyLinks,
  type KeyedLink,
  linkNeedsAttention,
  REPLICATION_LINK_LIVE_FIELDS,
  REPLICATION_SLOT_LIVE_FIELDS,
  slotKey,
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
// `LiveCell` (#1022) の内側。フラッシュ層がパディングを持つので、`<td>` と同じ値をここへ置く。
const slotCellInnerCss: SystemStyleObject = { padding: "var(--space-1-25) var(--space-2-5)" };

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
  // PostgreSQL (#2244)。受信側 (`pg_stat_wal_receiver`) と送信側 (`pg_stat_replication`) の状態。
  streaming: "replicationStateStreaming",
  catchup: "replicationStateCatchup",
  startup: "replicationStateStartup",
  starting: "replicationStateStarting",
  restarting: "replicationStateRestarting",
  waiting: "replicationStateWaiting",
  stopping: "replicationStateStopping",
  backup: "replicationStateBackup",
  no_receiver: "replicationStateNoReceiver",
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

/**
 * `StatTile` の外枠 (#2213)。タイルと同じ flex 配分を持ち、並びを変えない。タイルは包み直さず、
 * 値が変わったときだけ兄弟のオーバーレイが `apply-flash` を 1 回光らせる (タイルを作り直さないので
 * `CountUp` が途切れない)。
 */
const flashTileCss: SystemStyleObject = {
  position: "relative",
  display: "flex",
  flex: "1",
  minWidth: STAT_TILE_MIN_WIDTH,
  borderRadius: "var(--radius-md)",
};

function FlashTile({ flash, children }: { flash: number | null; children: ReactNode }) {
  return (
    <chakra.div css={flashTileCss}>
      {children}
      <LiveFlashOverlay token={flash} />
    </chakra.div>
  );
}

/** 変化セルごとのフラッシュ再生キー (`useLiveChanges` が返す世代番号)。 */
interface LinkFlash {
  lag: number | null;
  lagWrite: number | null;
  lagFlush: number | null;
  lagBytes: number | null;
}

/** 初回取得中のカード形スケルトン (#2213)。支援技術には隠す (読み込み中はヘッダのスピナーが伝える)。 */
function LinkCardSkeleton() {
  return (
    <Flex
      direction="column"
      gap="2"
      p="3"
      borderRadius="md"
      borderWidth="1px"
      borderColor="app.border"
      bg="app.surface"
      aria-hidden
      data-testid="replication-skeleton"
    >
      <Skeleton style={{ height: "var(--space-3-5)", width: "30%" }} />
      <Flex gap="2" wrap="wrap">
        {[0, 1, 2].map((i) => (
          <Skeleton
            key={i}
            style={{
              flex: 1,
              minWidth: STAT_TILE_MIN_WIDTH,
              height: "var(--space-12)",
              borderRadius: "var(--radius-md)",
              animationDelay: `${i * 0.05}s`,
            }}
          />
        ))}
      </Flex>
      <Skeleton style={{ height: "var(--space-2)", width: "100%", animationDelay: "0.15s" }} />
    </Flex>
  );
}

function LinkCard({
  link,
  flash,
  lagTrend,
}: {
  link: ReplicationLink;
  flash: LinkFlash;
  /** この接続先の遅延 (秒) の推移 (#2215)。 */
  lagTrend?: readonly (number | null)[];
}) {
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
        <FlashTile flash={flash.lag}>
          <StatTile
            label={t("replicationLag")}
            value={link.lag_secs ?? t("replicationLagUnknown")}
            formatter={formatLagSecs}
            trend={lagTrend}
            delta={sampleDelta(lagTrend)}
            goodWhen="down"
          />
        </FlashTile>
        {link.write_lag_secs != null && (
          <FlashTile flash={flash.lagWrite}>
            <StatTile
              label={t("replicationLagWrite")}
              value={link.write_lag_secs}
              formatter={formatLagSecs}
            />
          </FlashTile>
        )}
        {link.flush_lag_secs != null && (
          <FlashTile flash={flash.lagFlush}>
            <StatTile
              label={t("replicationLagFlush")}
              value={link.flush_lag_secs}
              formatter={formatLagSecs}
            />
          </FlashTile>
        )}
        {link.lag_bytes != null && (
          <FlashTile flash={flash.lagBytes}>
            <StatTile label={t("replicationLagBytes")} value={link.lag_bytes} formatter={formatBytes} />
          </FlashTile>
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

export function ReplicationPanel({
  sessionId,
  driver,
  readOnly = false,
  onDropSlot,
}: {
  sessionId: string;
  driver: DriverKind;
  /** 読み取り専用の接続か。スロット削除を無効にする (バックエンドも拒否する)。 */
  readOnly?: boolean;
  /**
   * スロットを削除する (App 側で共通の書き込みゲートを通して実行する)。承認されて成功したら true、
   * キャンセル / 失敗なら false。未指定なら削除ボタンを出さない。
   */
  onDropSlot?: (name: string, sql: string) => Promise<boolean>;
}) {
  const t = useT();
  const { confirm, dialog } = useConfirm();
  const [dropping, setDropping] = useState<string | null>(null);
  const unsupported = driver === "sqlite";
  const [status, setStatus] = useState<ReplicationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // 表示中のポーリング値の推移 (#2215)。メモリのみ。セッションを切り替えるとリセットし、履歴 DB には残さない。
  const [history, setHistory] = useState<ReplicationHistory>(EMPTY_REPLICATION_HISTORY);
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
        setHistory((h) => appendReplicationHistory(h, keyLinks(res.links), res.slots));
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
    setHistory(EMPTY_REPLICATION_HISTORY);
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

  const dropSlot = async (name: string) => {
    if (!onDropSlot || dropping) return;
    const sql = buildDropSlotSql(name);
    const ok = await confirm({
      title: t("replicationDropConfirmTitle"),
      message: (
        <Flex direction="column" gap="2">
          <chakra.p margin={0}>{t("replicationDropConfirmBody", { name })}</chakra.p>
          <SqlPreview sql={sql} driver="postgres" />
        </Flex>
      ),
      confirmLabel: t("replicationDropConfirmOk"),
      tone: "danger",
    });
    if (!ok) return;
    setDropping(name);
    try {
      if (await onDropSlot(name, sql)) await load(true);
    } finally {
      setDropping(null);
    }
  };

  const summary = useMemo(() => (status ? summarizeReplication(status.links, status.slots) : null), [status]);
  const stuckSlots = useMemo(() => (status ? slotsHoldingWal(status.slots) : []), [status]);
  const lostSlots = useMemo(() => (status ? slotsLost(status.slots) : []), [status]);
  // key は並べ替え前の一覧で振る (重複する接続先は出現順の連番で区別する)。描画と差分の両方で共有する。
  const allLinks = useMemo(() => keyLinks(status?.links ?? []), [status]);
  const downstream = useMemo(
    () => sortLinks(allLinks.filter((l) => l.direction === "downstream")),
    [allLinks],
  );
  const upstream = useMemo(() => sortLinks(allLinks.filter((l) => l.direction === "upstream")), [allLinks]);

  // ポーリング結果の差分から、値が変わったセルだけ光らせる (#2213)。初回表示・セッション切替直後は
  // 前回が空なので光らない。key は並びに依存しない `linkKeys` / `slotKey`。
  const allSlots = useMemo(() => uniqueByKey(status?.slots ?? [], slotKey), [status]);
  const linkLive = useLiveChanges(allLinks, keyedLinkKey, REPLICATION_LINK_LIVE_FIELDS);
  const slotLive = useLiveChanges(allSlots, slotKey, REPLICATION_SLOT_LIVE_FIELDS);
  const renderLinks = (links: readonly KeyedLink[]) => (
    // 行間は各行の内側 padding が持つので、親の gap 分を負のマージンで相殺する。
    <Flex direction="column" mt="-1.5">
      <LiveRowsPresence>
        {links.map((l) => {
          const key = l.key;
          return (
            <LiveRow key={key} reorder>
              <LinkCard
                link={l}
                lagTrend={history.linkLag[key]}
                flash={{
                  lag: linkLive.flashToken(key, "lag"),
                  lagWrite: linkLive.flashToken(key, "lagWrite"),
                  lagFlush: linkLive.flashToken(key, "lagFlush"),
                  lagBytes: linkLive.flashToken(key, "lagBytes"),
                }}
              />
            </LiveRow>
          );
        })}
      </LiveRowsPresence>
    </Flex>
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
      {dialog}
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

          {status === null && error === null && <LinkCardSkeleton />}

          {status && (
            <Flex gap="2" wrap="wrap">
              <StatTile label={t("replicationRole")} value={t(ROLE_KEY[status.role])} />
              {summary && summary.attentionLinks > 0 && (
                <StatTile
                  label={t("replicationSummaryAttention")}
                  value={summary.attentionLinks}
                  goodWhen="down"
                />
              )}
              {summary && summary.maxLagSecs !== null && (
                <StatTile
                  label={t("replicationSummaryMaxLag")}
                  value={summary.maxLagSecs}
                  formatter={formatLagSecs}
                  trend={history.maxLag}
                  delta={sampleDelta(history.maxLag)}
                  goodWhen="down"
                />
              )}
              {summary && summary.retainedBytesTotal !== null && (
                <StatTile
                  label={t("replicationSummaryWalTotal")}
                  value={summary.retainedBytesTotal}
                  formatter={formatBytes}
                  trend={history.retainedTotal}
                  delta={sampleDelta(history.retainedTotal)}
                  goodWhen="down"
                />
              )}
              {summary && status.slots.length > 0 && (
                <StatTile label={t("replicationSummaryInactiveSlots")} value={summary.inactiveSlots} />
              )}
            </Flex>
          )}

          {status && <ReplicationTopology links={allLinks} driver={driver} />}

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
              {renderLinks(downstream)}
            </Flex>
          )}

          {upstream.length > 0 && (
            <Flex direction="column" gap="2" data-testid="replication-upstream">
              <Heading as="h3">{t("replicationSectionUpstream")}</Heading>
              {renderLinks(upstream)}
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
                      {onDropSlot && <chakra.th css={thCss}>{t("replicationColActions")}</chakra.th>}
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
                          <LiveCell
                            css={tdNumCss}
                            innerCss={slotCellInnerCss}
                            collapse={false}
                            flash={slotLive.flashToken(slotKey(s), "retained")}
                            color={stuck ? "app.textWarning" : undefined}
                          >
                            {formatBytes(s.retained_bytes)}
                          </LiveCell>
                          <chakra.td css={tdCss}>{s.wal_status ?? "—"}</chakra.td>
                          {onDropSlot && (
                            <chakra.td css={tdCss}>
                              {(() => {
                                const blocked = dropSlotBlockedReason(s, readOnly);
                                return (
                                  <Tooltip
                                    label={
                                      blocked === "readOnly"
                                        ? t("replicationDropReadOnlyHint")
                                        : blocked === "active"
                                          ? t("replicationDropActiveHint")
                                          : undefined
                                    }
                                    focusableWrapper={blocked !== null}
                                  >
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="dangerOutline"
                                      disabled={blocked !== null || dropping !== null}
                                      aria-label={t("replicationDropSlotAria", { name: s.name })}
                                      onClick={() => void dropSlot(s.name)}
                                      data-testid="replication-slot-drop"
                                    >
                                      {t("replicationDropSlot")}
                                    </Button>
                                  </Tooltip>
                                );
                              })()}
                            </chakra.td>
                          )}
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
