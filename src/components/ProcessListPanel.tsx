import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useKeepAliveActive, useRefreshOnReactivate } from "./KeepAlive";
import { Box, chakra, Flex, type SystemStyleObject } from "@chakra-ui/react";

import { api, type DriverKind, type ProcessInfo } from "../api/tauri";
import { useT } from "../i18n";
import { semanticColorToken } from "../semanticColors";
import { AUTO_REFRESH_INTERVAL_OPTIONS } from "../settings";
import { COUNT_UP_TOKEN, splitAroundCountUpToken } from "../useCountUp";
import {
  buildBlockingTree,
  distinctProcessValues,
  EMPTY_PROCESS_FILTER,
  filterProcesses,
  formatProcessTime,
  isProcessFilterActive,
  processKey,
  PROCESS_LIVE_FIELDS,
  PROCESS_MIN_SECS_OPTIONS,
  pruneSelection,
  sortProcesses,
  type ProcessFilter,
  type ProcessSortKey,
} from "./processList";
import { CountUp } from "./CountUp";
import { LiveCell, LiveRowsPresence, LiveTr, useLiveChanges } from "./LiveRows";
import { uniqueByKey } from "./liveDiff";
import { AiLockDiagnose } from "./AiLockDiagnose";
import { ServerMetricsPanel } from "./ServerMetricsPanel";
import { useConfirm } from "./ConfirmDialog";
import { EmptyState } from "./EmptyState";
import { Icon, ICON_SIZES } from "./Icon";
import { errorIllustration, NoResultsIllustration } from "./illustrations";
import { SkeletonTableRows } from "./Skeleton";
import { Spinner } from "./Spinner";
import { Button, Checkbox, Input, Select } from "./ui";
import { useToast } from "./Toast";
import { Tooltip } from "./Tooltip";

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
  padding: "var(--space-1-5) var(--space-2-5)",
  textAlign: "left",
  textStyle: "overline",
  color: "var(--text-secondary)",
  whiteSpace: "nowrap",
};
// セルは `LiveCell` (#1022) の 3 層構造: `<td>` (境界線・フォント) → 伸縮 div →
// フラッシュ div (パディング・折り返し)。行の高さアニメを `<td>` の下限に
// 邪魔されないよう、パディングは内側 (`*InnerCss`) に置く。
const tdCss: SystemStyleObject = {
  borderBottom: "1px solid var(--border-subtle, var(--border))",
  fontSize: "var(--text-sm)",
  fontFamily: "var(--font-mono)",
  // ID・経過秒は自動更新で頻繁に変わるため等幅数字で桁を揃える (#1072)。
  textStyle: "numeric",
  color: "var(--text)",
  verticalAlign: "top",
};
const cellInnerCss: SystemStyleObject = {
  padding: "var(--space-1-25) var(--space-2-5)",
  whiteSpace: "nowrap",
};
const queryTdCss: SystemStyleObject = {
  ...tdCss,
  color: "var(--text-secondary)",
  maxWidth: "640px",
};
const queryInnerCss: SystemStyleObject = {
  ...cellInnerCss,
  whiteSpace: "normal",
  wordBreak: "break-all",
};

/** CountUp の補間値 (小数) を経過時間表記へ整形する。 */
function formatLiveProcessTime(n: number): string {
  return formatProcessTime(Math.round(n));
}

/** 一覧に描画する最大行数 (#1321)。これを超える分は件数表示のみで、選択・KILL は全件が対象。 */
export const PROCESS_RENDER_LIMIT = 500;

