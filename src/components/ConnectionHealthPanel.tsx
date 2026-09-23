import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, chakra, Flex, type SystemStyleObject } from "@chakra-ui/react";

import { api, type ConnectionProfile } from "../api/tauri";
import { useT, type I18nKey } from "../i18n";
import { semanticColorToken } from "../semanticColors";
import { AUTO_REFRESH_INTERVAL_OPTIONS } from "../settings";
import {
  buildHealthRows,
  changedHealthSessions,
  checkAllConnections,
  createHealthProber,
  healthStatusRole,
  latencyLevel,
  pruneHealthResults,
  summarizeHealth,
  type HealthProbeResult,
  type HealthRow,
  type HealthStatus,
} from "./connectionHealth";
import { EmptyState } from "./EmptyState";
import { Icon, ICON_SIZES } from "./Icon";
import { Spinner } from "./Spinner";
import { Tooltip } from "./Tooltip";
import { Button, Checkbox, Select } from "./ui";
import { useToast } from "./Toast";

/**
 * 接続横断のヘルスダッシュボード (#1068)。ボトムパネルの「接続ヘルス」タブの中身。
 *
 * 開いている全接続へ `ping_session` + `server_info` (バージョン、キャッシュ) +
 * `server_metrics` (接続数) を並列度を制限して投げ、状態・往復レイテンシ・バージョン・
 * 接続数を一覧する。判定・集計はすべて `connectionHealth.ts` の純関数で、ここは
 * ポーリングと描画だけを持つ。
 *
 * - **未接続プロファイルへは勝手に接続しない**。「保存済みも表示」で並べても行は
 *   「未接続」のままで、接続は行の「接続」ボタン (= 通常の接続フローそのもの) だけ。
 * - 落ちている接続は行の「再接続」から `api.reconnect` (同じ session id のまま張り直し)
 *   へ繋ぐ。
 * - エラー文面 (接続先情報を含みうる) は表示もログもしない。状態ラベルだけ出す。
 *
 * ボトムパネルの中身なので見出しと閉じるボタンは持たない (ui-design-system §7.1)。
 */

interface OpenConnectionLike {
  sessionId: string;
  profile: ConnectionProfile;
}

interface Props {
  connections: readonly OpenConnectionLike[];
  /** 保存済みプロファイル (「保存済みも表示」用。ここから自動接続はしない)。 */
  profiles: readonly ConnectionProfile[];
  activeSessionId: string | null;
  /** 既定の自動更新間隔 (秒)。設定の自動リフレッシュ間隔に相乗りする。 */
  defaultIntervalSecs: number;
  /** いま接続処理中のプロファイル id (二重接続を防ぐためボタンを止める)。 */
  connectingProfileId: string | null;
  /** 切替 / 接続。App の通常の接続フロー (`handleConnect`) をそのまま渡す。 */
  onOpenProfile: (profile: ConnectionProfile) => void;
  /** 再接続に成功したセッション。App 側の UI ミラー (緊急モード等) の後始末用。 */
  onReconnected: (sessionId: string) => void;
}

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
const tdCss: SystemStyleObject = {
  borderBottom: "1px solid var(--border-subtle, var(--border))",
  padding: "var(--space-1-25) var(--space-2-5)",
  fontSize: "var(--text-sm)",
  color: "var(--text)",
  whiteSpace: "nowrap",
  verticalAlign: "middle",
};
const monoTdCss: SystemStyleObject = { ...tdCss, fontFamily: "var(--font-mono)" };

const STATUS_LABEL: Record<HealthStatus, I18nKey> = {
  up: "healthStatusUp",
  down: "healthStatusDown",
  timeout: "healthStatusTimeout",
  unknown: "healthStatusUnknown",
  notConnected: "healthStatusNotConnected",
};

