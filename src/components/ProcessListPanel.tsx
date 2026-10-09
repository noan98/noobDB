import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useKeepAliveActive, useRefreshOnReactivate } from "./KeepAlive";
import { Box, chakra, Flex, type SystemStyleObject } from "@chakra-ui/react";

import { api, type DriverKind, type ProcessInfo } from "../api/tauri";
import { useT } from "../i18n";
import { semanticColorToken } from "../semanticColors";
import { AUTO_REFRESH_INTERVAL_OPTIONS } from "../settings";
import { COUNT_UP_TOKEN, splitAroundCountUpToken } from "../useCountUp";
import {
  formatProcessTime,
  processKey,
  PROCESS_LIVE_FIELDS,
  pruneSelection,
} from "./processList";
import { CountUp } from "./CountUp";
import { LiveCell, LiveRowsPresence, LiveTr, useLiveChanges } from "./LiveRows";
import { uniqueByKey } from "./liveDiff";
import { ServerMetricsPanel } from "./ServerMetricsPanel";
import { useConfirm } from "./ConfirmDialog";
import { EmptyState } from "./EmptyState";
import { Icon, ICON_SIZES } from "./Icon";
import { errorIllustration, NoResultsIllustration } from "./illustrations";
import { SkeletonTableRows } from "./Skeleton";
import { Spinner } from "./Spinner";
import { Button, Checkbox, Select } from "./ui";
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
}: {
  sessionId: string;
  driver: DriverKind;
  readOnly: boolean;
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

  // ポーリング結果の id 重複を除き (React key の衝突防止)、前回スナップショット
  // との差分から値変化フラッシュの再生キーを得る (#1022)。
  const rows = useMemo(() => uniqueByKey(processes, processKey), [processes]);
  const { flashToken } = useLiveChanges(rows, processKey, PROCESS_LIVE_FIELDS);
  // 件数上限 (#1321): 数千件でも描画コストが頭打ちになるよう、先頭から上限件数だけ描く。
  // 選択・全選択・件数表示は全件 (`rows`) を対象にする。
  const visibleRows = useMemo(
    () => (rows.length > PROCESS_RENDER_LIMIT ? rows.slice(0, PROCESS_RENDER_LIMIT) : rows),
    [rows],
  );

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

  const allSelected = rows.length > 0 && selected.size === rows.length;
  const toggleAll = useCallback(() => {
    setSelected((cur) =>
      cur.size === rows.length
        ? new Set()
        : new Set(rows.map((p) => p.id)),
    );
  }, [rows]);
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
            <chakra.p marginTop="2" marginBottom={0} color={semanticColorToken("danger", "text")} fontWeight={600}>
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
    // バックエンドの 1 コマンドで一括 kill (#1259)。PostgreSQL は 1 文、MySQL は 1 接続上で
    // 順に実行し、失敗があっても残りは続行して件数と最初のエラーを返す。
    let killed = 0;
    let failed = ids.length;
    let firstError: string | null = null;
    try {
      const res = await api.killProcesses(sessionId, ids);
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
      toast.success(t("processKillDone", { count: killed }));
    } else {
      toast.error(
        t("processKillFailed", {
          failed,
          count: ids.length,
          error: firstError ?? "",
        }),
      );
    }
    await load();
  }, [selected, killing, processes, confirm, t, sessionId, toast, load]);

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
      <chakra.p margin={0} fontSize="sm" color="app.textMuted">
        {t("processDesc")}
      </chakra.p>

      <Flex align="center" gap="3" flexWrap="wrap">
        <Tooltip label={readOnly ? t("processReadOnlyHint") : undefined} focusableWrapper={readOnly}>
          <Button
            type="button"
            variant="danger"
            disabled={readOnly || killing || selected.size === 0}
            onClick={() => void killSelected()}
          >
            {t("processKillSelected", { count: selected.size })}
          </Button>
        </Tooltip>
        <Button type="button" onClick={() => void load()} disabled={loading}>
          <Icon name="refresh" size={ICON_SIZES.sm} /> {t("processRefresh")}
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
        <chakra.p margin={0} fontSize="sm" color="app.textMuted">
          {t("processReadOnlyHint")}
        </chakra.p>
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
      {!error && rows.length > visibleRows.length && (
        <chakra.p margin={0} textStyle="caption" data-testid="process-truncated">
          {t("processTruncated", { shown: visibleRows.length, total: rows.length })}
        </chakra.p>
      )}
        </>
      )}

      {dialog}
    </Box>
  );
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
    onToggle,
    flashCommand,
    flashState,
    flashTime,
    flashQuery,
  }: {
    sessionId: string;
    process: ProcessInfo;
    selected: boolean;
    onToggle: (id: number) => void;
    flashCommand: number | null;
    flashState: number | null;
    flashTime: number | null;
    flashQuery: number | null;
  }) {
    const t = useT();
    return (
      <LiveTr>
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