export function ProcessListPanel({
  sessionId,
  driver,
  readOnly,
  isProduction = false,
  schema,
}: {
  sessionId: string;
  driver: DriverKind;
  readOnly: boolean;
  /** 本番接続か (AI 解説の送信前確認に使う)。 */
  isProduction?: boolean;
  /** 開いているスキーマ (PostgreSQL)。AI 解説で修飾の無いテーブルを引くときに使う。 */
  schema?: string | null;
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
  // 取得の世代番号。kill やセッション切替より前に始まった取得の遅延応答
  // (kill 前のスナップショット / 旧セッションの一覧) を捨てるために使う。
  const loadSeqRef = useRef(0);

  // ポーリング結果の id 重複を除き (React key の衝突防止)、前回スナップショット
  // との差分から値変化フラッシュの再生キーを得る (#1022)。
  const rows = useMemo(() => uniqueByKey(processes, processKey), [processes]);
  const { flashToken } = useLiveChanges(rows, processKey, PROCESS_LIVE_FIELDS);
  // 件数上限 (#1321): 数千件でも描画コストが頭打ちになるよう、先頭から上限件数だけ描く。
  // 選択・全選択・件数表示は全件 (`rows`) を対象にする。
  // 絞り込み・並べ替え (#1538) は描画上限で切る「前」に全件へ適用する。501 件目以降の
  // プロセスも条件に合えば先頭側に現れ、KILL 対象を探せる。
  const [filter, setFilter] = useState<ProcessFilter>(EMPTY_PROCESS_FILTER);
  const [sortKey, setSortKey] = useState<ProcessSortKey>("default");
  // AI の停止候補から「一覧で表示」されたプロセス (#1538)。強調 + スクロール先。
  const [highlightId, setHighlightId] = useState<number | null>(null);
  const [scrollTick, setScrollTick] = useState(0);
  const filterActive = isProcessFilterActive(filter);
  const processedRows = useMemo(
    () => sortProcesses(filterProcesses(rows, filter), sortKey),
    [rows, filter, sortKey],
  );
  const visibleRows = useMemo(() => {
    const head =
      processedRows.length > PROCESS_RENDER_LIMIT
        ? processedRows.slice(0, PROCESS_RENDER_LIMIT)
        : processedRows;
    if (highlightId === null || head.some((p) => p.id === highlightId)) return head;
    // 強調対象が描画上限の外なら、先頭に足して必ず見えるようにする。
    const hit = processedRows.find((p) => p.id === highlightId);
    return hit ? [hit, ...head] : head;
  }, [processedRows, highlightId]);
  // 選択中の値が (プロセスが消えて) 選択肢から無くなっても option に残し、表示が空欄にならないようにする。
  const userOptions = useMemo(
    () => withCurrent(distinctProcessValues(rows, "user"), filter.user),
    [rows, filter.user],
  );
  const databaseOptions = useMemo(
    () => withCurrent(distinctProcessValues(rows, "database"), filter.database),
    [rows, filter.database],
  );
  const commandOptions = useMemo(
    () => withCurrent(distinctProcessValues(rows, "command"), filter.command),
    [rows, filter.command],
  );
  // 絞り込みで隠れている行の選択は kill 対象に含めない (見えないものを kill しない)。
  const activeSelected = useMemo(() => {
    if (!filterActive) return selected;
    const visible = new Set(processedRows.map((p) => p.id));
    return new Set([...selected].filter((id) => visible.has(id)));
  }, [filterActive, processedRows, selected]);

  const load = useCallback(async (force = false) => {
    if (busyRef.current && !force) return;
    const seq = ++loadSeqRef.current;
    busyRef.current = true;
    setLoading(true);
    try {
      const list = await api.listProcesses(sessionId);
      if (seq !== loadSeqRef.current) return;
      setProcesses(list);
      // 消えたプロセスの選択を持ち越さない (id 再利用の巻き込み防止)。
      setSelected((cur) => pruneSelection(cur, list));
      // 消えたプロセスの強調は外す (PG の pid 再利用で無関係な行が強調されるのを防ぐ)。
      setHighlightId((cur) => (cur !== null && list.some((p) => p.id === cur) ? cur : null));
      setError(null);
      setUpdatedAt(new Date());
    } catch (e) {
      if (seq !== loadSeqRef.current) return;
      setError(String(e));
    } finally {
      if (seq === loadSeqRef.current) {
        busyRef.current = false;
        setLoading(false);
      }
    }
  }, [sessionId]);

  // 初回ロード + セッション切替時の再ロード。
  useEffect(() => {
    setProcesses([]);
    setSelected(new Set());
    setHighlightId(null);
    // 別セッションへ絞り込み・並べ替えを持ち越さない (他セッションの値で全件が隠れるのを防ぐ)。
    setFilter(EMPTY_PROCESS_FILTER);
    setSortKey("default");
    setError(null);
    // 旧セッションの取得が飛んでいても、新セッションの初回取得は必ず走らせる。
    void load(true);
  }, [load]);

  // ポーリング。busyRef は load 側で見るので、ここは素朴な setInterval でよい。
  // 別のボトムパネルのタブへ移っている間 (keep-alive で非表示, #1311) は止め、
  // 戻ってきた時点で 1 度取り直す。
  const active = useKeepAliveActive();
  useEffect(() => {
    if (!autoRefresh || !active) return;
    const handle = setInterval(() => {
      void load();
    }, intervalSecs * 1000);
    return () => clearInterval(handle);
  }, [autoRefresh, intervalSecs, load, active]);
  useRefreshOnReactivate(active, load);

  const countParts = splitAroundCountUpToken(t("processCount", { count: COUNT_UP_TOKEN }));

  const allSelected =
    processedRows.length > 0 && processedRows.every((p) => selected.has(p.id));
  // 全選択は絞り込み後の行が対象。絞り込み外の選択は触らない。
  const toggleAll = useCallback(() => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (processedRows.every((p) => cur.has(p.id))) {
        for (const p of processedRows) next.delete(p.id);
      } else {
        for (const p of processedRows) next.add(p.id);
      }
      return next;
    });
  }, [processedRows]);
  const toggleOne = useCallback((id: number) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // 待機チェーン (#1417)。ブロッカー → 被ブロッカーのツリー。
  const blockingRows = useMemo(() => buildBlockingTree(rows), [rows]);

  // 確認 → 一括 kill → 再取得。選択 kill と待機ツリーのブロッカー kill で共通 (#1417)。
  const killIds = useCallback(async (rawIds: number[], statementOnly = false) => {
    const ids = [...rawIds].sort((a, b) => a - b);
    if (ids.length === 0 || killing) return;
    // 自アプリのプール接続を kill するとこのセッション自体が切断されるため、
    // 選択に含まれている場合は確認文に強い警告を足す (#自己kill による切断)。
    const includesSelf = processes.some((p) => ids.includes(p.id) && p.is_self);
    const ok = await confirm({
      title: t(statementOnly ? "processCancelConfirmTitle" : "processKillConfirmTitle"),
      message: (
        <>
          <chakra.p margin={0}>
            {t(statementOnly ? "processCancelConfirmMessage" : "processKillConfirmMessage", {
              count: ids.length,
              ids: ids.join(", "),
            })}
          </chakra.p>
          {includesSelf && !statementOnly && (
            <chakra.p marginTop="2" marginBottom={0} color={semanticColorToken("danger", "text")} fontWeight={600}>
              {t("processKillSelfWarning")}
            </chakra.p>
          )}
        </>
      ),
      confirmLabel: t(statementOnly ? "processCancelConfirmOk" : "processKillConfirmOk"),
      tone: "danger",
    });
    if (!ok) return;
    setKilling(true);
    busyRef.current = true;
    // kill より前に始まったポーリングの応答 (kill 前のスナップショット) を無効化する。
    loadSeqRef.current++;
    // バックエンドの 1 コマンドで一括 kill (#1259)。PostgreSQL は 1 文、MySQL は 1 接続上で
    // 順に実行し、失敗があっても残りは続行して件数と最初のエラーを返す。
    let killed = 0;
    let failed = ids.length;
    let firstError: string | null = null;
    try {
      const res = await api.killProcesses(sessionId, ids, statementOnly);
      killed = res.killed;
      failed = res.failed;
      firstError = res.first_error;
    } catch (e) {
      // read_only 拒否など、コマンド自体が失敗した場合は全件失敗として扱う。
      firstError = String(e);
    }
    busyRef.current = false;
    setKilling(false);
    if (firstError === null && failed === 0) {
      toast.success(t(statementOnly ? "processCancelDone" : "processKillDone", { count: killed }));
    } else {
      toast.error(
        t(statementOnly ? "processCancelFailed" : "processKillFailed", {
          failed,
          count: ids.length,
          error: firstError ?? "",
        }),
      );
    }
    await load(true);
  }, [killing, processes, confirm, t, sessionId, toast, load]);
  const killSelected = useCallback(() => killIds([...activeSelected]), [killIds, activeSelected]);
  const cancelSelected = useCallback(
    () => killIds([...activeSelected], true),
    [killIds, activeSelected],
  );
  const killBlocker = useCallback((id: number) => killIds([id]), [killIds]);

  // AI の停止候補 → 一覧の該当行へ (#1538)。AI は何も実行せず、行を強調してスクロールし、
  // その 1 件だけを選択する。停止は下の既存ボタン (確認ダイアログつき) でユーザが行う。
  const locateProcess = useCallback(
    (id: number) => {
      if (!rows.some((p) => p.id === id)) {
        toast.info(t("processLocateGone", { id }));
        return;
      }
      // 絞り込みで隠れるなら解除して見えるようにする。
      if (!filterProcesses(rows, filter).some((p) => p.id === id)) setFilter(EMPTY_PROCESS_FILTER);
      setHighlightId(id);
      setSelected(new Set([id]));
      setScrollTick((n) => n + 1);
    },
    [rows, filter, toast, t],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrollTick は同じ行を再度指されたときもスクロールを再実行するためのトリガー
  useEffect(() => {
    if (highlightId === null) return;
    document
      .getElementById(`process-row-${sessionId}-${highlightId}`)
      ?.scrollIntoView?.({ block: "center" });
  }, [highlightId, scrollTick, sessionId]);

  return (
    <Box flex="1" overflowY="auto" py="3.5" px="4" display="flex" flexDirection="column" gap="3.5">

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
      <chakra.p margin={0} textStyle="body" color="app.textMuted">
        {t("processDesc")}
      </chakra.p>

      <Flex align="center" gap="3" flexWrap="wrap">
        <Tooltip label={readOnly ? t("processReadOnlyHint") : undefined} focusableWrapper={readOnly}>
          <Button
            type="button"
            variant="danger"
            disabled={readOnly || killing || activeSelected.size === 0}
            onClick={() => void killSelected()}
          >
            {t("processKillSelected", { count: activeSelected.size })}
          </Button>
        </Tooltip>
        <Tooltip
          label={readOnly ? t("processReadOnlyHint") : t("processCancelSelectedHint")}
          focusableWrapper={readOnly}
        >
          <Button
            type="button"
            variant="secondary"
            disabled={readOnly || killing || activeSelected.size === 0}
            onClick={() => void cancelSelected()}
          >
            {t("processCancelSelected", { count: activeSelected.size })}
          </Button>
        </Tooltip>
        <Tooltip label={t("processRefresh")} focusableWrapper={loading}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t("processRefresh")}
            onClick={() => void load()}
            disabled={loading}
          >
            <Icon name="refresh" size={ICON_SIZES.md} />
          </Button>
        </Tooltip>
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
          <chakra.span fontSize="xs" color="app.textMuted" textStyle="numeric">
            {t("processUpdatedAt", { time: updatedAt.toLocaleTimeString() })}
          </chakra.span>
        )}
        {updatedAt && !error && (
          // 接続数の増減をカウントアップで示す (#1022)。数値以外の文言は i18n
          // テンプレートのまま、数値部分だけを CountUp へ差し替える。
          <chakra.span fontSize="xs" color="app.textMuted" data-testid="process-count">
            {countParts[0]}
            <CountUp value={rows.length} />
            {countParts[1]}
          </chakra.span>
        )}
      </Flex>

      {readOnly && (
        <chakra.p margin={0} textStyle="body" color="app.textMuted">
          {t("processReadOnlyHint")}
        </chakra.p>
      )}

      {!error && processes.length > 0 && (
        <Flex align="center" gap="2" flexWrap="wrap" data-testid="process-filter">
          <Input
            type="search"
            width="auto"
            minWidth="72"
            aria-label={t("processFilterTextAria")}
            placeholder={t("processFilterTextPlaceholder")}
            value={filter.text}
            onChange={(e) => setFilter((f) => ({ ...f, text: e.target.value }))}
          />
          <Select
            aria-label={t("processFilterUserAria")}
            value={filter.user}
            onChange={(e) => setFilter((f) => ({ ...f, user: e.target.value }))}
            width="auto"
          >
            <option value="">{t("processFilterUserAny")}</option>
            {userOptions.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </Select>
          <Select
            aria-label={t("processFilterDbAria")}
            value={filter.database}
            onChange={(e) => setFilter((f) => ({ ...f, database: e.target.value }))}
            width="auto"
          >
            <option value="">{t("processFilterDbAny")}</option>
            {databaseOptions.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </Select>
          <Select
            aria-label={t("processFilterStateAria")}
            value={filter.command}
            onChange={(e) => setFilter((f) => ({ ...f, command: e.target.value }))}
            width="auto"
          >
            <option value="">{t("processFilterStateAny")}</option>
            {commandOptions.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </Select>
          <Select
            aria-label={t("processFilterMinSecsAria")}
            value={String(filter.minSecs)}
            onChange={(e) => setFilter((f) => ({ ...f, minSecs: Number(e.target.value) }))}
            width="auto"
          >
            {PROCESS_MIN_SECS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s === 0 ? t("processFilterMinSecsAny") : t("processFilterMinSecsOver", { time: formatProcessTime(s) })}
              </option>
            ))}
          </Select>
          <Select
            aria-label={t("processSortAria")}
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as ProcessSortKey)}
            width="auto"
          >
            <option value="default">{t("processSortDefault")}</option>
            <option value="timeDesc">{t("processSortTimeDesc")}</option>
            <option value="timeAsc">{t("processSortTimeAsc")}</option>
            <option value="id">{t("processSortId")}</option>
          </Select>
          {filterActive && (
            <>
              <chakra.span textStyle="caption" data-testid="process-filter-count">
                {t("processFilterCount", { shown: processedRows.length, total: rows.length })}
              </chakra.span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setFilter(EMPTY_PROCESS_FILTER)}
              >
                {t("processFilterClear")}
              </Button>
            </>
          )}
        </Flex>
      )}

      {/* AI 解説 (#1478)。AI 無効 / SQLite では何も描かない。KILL は下の既存ボタンで行う。 */}
      {!error && (
        <AiLockDiagnose
          key={sessionId}
          sessionId={sessionId}
          driver={driver}
          processes={rows}
          selectedIds={activeSelected}
          onLocateProcess={locateProcess}
          isProduction={isProduction}
          schema={schema ?? undefined}
        />
      )}

      {!error && blockingRows.length > 0 && (
        <Box
          border="1px solid"
          borderColor="app.border"
          borderRadius="md"
          padding="3"
          data-testid="blocking-tree"
        >
          <chakra.p margin={0} fontWeight={600} fontSize="sm">
            {t("processBlockingTitle")}
          </chakra.p>
          <chakra.p margin={0} marginBottom="2" textStyle="caption" color="app.textMuted">
            {t("processBlockingDesc")}
          </chakra.p>
          <chakra.ul listStyleType="none" margin={0} padding={0} role="list">
            {blockingRows.map((r, i) => (
              <chakra.li
                key={`${r.process.id}-${i}`}
                role="listitem"
                display="flex"
                alignItems="center"
                gap="2"
                paddingLeft={`calc(${r.depth} * var(--space-4))`}
                paddingY="1"
                fontSize="sm"
                fontFamily="var(--font-mono)"
              >
                <chakra.span color="app.textMuted" aria-hidden>
                  {r.depth === 0 ? "●" : "└"}
                </chakra.span>
                <chakra.span fontWeight={r.isRoot ? 700 : 400}>#{r.process.id}</chakra.span>
                <chakra.span color="app.textMuted">{r.process.user ?? "–"}</chakra.span>
                {r.process.time_secs != null && (
                  <chakra.span color="app.textMuted">
                    {formatProcessTime(r.process.time_secs)}
                  </chakra.span>
                )}
                <chakra.span
                  color="app.textSecondary"
                  overflow="hidden"
                  textOverflow="ellipsis"
                  whiteSpace="nowrap"
                  flex="1"
                  minWidth={0}
                >
                  {r.process.query_summary ?? ""}
                </chakra.span>
                {r.repeated && (
                  <chakra.span color="app.textWarning" fontFamily="var(--font-sans)">
                    {t("processBlockingRepeated")}
                  </chakra.span>
                )}
                {r.process.is_self && (
                  <chakra.span
                    px="1.5"
                    fontSize="var(--text-xs)"
                    fontFamily="var(--font-sans)"
                    color="var(--accent)"
                    border="1px solid var(--accent)"
                    borderRadius="var(--radius-sm)"
                  >
                    {t("processSelfBadge")}
                  </chakra.span>
                )}
                {r.deadlock && (
                  <chakra.span color="app.textError" fontFamily="var(--font-sans)">
                    {t("processBlockingDeadlock")}
                  </chakra.span>
                )}
                {r.isRoot && !r.external && (
                  <chakra.span color="app.textError" fontFamily="var(--font-sans)">
                    {t("processBlockingRoot", { count: r.victims })}
                  </chakra.span>
                )}
                {r.external && !r.repeated && (
                  <chakra.span color="app.textWarning" fontFamily="var(--font-sans)">
                    {t("processBlockingExternal", { id: r.process.id, count: r.victims })}
                  </chakra.span>
                )}
                {!r.repeated && !r.external && r.victims > 0 && (
                  <Tooltip label={readOnly ? t("processReadOnlyHint") : undefined} focusableWrapper={readOnly}>
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      disabled={readOnly || killing}
                      aria-label={t("processBlockingKillAria", { id: r.process.id })}
                      onClick={() => void killBlocker(r.process.id)}
                    >
                      {t("processBlockingKill")}
                    </Button>
                  </Tooltip>
                )}
              </chakra.li>
            ))}
          </chakra.ul>
        </Box>
      )}

      {error ? (
        // 取得失敗: errorHints の分類結果から共有イラストを割り当て、再取得導線を
        // 添える (#848)。
        <EmptyState
          illustration={errorIllustration(error)}
          icon="warning"
          title={t("processLoadError", { error })}
          action={{ label: t("processRetry"), onClick: () => void load() }}
        />
      ) : processes.length === 0 && !loading ? (
        // アクティブな接続/クエリが 1 件もない真の空状態: ResultGrid の
        // 「0 行」空状態と同じリッチなイラストで表現する (#847)。
        <EmptyState
          illustration={<NoResultsIllustration />}
          icon="server"
          title={t("processEmpty")}
        />
      ) : processes.length > 0 && processedRows.length === 0 ? (
        <EmptyState
          illustration={<NoResultsIllustration />}
          icon="search"
          title={t("processFilterNoMatch")}
          action={{ label: t("processFilterClear"), onClick: () => setFilter(EMPTY_PROCESS_FILTER) }}
        />
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
              {loading && processes.length === 0 ? (
                // 初回ロード中 (まだ 1 件も取得していない): 裸のヘッダのみ表示を
                // 避け、9 列の構造をシマーで予兆表示する (#846)。
                <SkeletonTableRows columns={9} />
              ) : (
                <LiveRowsPresence>
                  {visibleRows.map((p) => (
                    <ProcessRow
                      key={p.id}
                      sessionId={sessionId}
                      process={p}
                      selected={selected.has(p.id)}
                      highlighted={p.id === highlightId}
                      onToggle={toggleOne}
                      flashCommand={flashToken(p.id, "command")}
                      flashState={flashToken(p.id, "state")}
                      flashTime={flashToken(p.id, "time")}
                      flashQuery={flashToken(p.id, "query")}
                    />
                  ))}
                </LiveRowsPresence>
              )}
            </tbody>
          </chakra.table>
        </Box>
      )}
      {!error && processedRows.length > visibleRows.length && (
        <chakra.p margin={0} textStyle="caption" data-testid="process-truncated">
          {t("processTruncated", { shown: visibleRows.length, total: processedRows.length })}
        </chakra.p>
      )}
        </>
      )}

      {dialog}
    </Box>
  );
}