export function ConnectionHealthPanel({
  connections,
  profiles,
  activeSessionId,
  defaultIntervalSecs,
  connectingProfileId,
  onOpenProfile,
  onReconnected,
}: Props) {
  const t = useT();
  const toast = useToast();

  const [results, setResults] = useState<Map<string, HealthProbeResult>>(() => new Map());
  const resultsRef = useRef(results);
  // 値が変わった行を一瞬光らせる。値はフラッシュの世代で、行の key に混ぜて
  // 再マウントさせることで CSS アニメーションを毎回最初から再生する。
  const [flash, setFlash] = useState<Map<string, number>>(() => new Map());
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [includeSaved, setIncludeSaved] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [intervalSecs, setIntervalSecs] = useState<number>(() =>
    (AUTO_REFRESH_INTERVAL_OPTIONS as readonly number[]).includes(defaultIntervalSecs)
      ? defaultIntervalSecs
      : AUTO_REFRESH_INTERVAL_OPTIONS[1],
  );
  const [reconnecting, setReconnecting] = useState<ReadonlySet<string>>(() => new Set());

  // バージョンは接続中に変わらないのでセッション単位でキャッシュし、`server_info`
  // (設定変数も読む) を毎ティック叩かない。手動確認と再接続でだけ捨てる。
  const versionCache = useRef(new Map<string, string>());
  const prober = useMemo(
    () =>
      createHealthProber({
        ping: (sid) => api.pingSession(sid),
        version: (sid) => api.serverInfo(sid).then((info) => info.version),
        connections: (sid) => api.serverMetrics(sid).then((m) => m.connections),
      }),
    [],
  );
  const busyRef = useRef(false);
  // 確認中に接続の集合が変わったら、終わった直後にもう一度回す (新しい接続を
  // 次のティックまで「確認中…」のまま放置しない)。
  const rerunRef = useRef(false);
  const connectionsRef = useRef(connections);
  connectionsRef.current = connections;

  const runChecks = useCallback(
    async (opts: { refetchVersion?: boolean } = {}) => {
      if (busyRef.current) {
        rerunRef.current = true;
        return;
      }
      busyRef.current = true;
      setLoading(true);
      if (opts.refetchVersion) versionCache.current.clear();
      try {
        const targets = connectionsRef.current.map((c) => ({
          sessionId: c.sessionId,
          driver: c.profile.driver,
        }));
        const out = await checkAllConnections(targets, (target) =>
          prober.probe(target, { cachedVersion: versionCache.current.get(target.sessionId) }),
        );
        const next = pruneHealthResults(
          resultsRef.current,
          connectionsRef.current.map((c) => c.sessionId),
        );
        targets.forEach((target, i) => {
          const r = out[i];
          next.set(target.sessionId, r);
          if (r.version) versionCache.current.set(target.sessionId, r.version);
        });
        const changed = changedHealthSessions(resultsRef.current, next);
        resultsRef.current = next;
        setResults(next);
        if (changed.size > 0) {
          setFlash((cur) => {
            const m = new Map(cur);
            for (const sid of changed) m.set(sid, (m.get(sid) ?? 0) + 1);
            return m;
          });
        }
        setUpdatedAt(new Date());
      } finally {
        busyRef.current = false;
        setLoading(false);
      }
      if (rerunRef.current) {
        rerunRef.current = false;
        void runChecksRef.current();
      }
    },
    [prober],
  );

  const runChecksRef = useRef(runChecks);
  runChecksRef.current = runChecks;

  // 開いている接続の集合が変わったら (接続・切断) すぐ確認し直す。
  const sessionKey = connections.map((c) => c.sessionId).join("\n");
  useEffect(() => {
    void runChecks();
  }, [sessionKey, runChecks]);

  // 定期更新。ウィンドウが隠れている間は叩かない (SSH 越しの接続を無駄に起こさない)。
  useEffect(() => {
    if (!autoRefresh) return;
    const handle = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void runChecks();
    }, intervalSecs * 1000);
    return () => clearInterval(handle);
  }, [autoRefresh, intervalSecs, runChecks]);

  const reconnect = useCallback(
    async (row: HealthRow) => {
      const sid = row.sessionId;
      if (!sid) return;
      setReconnecting((cur) => new Set(cur).add(sid));
      try {
        await api.reconnect(sid);
        versionCache.current.delete(sid);
        onReconnected(sid);
        toast.success(t("healthReconnected", { name: row.name }));
      } catch {
        // エラー文面は接続先情報を含みうるので出さない (状態は再確認で示す)。
        toast.error(t("healthReconnectFailed", { name: row.name }));
      } finally {
        setReconnecting((cur) => {
          const next = new Set(cur);
          next.delete(sid);
          return next;
        });
      }
      await runChecks();
    },
    [onReconnected, runChecks, t, toast],
  );

  const rows = buildHealthRows(connections, profiles, results, {
    activeSessionId,
    includeSaved,
  });
  const summary = summarizeHealth(rows);
  const profileById = useMemo(() => {
    const m = new Map<string, ConnectionProfile>();
    for (const p of profiles) m.set(p.id, p);
    for (const c of connections) m.set(c.profile.id, c.profile);
    return m;
  }, [profiles, connections]);

  return (
    <Box flex="1" overflowY="auto" py="3.5" px="4" display="flex" flexDirection="column" gap="3">
      <chakra.p margin={0} fontSize="sm" color="app.textMuted">
        {t("healthDesc")}
      </chakra.p>

      <Flex align="center" gap="3" flexWrap="wrap">
        <Button type="button" onClick={() => void runChecks({ refetchVersion: true })} disabled={loading}>
          <Icon name="refresh" size={ICON_SIZES.sm} /> {t("healthRefresh")}
        </Button>
        <chakra.label display="inline-flex" alignItems="center" gap="1.5" fontSize="sm">
          <Checkbox
            checked={autoRefresh}
            aria-label={t("autoRefreshAria")}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          {t("autoRefreshLabel")}
        </chakra.label>
        <Select
          aria-label={t("autoRefreshIntervalAria")}
          value={String(intervalSecs)}
          onChange={(e) => setIntervalSecs(Number(e.target.value))}
          width="auto"
        >
          {AUTO_REFRESH_INTERVAL_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s % 60 === 0
                ? t("autoRefreshIntervalMins", { mins: s / 60 })
                : t("autoRefreshIntervalSecs", { secs: s })}
            </option>
          ))}
        </Select>
        <chakra.label display="inline-flex" alignItems="center" gap="1.5" fontSize="sm">
          <Checkbox
            checked={includeSaved}
            aria-label={t("healthIncludeSaved")}
            onChange={(e) => setIncludeSaved(e.target.checked)}
          />
          {t("healthIncludeSaved")}
        </chakra.label>
        {loading && <Spinner size={14} />}
        {updatedAt && (
          <chakra.span fontSize="xs" color="app.textMuted">
            {t("healthUpdatedAt", { time: updatedAt.toLocaleTimeString() })}
          </chakra.span>
        )}
      </Flex>

      {summary.open > 0 && (
        <Flex align="center" gap="3" flexWrap="wrap" fontSize="sm" aria-live="polite">
          <chakra.span fontWeight={600} color="app.text">
            {t("healthSummary", { up: summary.up, open: summary.open })}
          </chakra.span>
          {summary.down > 0 && (
            <chakra.span color="app.textError">{t("healthSummaryDown", { count: summary.down })}</chakra.span>
          )}
          {summary.timeout > 0 && (
            <chakra.span color="app.textWarning">
              {t("healthSummaryTimeout", { count: summary.timeout })}
            </chakra.span>
          )}
          {summary.medianLatencyMs !== null && summary.maxLatencyMs !== null && (
            <chakra.span color="app.textMuted">
              {t("healthSummaryLatency", { median: summary.medianLatencyMs, max: summary.maxLatencyMs })}
            </chakra.span>
          )}
        </Flex>
      )}

      {rows.length === 0 ? (
        <EmptyState icon="server" title={t("healthEmpty")} />
      ) : (
        <Box overflowX="auto">
          <chakra.table width="100%" borderCollapse="collapse" aria-label={t("healthTableAria")}>
            <thead>
              <tr>
                <chakra.th css={thCss}>{t("healthColName")}</chakra.th>
                <chakra.th css={thCss}>{t("healthColStatus")}</chakra.th>
                <chakra.th css={thCss}>{t("healthColLatency")}</chakra.th>
                <chakra.th css={thCss}>{t("healthColVersion")}</chakra.th>
                <chakra.th css={thCss}>{t("healthColConnections")}</chakra.th>
                <chakra.th css={thCss}>{t("healthColActions")}</chakra.th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const gen = row.sessionId ? (flash.get(row.sessionId) ?? 0) : 0;
                const profile = profileById.get(row.profileId);
                return (
                  <chakra.tr
                    key={`${row.profileId}:${row.sessionId ?? "-"}:${gen}`}
                    data-testid={`health-row-${row.profileId}`}
                    css={gen > 0 ? { animation: "apply-flash 0.7s ease-out" } : undefined}
                  >
                    <chakra.td css={tdCss}>
                      <Flex direction="column" gap="0.5">
                        <Flex align="center" gap="1.5">
                          <chakra.span fontWeight={600}>{row.name}</chakra.span>
                          {row.isActive && <Badge>{t("healthActive")}</Badge>}
                          {row.isProduction && <Badge tone="danger">{t("listProduction")}</Badge>}
                          {row.readOnly && <Badge>{t("healthReadOnly")}</Badge>}
                        </Flex>
                        <chakra.span fontSize="xs" color="app.textMuted" fontFamily="var(--font-mono)">
                          {row.driver.toUpperCase()}
                          {row.target ? ` · ${row.target}` : ""}
                        </chakra.span>
                      </Flex>
                    </chakra.td>
                    <chakra.td css={tdCss}>
                      <StatusCell status={row.status} label={t(STATUS_LABEL[row.status])} />
                    </chakra.td>
                    <chakra.td css={monoTdCss}>
                      <LatencyCell ms={row.latencyMs} label={(ms) => t("healthLatencyMs", { ms })} />
                    </chakra.td>
                    <chakra.td css={monoTdCss}>{row.version ?? "–"}</chakra.td>
                    <chakra.td css={monoTdCss}>
                      {row.connections === "na" ? (
                        <Tooltip label={t("healthNaHint")} focusableWrapper>
                          <chakra.span color="app.textMuted">{t("healthNa")}</chakra.span>
                        </Tooltip>
                      ) : (
                        (row.connections ?? "–")
                      )}
                    </chakra.td>
                    <chakra.td css={tdCss}>
                      <Flex gap="1.5">
                        {row.sessionId && (row.status === "down" || row.status === "timeout") && (
                          <Button
                            type="button"
                            size="sm"
                            variant="primary"
                            disabled={reconnecting.has(row.sessionId)}
                            onClick={() => void reconnect(row)}
                          >
                            <Icon name="refresh" size={ICON_SIZES.sm} /> {t("healthReconnect")}
                          </Button>
                        )}
                        {row.sessionId && !row.isActive && profile && (
                          <Button
                            type="button"
                            size="sm"
                            disabled={connectingProfileId !== null}
                            onClick={() => onOpenProfile(profile)}
                          >
                            {t("healthSwitch")}
                          </Button>
                        )}
                        {!row.sessionId && profile && (
                          <Button
                            type="button"
                            size="sm"
                            disabled={connectingProfileId !== null}
                            onClick={() => onOpenProfile(profile)}
                          >
                            <Icon name="link" size={ICON_SIZES.sm} /> {t("healthConnect")}
                          </Button>
                        )}
                      </Flex>
                    </chakra.td>
                  </chakra.tr>
                );
              })}
            </tbody>
          </chakra.table>
        </Box>
      )}
    </Box>
  );
}

