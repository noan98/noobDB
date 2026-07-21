import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Box, chakra, Flex, type SystemStyleObject } from "@chakra-ui/react";

import { api, type DriverKind, type ProcessInfo } from "../api/tauri";
import { useT } from "../i18n";
import { AUTO_REFRESH_INTERVAL_OPTIONS } from "../settings";
import { formatProcessTime, pruneSelection, summarizeQuery } from "./processList";
import { ServerMetricsPanel } from "./ServerMetricsPanel";
import { useConfirm } from "./ConfirmDialog";
import { Icon } from "./Icon";
import { Spinner } from "./Spinner";
import { Button, Checkbox, Select } from "./ui";
import { useToast } from "./Toast";

/**
 * プロセスモニタパネル: サーバ側のプロセス/接続一覧 (MySQL processlist /
 * PostgreSQL pg_stat_activity) をポーリング表示し、チェックボックスで選択した
 * プロセスを KILL できる。SchemaCompareView と同じ全画面ビューとして表示する
 * (クエリ結果を持たない接続スコープの画面のため、タブにはしない)。
 *
 * 負荷面の設計: 一覧クエリはエンジンのメモリ上の状態を読むだけでテーブル I/O が
 * なく、ポーリング間隔は既存の自動リフレッシュと同じプリセット (最短 5 秒)。
 * in-flight ガードで前回の取得が終わるまで次のティックをスキップするため、
 * リクエストが積み重なることはない。
 *
 * kill は誤操作の影響が大きい (実行中クエリの中断 + 接続切断) ため、tone=danger の
 * 確認ダイアログを必ず挟む。read_only セッションではバックエンドが拒否するので、
 * UI 側でもボタンを無効化して理由を表示する。
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
  padding: "5px 10px",
  fontSize: "var(--text-sm)",
  fontFamily: "var(--font-mono)",
  color: "var(--text)",
  whiteSpace: "nowrap",
  verticalAlign: "top",
};
const queryTdCss: SystemStyleObject = {
  ...tdCss,
  whiteSpace: "normal",
  wordBreak: "break-all",
  color: "var(--text-secondary)",
  maxWidth: "640px",
};

export function ProcessListPanel({
  sessionId,
  driver,
  readOnly,
  onClose,
}: {
  sessionId: string;
  driver: DriverKind;
  readOnly: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();

  // 監視ダッシュボード (#731) はサーバランタイム統計を要するため、サーバを持たない
  // SQLite ではタブごと出さない (導線を非表示にする)。
  const showMetricsTab = driver !== "sqlite";
  const [tab, setTab] = useState<"processes" | "metrics">("processes");

  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [killing, setKilling] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  // 監視パネルなので自動更新は既定で ON。間隔は結果グリッドと同じプリセット。
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [intervalSecs, setIntervalSecs] = useState<number>(
    AUTO_REFRESH_INTERVAL_OPTIONS[0],
  );
  // in-flight ガード: 前回の取得 (または kill) が終わるまでティックをスキップし、
  // 低速な接続 (SSH トンネル等) でもリクエストが積み重ならないようにする。
  const busyRef = useRef(false);

  const load = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setLoading(true);
    try {
      const list = await api.listProcesses(sessionId);
      setProcesses(list);
      // 消えたプロセスの選択を持ち越さない (id 再利用の巻き込み防止)。
      setSelected((cur) => pruneSelection(cur, list));
      setError(null);
      setUpdatedAt(new Date());
    } catch (e) {
      setError(String(e));
    } finally {
      busyRef.current = false;
      setLoading(false);
    }
  }, [sessionId]);

  // 初回ロード + セッション切替時の再ロード。
  useEffect(() => {
    setProcesses([]);
    setSelected(new Set());
    setError(null);
    void load();
  }, [load]);

  // ポーリング。busyRef は load 側で見るので、ここは素朴な setInterval でよい。
  useEffect(() => {
    if (!autoRefresh) return;
    const handle = setInterval(() => {
      void load();
    }, intervalSecs * 1000);
    return () => clearInterval(handle);
  }, [autoRefresh, intervalSecs, load]);

  const allSelected = processes.length > 0 && selected.size === processes.length;
  const toggleAll = useCallback(() => {
    setSelected((cur) =>
      cur.size === processes.length
        ? new Set()
        : new Set(processes.map((p) => p.id)),
    );
  }, [processes]);
  const toggleOne = useCallback((id: number) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const killSelected = useCallback(async () => {
    const ids = [...selected].sort((a, b) => a - b);
    if (ids.length === 0 || killing) return;
    // 自アプリのプール接続を kill するとこのセッション自体が切断されるため、
    // 選択に含まれている場合は確認文に強い警告を足す (#自己kill による切断)。
    const includesSelf = processes.some((p) => selected.has(p.id) && p.is_self);
    const ok = await confirm({
      title: t("processKillConfirmTitle"),
      message: (
        <>
          <chakra.p margin={0}>
            {t("processKillConfirmMessage", {
              count: ids.length,
              ids: ids.join(", "),
            })}
          </chakra.p>
          {includesSelf && (
            <chakra.p marginTop="2" marginBottom={0} color="var(--status-error)" fontWeight={600}>
              {t("processKillSelfWarning")}
            </chakra.p>
          )}
        </>
      ),
      confirmLabel: t("processKillConfirmOk"),
      tone: "danger",
    });
    if (!ok) return;
    setKilling(true);
    busyRef.current = true;
    let killed = 0;
    let firstError: string | null = null;
    // 逐次 kill: プール (最大 5 本) を一斉に占有せず、失敗時にどこまで進んだか
    // 分かるようにする。件数は人間が選ぶ規模なので逐次でも十分速い。
    for (const id of ids) {
      try {
        await api.killProcess(sessionId, id);
        killed += 1;
      } catch (e) {
        if (firstError === null) firstError = String(e);
      }
    }
    busyRef.current = false;
    setKilling(false);
    if (firstError === null) {
      toast.success(t("processKillDone", { count: killed }));
    } else {
      toast.error(
        t("processKillFailed", {
          failed: ids.length - killed,
          count: ids.length,
          error: firstError,
        }),
      );
    }
    await load();
  }, [selected, killing, processes, confirm, t, sessionId, toast, load]);

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
          {t("processTitle")}
        </chakra.h2>
        <Button
          minWidth="28px"
          px="2"
          py="1"
          fontSize="base"
          lineHeight={1}
          onClick={onClose}
          aria-label={t("processClose")}
          title={t("processClose")}
        >
          <Icon name="close" size={13} />
        </Button>
      </chakra.header>

      {showMetricsTab && (
        <Flex gap="1" borderBottom="1px solid" borderColor="app.border" role="tablist">
          <TabButton active={tab === "processes"} onClick={() => setTab("processes")}>
            {t("processTabProcesses")}
          </TabButton>
          <TabButton active={tab === "metrics"} onClick={() => setTab("metrics")}>
            {t("processTabMetrics")}
          </TabButton>
        </Flex>
      )}

      {tab === "metrics" && showMetricsTab ? (
        <ServerMetricsPanel sessionId={sessionId} driver={driver} />
      ) : (
        <>
      <chakra.p margin={0} fontSize="sm" color="app.textMuted">
        {t("processDesc")}
      </chakra.p>

      <Flex align="center" gap="3" flexWrap="wrap">
        <Button
          type="button"
          variant="danger"
          disabled={readOnly || killing || selected.size === 0}
          onClick={() => void killSelected()}
          title={readOnly ? t("processReadOnlyHint") : undefined}
        >
          {t("processKillSelected", { count: selected.size })}
        </Button>
        <Button type="button" onClick={() => void load()} disabled={loading}>
          <Icon name="refresh" size={13} /> {t("processRefresh")}
        </Button>
        <chakra.label display="inline-flex" alignItems="center" gap="1.5" fontSize="sm" color="app.textSecondary">
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
        {loading && <Spinner size={14} />}
        {updatedAt && (
          <chakra.span fontSize="xs" color="app.textMuted">
            {t("processUpdatedAt", { time: updatedAt.toLocaleTimeString() })}
          </chakra.span>
        )}
      </Flex>

      {readOnly && (
        <chakra.p margin={0} fontSize="sm" color="app.textMuted">
          {t("processReadOnlyHint")}
        </chakra.p>
      )}

      {error ? (
        <chakra.p margin={0} fontSize="sm" color="var(--status-error)">
          {t("processLoadError", { error })}
        </chakra.p>
      ) : processes.length === 0 && !loading ? (
        <chakra.p margin={0} fontSize="sm" color="app.textMuted">
          {t("processEmpty")}
        </chakra.p>
      ) : (
        <Box overflowX="auto">
          <chakra.table width="100%" borderCollapse="collapse">
            <thead>
              <tr>
                <chakra.th css={thCss} width="32px">
                  <Checkbox
                    checked={allSelected}
                    aria-label={t("processSelectAll")}
                    onChange={toggleAll}
                  />
                </chakra.th>
                <chakra.th css={thCss}>{t("processColId")}</chakra.th>
                <chakra.th css={thCss}>{t("processColUser")}</chakra.th>
                <chakra.th css={thCss}>{t("processColHost")}</chakra.th>
                <chakra.th css={thCss}>{t("processColDb")}</chakra.th>
                <chakra.th css={thCss}>{t("processColCommand")}</chakra.th>
                <chakra.th css={thCss}>{t("processColState")}</chakra.th>
                <chakra.th css={thCss}>{t("processColTime")}</chakra.th>
                <chakra.th css={thCss}>{t("processColQuery")}</chakra.th>
              </tr>
            </thead>
            <tbody>
              {processes.map((p) => (
                <tr key={p.id}>
                  <chakra.td css={tdCss}>
                    <Checkbox
                      checked={selected.has(p.id)}
                      aria-label={t("processSelectRow", { id: p.id })}
                      onChange={() => toggleOne(p.id)}
                    />
                  </chakra.td>
                  <chakra.td css={tdCss}>
                    {p.id}
                    {p.is_self && (
                      <chakra.span
                        marginLeft="1.5"
                        px="1.5"
                        fontSize="var(--text-xs)"
                        fontFamily="var(--font-sans)"
                        color="var(--accent)"
                        border="1px solid var(--accent)"
                        borderRadius="var(--radius-sm)"
                        title={t("processSelfBadgeTitle")}
                      >
                        {t("processSelfBadge")}
                      </chakra.span>
                    )}
                  </chakra.td>
                  <chakra.td css={tdCss}>{p.user ?? "–"}</chakra.td>
                  <chakra.td css={tdCss}>{p.host ?? "–"}</chakra.td>
                  <chakra.td css={tdCss}>{p.database ?? "–"}</chakra.td>
                  <chakra.td css={tdCss}>{p.command ?? "–"}</chakra.td>
                  <chakra.td css={tdCss}>{p.state ?? "–"}</chakra.td>
                  <chakra.td css={tdCss}>{formatProcessTime(p.time_secs)}</chakra.td>
                  <chakra.td css={queryTdCss} title={p.query ?? undefined}>
                    {summarizeQuery(p.query)}
                  </chakra.td>
                </tr>
              ))}
            </tbody>
          </chakra.table>
        </Box>
      )}
        </>
      )}

      {dialog}
    </Box>
  );
}

/** プロセス一覧 / メトリクスの簡易タブボタン。 */
function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <chakra.button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      px="3"
      py="1.5"
      fontSize="sm"
      fontWeight={active ? 600 : 400}
      color={active ? "app.text" : "app.textMuted"}
      borderBottom="2px solid"
      borderColor={active ? "var(--accent)" : "transparent"}
      marginBottom="-1px"
      background="transparent"
      cursor="pointer"
    >
      {children}
    </chakra.button>
  );
}