/** 選択肢に現在値が無ければ足す (空文字は「指定なし」なので足さない)。 */
function withCurrent(options: string[], current: string): string[] {
  return current === "" || options.includes(current)
    ? options
    : [...options, current].sort((a, b) => a.localeCompare(b));
}

/** `ProcessInfo` の全フィールドが同値か (ポーリングごとに配列・オブジェクトは作り直されるため)。 */
function sameProcess(a: ProcessInfo, b: ProcessInfo): boolean {
  if (a === b) return true;
  const ka = Object.keys(a) as (keyof ProcessInfo)[];
  for (const k of ka) if (a[k] !== b[k]) return false;
  return Object.keys(b).length === ka.length;
}

/**
 * プロセス 1 行 (#1321)。ポーリングで内容が変わらなかった行・選択が変わらなかった行は
 * 再レンダーしない。セルは `collapse={false}` の軽量構造で、値が変わったセルだけが
 * フラッシュ用の内側 div を持つ。
 */
const ProcessRow = memo(
  function ProcessRow({
    sessionId,
    process: p,
    selected,
    highlighted,
    onToggle,
    flashCommand,
    flashState,
    flashTime,
    flashQuery,
  }: {
    sessionId: string;
    process: ProcessInfo;
    selected: boolean;
    highlighted: boolean;
    onToggle: (id: number) => void;
    flashCommand: number | null;
    flashState: number | null;
    flashTime: number | null;
    flashQuery: number | null;
  }) {
    const t = useT();
    return (
      <LiveTr highlighted={highlighted} rowId={`process-row-${sessionId}-${p.id}`}>
        <LiveCell css={tdCss} innerCss={cellInnerCss} collapse={false}>
          <Checkbox
            checked={selected}
            aria-label={t("processSelectRow", { id: p.id })}
            onChange={() => onToggle(p.id)}
          />
        </LiveCell>
        <LiveCell css={tdCss} innerCss={cellInnerCss} collapse={false}>
          {p.id}
          {p.is_self && (
            <Tooltip label={t("processSelfBadgeTitle")} focusableWrapper>
              <chakra.span
                marginLeft="1.5"
                px="1.5"
                fontSize="var(--text-xs)"
                fontFamily="var(--font-sans)"
                color="var(--accent)"
                border="1px solid var(--accent)"
                borderRadius="var(--radius-sm)"
              >
                {t("processSelfBadge")}
              </chakra.span>
            </Tooltip>
          )}
        </LiveCell>
        <LiveCell css={tdCss} innerCss={cellInnerCss} collapse={false}>{p.user ?? "–"}</LiveCell>
        <LiveCell css={tdCss} innerCss={cellInnerCss} collapse={false}>{p.host ?? "–"}</LiveCell>
        <LiveCell css={tdCss} innerCss={cellInnerCss} collapse={false}>{p.database ?? "–"}</LiveCell>
        <LiveCell css={tdCss} innerCss={cellInnerCss} collapse={false} flash={flashCommand}>
          {p.command ?? "–"}
        </LiveCell>
        <LiveCell css={tdCss} innerCss={cellInnerCss} collapse={false} flash={flashState}>
          {p.state ?? "–"}
        </LiveCell>
        <LiveCell css={tdCss} innerCss={cellInnerCss} collapse={false} flash={flashTime}>
          {/* 単調な増加は CountUp の補間で「進んでいる」ことを示し、
              巻き戻り (新しい文の開始) だけをフラッシュする。CountUp はこの列だけ。 */}
          {p.time_secs == null || p.time_secs < 0 ? (
            formatProcessTime(p.time_secs)
          ) : (
            <CountUp value={p.time_secs} formatter={formatLiveProcessTime} />
          )}
        </LiveCell>
        <ProcessQueryCell sessionId={sessionId} process={p} flash={flashQuery} />
      </LiveTr>
    );
  },
  (a, b) =>
    a.sessionId === b.sessionId &&
    a.selected === b.selected &&
    a.highlighted === b.highlighted &&
    a.onToggle === b.onToggle &&
    a.flashCommand === b.flashCommand &&
    a.flashState === b.flashState &&
    a.flashTime === b.flashTime &&
    a.flashQuery === b.flashQuery &&
    sameProcess(a.process, b.process),
);