function StatusCell({ status, label }: { status: HealthStatus; label: string }) {
  const role = healthStatusRole(status);
  return (
    <Flex align="center" gap="1.5">
      <Box
        aria-hidden
        w="8px"
        h="8px"
        borderRadius="pill"
        bg={role ? semanticColorToken(role, "solid") : "app.textMuted"}
        flexShrink={0}
      />
      <chakra.span color={role ? semanticColorToken(role, "text") : "app.textMuted"}>{label}</chakra.span>
    </Flex>
  );
}

function LatencyCell({ ms, label }: { ms: number | null; label: (ms: number) => string }) {
  if (ms === null) return <chakra.span color="app.textMuted">–</chakra.span>;
  const level = latencyLevel(ms);
  const color =
    level === "critical"
      ? semanticColorToken("danger", "text")
      : level === "slow"
        ? semanticColorToken("warning", "text")
        : "app.text";
  return <chakra.span color={color}>{label(ms)}</chakra.span>;
}

function Badge({ children, tone }: { children: string; tone?: "danger" }) {
  return (
    <chakra.span
      px="1.5"
      fontSize="2xs"
      fontWeight={600}
      borderRadius="sm"
      borderWidth="1px"
      borderColor={tone ? semanticColorToken(tone, "border") : "app.border"}
      color={tone ? semanticColorToken(tone, "text") : "app.textMuted"}
    >
      {children}
    </chakra.span>
  );
}