/**
 * クエリ列のセル。一覧が運ぶのは Rust 側で作った 1 行要約だけなので、ツールチップ用の
 * 全文は初めてポインタ / フォーカスが乗ったときに `get_process_query` で id 指定取得し、
 * 要約が変わる (= 別の文に変わった) まで使い回す (#1259)。全文を取れなかった間は要約を
 * そのまま出す。
 */
function ProcessQueryCell({
  sessionId,
  process: p,
  flash,
}: {
  sessionId: string;
  process: ProcessInfo;
  flash: number | null;
}) {
  const summary = p.query_summary ?? "–";
  const [full, setFull] = useState<{ summary: string | null; text: string } | null>(null);
  const inFlight = useRef(false);
  const fetchFull = useCallback(() => {
    if (!p.query_summary || inFlight.current) return;
    if (full && full.summary === p.query_summary) return;
    inFlight.current = true;
    api
      .getProcessQuery(sessionId, p.id)
      .then((text) => {
        if (text) setFull({ summary: p.query_summary, text });
      })
      .catch(() => {})
      .finally(() => {
        inFlight.current = false;
      });
  }, [full, p.id, p.query_summary, sessionId]);
  const cell = (
    <LiveCell
      css={queryTdCss}
      innerCss={queryInnerCss}
      collapse={false}
      flash={flash}
      onMouseEnter={fetchFull}
      onFocus={fetchFull}
    >
      {summary}
    </LiveCell>
  );
  if (!p.query_summary) return cell;
  // 切り詰めていなければ要約 = 全文の 1 行化なので取得せずそのまま出してよい。
  const label = full && full.summary === p.query_summary ? full.text : p.query_summary;
  return <Tooltip label={label}>{cell}</Tooltip>;
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
