import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, chakra, Flex, type SystemStyleObject } from "@chakra-ui/react";

import { api, type QueryStatsSupport, type StatementStat } from "../api/tauri";
import { useT } from "../i18n";
import { semanticColorToken, semanticColorVar } from "../semanticColors";
import {
  INSPECTOR_INTERVAL_OPTIONS,
  setInspectorNPlusOneMinCount,
  setInspectorNPlusOneWindowMs,
  setInspectorPollIntervalSecs,
  useSettings,
} from "../settings";
import { copyToClipboard } from "./clipboard";
import { EmptyState } from "./EmptyState";
import { errorIllustration } from "./illustrations";
import { Icon, ICON_SIZES } from "./Icon";
import {
  computeStatDelta,
  detectNPlusOne,
  filterLiveTail,
  formatMs,
  isPrivilegeMasked,
  mergeLiveTail,
  nPlusOneFromRate,
  supportReasonI18nKey,
  type LiveTailEntry,
  type NPlusOneOptions,
} from "./queryInspector";
import { Spinner } from "./Spinner";
import { Button, Checkbox, Heading, Input, Select } from "./ui";
import { useToast } from "./Toast";
import { Tooltip } from "./Tooltip";

/**
 * ライブクエリ・インスペクタ (#746): 接続先 DB で「アプリ (ORM) が投げている
 * クエリ」を観測する内蔵クエリ APM。
 *
 * - **ライブテール**: 記録中、サーバの統計ビュー (MySQL performance_schema /
 *   PostgreSQL pg_stat_activity) をポーリングし、実行中/直近のクエリを時系列に
 *   流す。自セッション・noobDB 内部クエリはバックエンドで除外済み。
 * - **フィンガープリント集計**: 同型クエリ (digest) 単位の実行回数/平均・最悪
 *   レイテンシ/総時間/行数を「記録開始時点からの差分」でランキング表示する。
 *   差分計算は `queryInspector.ts` の純ロジック。
 * - **N+1 検出**: 短時間に大量発行される同型クエリを決定的ルールでフラグする。
 *   閾値 (回数/時間窓) は設定として永続化。
 *
 * 負荷面の設計: すべて読み取り SELECT のポーリングで、**記録中のみ**動き
 * パネルを閉じる (アンマウント) と完全に停止する。in-flight ガードで低速接続でも
 * リクエストは積み重ならない。収集データは在メモリのみで永続化しない。
 * 前提が無い環境 (pg_stat_statements 未導入 / performance_schema 無効 / 権限
 * 不足) では理由と有効化手順を表示して縮退する (#587 の教訓: 黙って空にしない)。
 */

const thCss: SystemStyleObject = {
  position: "sticky",
  top: 0,
  zIndex: 1,
  background: "var(--bg-muted)",
  borderBottom: "1px solid var(--border)",
  padding: "6px 10px",
  textAlign: "left",
  textStyle: "overline",
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
const numTdCss: SystemStyleObject = { ...tdCss, textAlign: "right" };
const queryTdCss: SystemStyleObject = {
  ...tdCss,
  whiteSpace: "normal",
  wordBreak: "break-all",
  color: "var(--text-secondary)",
  maxWidth: "640px",
};

/** 1 行要約 (processList.summarizeQuery と同じ規約だが依存を作らずローカルに持つ)。 */
function oneLine(query: string, max = 300): string {
  const s = query.split(/\s+/).filter(Boolean).join(" ");
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function NPlusOneBadge({ title }: { title: string }) {
  return (
    <Tooltip label={title} focusableWrapper>
      <chakra.span
        marginLeft="1.5"
        px="1.5"
        fontFamily="var(--font-sans)"
        textStyle="overline"
        color={semanticColorToken("danger", "text")}
        border={`1px solid ${semanticColorVar("danger", "text")}`}
        borderRadius="var(--radius-sm)"
        whiteSpace="nowrap"
      >
        N+1
      </chakra.span>
    </Tooltip>
  );
}

export function QueryInspectorPanel({
  sessionId,
  driver,
  onClose,
}: {
  sessionId: string;
  driver: string;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const settings = useSettings();

  const [support, setSupport] = useState<QueryStatsSupport | null>(null);
  const [supportError, setSupportError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [tab, setTab] = useState<"tail" | "stats">("tail");
  const [tail, setTail] = useState<LiveTailEntry[]>([]);
  const [baseline, setBaseline] = useState<StatementStat[]>([]);
  const [baselineAt, setBaselineAt] = useState<number | null>(null);
  const [stats, setStats] = useState<StatementStat[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sampledAt, setSampledAt] = useState<Date | null>(null);
  const [filterText, setFilterText] = useState("");
  const [minDurationInput, setMinDurationInput] = useState("");
  const [showCumulative, setShowCumulative] = useState(false);
  // 直前スナップショット (digest レートで N+1 目安を出すために保持)。
  const prevStatsRef = useRef<{ stats: StatementStat[]; at: number } | null>(null);
  const [rateFlagged, setRateFlagged] = useState<Set<string>>(new Set());
  const busyRef = useRef(false);
  // 前提可否プローブのリクエスト世代カウンタ (再取得ボタンでの再実行時、旧要求の
  // 応答が後から返ってきても上書きしないようにする。#848)。
  const probeSeqRef = useRef(0);

  const nPlusOneOpts: NPlusOneOptions = useMemo(
    () => ({
      minCount: settings.inspectorNPlusOneMinCount,
      windowMs: settings.inspectorNPlusOneWindowMs,
    }),
    [settings.inspectorNPlusOneMinCount, settings.inspectorNPlusOneWindowMs],
  );

  // 前提可否のプローブ。セッション切替時、および取得失敗時の再取得ボタンから
  // 呼び出される (#848)。世代カウンタで、古い呼び出しの応答が後から返っても
  // 最新の状態を上書きしないようにする (useEffect の cancelled フラグと同じ意図)。
  const probeSupport = useCallback(() => {
    const seq = ++probeSeqRef.current;
    setSupport(null);
    setSupportError(null);
    setRecording(false);
    setTail([]);
    setBaseline([]);
    setBaselineAt(null);
    setStats([]);
    prevStatsRef.current = null;
    setRateFlagged(new Set());
    api
      .queryStatsSupport(sessionId)
      .then((s) => {
        if (seq === probeSeqRef.current) setSupport(s);
      })
      .catch((e) => {
        if (seq === probeSeqRef.current) setSupportError(String(e));
      });
  }, [sessionId]);

  useEffect(() => {
    probeSupport();
  }, [probeSupport]);

  // support 確定時、利用不可のタブに留まっていたら利用可能な方へ自動で寄せる
  // (例: MySQL で events_statements consumer が無効だが digest は有効な縮退環境
  // では既定タブ "tail" が空表示になるため)。
  useEffect(() => {
    if (!support) return;
    if (tab === "tail" && !support.live_tail && support.statements) setTab("stats");
    else if (tab === "stats" && !support.statements && support.live_tail) setTab("tail");
  }, [support, tab]);

  // ポーリング 1 ティック: ライブテール → digest スナップショットの順に取得する。
  // busyRef で前回のティックが終わるまでスキップ (SSH トンネル等の低速経路対策)。
  const tick = useCallback(async () => {
    if (busyRef.current || !support) return;
    busyRef.current = true;
    try {
      if (support.live_tail) {
        const sample = await api.sampleLiveQueries(sessionId);
        const now = Date.now();
        setTail((cur) => mergeLiveTail(cur, sample, now));
      }
      if (support.statements) {
        const snapshot = await api.sampleStatementStats(sessionId);
        const now = Date.now();
        const prev = prevStatsRef.current;
        if (prev && now > prev.at) {
          // 直近ポーリング間隔の差分レートで N+1 目安をフラグする。
          const recent = computeStatDelta(prev.stats, snapshot);
          const flagged = new Set(
            recent
              .filter((r) => nPlusOneFromRate(r.calls, now - prev.at, nPlusOneOpts))
              .map((r) => `${r.digest} ${r.database ?? ""}`),
          );
          setRateFlagged(flagged);
        }
        prevStatsRef.current = { stats: snapshot, at: now };
        setStats(snapshot);
      }
      setError(null);
      setSampledAt(new Date());
    } catch (e) {
      setError(String(e));
    } finally {
      busyRef.current = false;
    }
  }, [sessionId, support, nPlusOneOpts]);

  const startRecording = useCallback(async () => {
    if (!support || recording) return;
    setTail([]);
    setStats([]);
    setError(null);
    prevStatsRef.current = null;
    setRateFlagged(new Set());
    // 差分表示の基準となる記録開始時点のスナップショットを先に取る。
    if (support.statements) {
      try {
        const snapshot = await api.sampleStatementStats(sessionId);
        setBaseline(snapshot);
        prevStatsRef.current = { stats: snapshot, at: Date.now() };
      } catch (e) {
        setBaseline([]);
        setError(String(e));
      }
    } else {
      setBaseline([]);
    }
    setBaselineAt(Date.now());
    setRecording(true);
  }, [support, recording, sessionId]);

  const stopRecording = useCallback(() => setRecording(false), []);

  // 記録中のみポーリングする。停止/アンマウントで interval は必ず破棄され、
  // サーバへの問い合わせは完全に止まる (#746 受け入れ条件)。
  useEffect(() => {
    if (!recording) return;
    void tick();
    const handle = setInterval(() => {
      void tick();
    }, settings.inspectorPollIntervalSecs * 1000);
    return () => clearInterval(handle);
  }, [recording, settings.inspectorPollIntervalSecs, tick]);

  // ライブテールの N+1 判定 (観測時刻ベースのスライディングウィンドウ)。
  const tailFindings = useMemo(
    () =>
      new Map(
        detectNPlusOne(
          tail.map((e) => ({ fingerprint: e.fingerprint, observedAtMs: e.observedAtMs })),
          nPlusOneOpts,
        ).map((f) => [f.fingerprint, f]),
      ),
    [tail, nPlusOneOpts],
  );

  const minDurationMs = useMemo(() => {
    const n = Number(minDurationInput);
    return minDurationInput.trim() !== "" && Number.isFinite(n) && n > 0 ? n : null;
  }, [minDurationInput]);

  const visibleTail = useMemo(
    () => filterLiveTail(tail, { text: filterText, minDurationMs }),
    [tail, filterText, minDurationMs],
  );

  const maskedCount = useMemo(
    () => tail.filter((e) => isPrivilegeMasked(e.query)).length,
    [tail],
  );

  const deltaRows = useMemo(
    () => computeStatDelta(showCumulative ? [] : baseline, stats),
    [showCumulative, baseline, stats],
  );

  const copySql = useCallback(
    async (sql: string) => {
      const ok = await copyToClipboard(sql);
      if (ok) toast.success(t("inspectorCopied"));
      else toast.error(t("inspectorCopyFailed"));
    },
    [toast, t],
  );

  const reasonText = (code: string | null) =>
    code == null ? null : t(supportReasonI18nKey(code));

  const liveTailFinding = (fingerprint: string) => tailFindings.get(fingerprint);

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
        <Heading>{t("inspectorTitle")}</Heading>
        <Tooltip label={t("inspectorClose")}>
          <Button
            minWidth="28px"
            px="2"
            py="1"
            fontSize="base"
            lineHeight={1}
            onClick={onClose}
            aria-label={t("inspectorClose")}
          >
            <Icon name="close" size={ICON_SIZES.sm} />
          </Button>
        </Tooltip>
      </chakra.header>

      <chakra.p margin={0} fontSize="sm" color="app.textMuted">
        {t("inspectorDesc")}
      </chakra.p>

      {supportError && (
        // 前提可否プローブの失敗: 以降のパネル内容が一切表示できないため、
        // 全体を置き換えるリッチな EmptyState + 再取得導線にする (#848)。
        <EmptyState
          illustration={errorIllustration(supportError)}
          icon="warning"
          title={t("inspectorLoadError", { error: supportError })}
          action={{ label: t("inspectorRetry"), onClick: () => probeSupport() }}
        />
      )}
      {support == null && supportError == null && <Spinner size={14} />}

      {support && (
        <>
          {/* 前提が無い機能は理由 + 有効化手順を明示して縮退する (#587)。 */}
          {!support.live_tail && support.live_tail_reason && (
            <chakra.p margin={0} fontSize="sm" color={semanticColorToken("warning", "text")}>
              {t("inspectorTailDegraded", {
                reason: reasonText(support.live_tail_reason) ?? support.live_tail_reason,
              })}
            </chakra.p>
          )}
          {!support.statements && support.statements_reason && (
            <chakra.p margin={0} fontSize="sm" color={semanticColorToken("warning", "text")}>
              {t("inspectorStatsDegraded", {
                reason: reasonText(support.statements_reason) ?? support.statements_reason,
              })}
            </chakra.p>
          )}

          <Flex align="center" gap="3" flexWrap="wrap">
            {recording ? (
              <Button type="button" variant="danger" onClick={stopRecording}>
                {t("inspectorStop")}
              </Button>
            ) : (
              <Tooltip
                label={
                  !support.live_tail && !support.statements ? t("inspectorUnavailable") : undefined
                }
                focusableWrapper={!support.live_tail && !support.statements}
              >
                <Button
                  type="button"
                  variant="primary"
                  disabled={!support.live_tail && !support.statements}
                  onClick={() => void startRecording()}
                >
                  {t("inspectorStart")}
                </Button>
              </Tooltip>
            )}
            <chakra.label
              display="inline-flex"
              alignItems="center"
              gap="1.5"
              fontSize="sm"
              color="app.textSecondary"
            >
              {t("inspectorIntervalLabel")}
              <Select
                aria-label={t("inspectorIntervalAria")}
                value={String(settings.inspectorPollIntervalSecs)}
                onChange={(e) => setInspectorPollIntervalSecs(Number(e.target.value))}
                width="auto"
              >
                {INSPECTOR_INTERVAL_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {t("inspectorIntervalSecs", { secs: s })}
                  </option>
                ))}
              </Select>
            </chakra.label>
            {recording && <Spinner size={14} />}
            {sampledAt && (
              <chakra.span fontSize="xs" color="app.textMuted">
                {t("inspectorSampledAt", { time: sampledAt.toLocaleTimeString() })}
              </chakra.span>
            )}
            {recording && (
              <chakra.span textStyle="overline" color={semanticColorToken("danger", "text")}>
                {t("inspectorRecordingBadge")}
              </chakra.span>
            )}
          </Flex>

          <Flex align="center" gap="3" flexWrap="wrap" fontSize="sm">
            <chakra.label display="inline-flex" alignItems="center" gap="1.5" color="app.textSecondary">
              {t("inspectorNPlusOneCountLabel")}
              <Input
                type="number"
                width="72px"
                min={2}
                value={String(settings.inspectorNPlusOneMinCount)}
                aria-label={t("inspectorNPlusOneCountLabel")}
                onChange={(e) => setInspectorNPlusOneMinCount(Number(e.target.value))}
              />
            </chakra.label>
            <chakra.label display="inline-flex" alignItems="center" gap="1.5" color="app.textSecondary">
              {t("inspectorNPlusOneWindowLabel")}
              <Input
                type="number"
                width="88px"
                min={100}
                step={100}
                value={String(settings.inspectorNPlusOneWindowMs)}
                aria-label={t("inspectorNPlusOneWindowLabel")}
                onChange={(e) => setInspectorNPlusOneWindowMs(Number(e.target.value))}
              />
            </chakra.label>
            <chakra.span fontSize="xs" color="app.textMuted">
              {t("inspectorMemoryNote")}
            </chakra.span>
          </Flex>

          {error && (
            // ポーリング中の取得失敗: 記録・タブ等の操作 UI は引き続き表示するため、
            // 全体を置き換えない compact な EmptyState + 再取得導線で通知する (#848)。
            <EmptyState
              compact
              illustration={errorIllustration(error)}
              icon="warning"
              title={t("inspectorLoadError", { error })}
              action={{ label: t("inspectorRetry"), onClick: () => void tick() }}
            />
          )}

          <Flex gap="2" borderBottom="1px solid" borderColor="app.border">
            <Button
              type="button"
              variant={tab === "tail" ? "primary" : undefined}
              disabled={!support.live_tail}
              onClick={() => setTab("tail")}
            >
              {t("inspectorTabTail")}
            </Button>
            <Button
              type="button"
              variant={tab === "stats" ? "primary" : undefined}
              disabled={!support.statements}
              onClick={() => setTab("stats")}
            >
              {t("inspectorTabStats")}
            </Button>
          </Flex>

          {tab === "tail" && support.live_tail && (
            <>
              <Flex align="center" gap="3" flexWrap="wrap">
                <Input
                  width="260px"
                  placeholder={t("inspectorFilterPlaceholder")}
                  aria-label={t("inspectorFilterPlaceholder")}
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                />
                <chakra.label display="inline-flex" alignItems="center" gap="1.5" fontSize="sm" color="app.textSecondary">
                  {t("inspectorMinDurationLabel")}
                  <Input
                    type="number"
                    width="88px"
                    min={0}
                    placeholder="0"
                    aria-label={t("inspectorMinDurationLabel")}
                    value={minDurationInput}
                    onChange={(e) => setMinDurationInput(e.target.value)}
                  />
                </chakra.label>
                <chakra.span fontSize="xs" color="app.textMuted">
                  {t("inspectorTailCount", { shown: visibleTail.length, total: tail.length })}
                </chakra.span>
              </Flex>
              {maskedCount > 0 && (
                <chakra.p margin={0} fontSize="sm" color={semanticColorToken("warning", "text")}>
                  {t("inspectorPrivilegeNote", { count: maskedCount })}
                </chakra.p>
              )}
              {tail.length === 0 ? (
                // 記録前 (idle) と記録中だが未観測の 2 状態を、compact な
                // EmptyState 1 つで表現する。record 中は「観測待ち」、idle は
                // 「開始待ち」の意味合いでアイコンを変える (#847)。
                <EmptyState
                  compact
                  icon={recording ? "clock" : "query"}
                  title={recording ? t("inspectorTailEmpty") : t("inspectorTailIdle")}
                />
              ) : (
                <Box overflowX="auto">
                  <chakra.table width="100%" borderCollapse="collapse">
                    <thead>
                      <tr>
                        <chakra.th css={thCss}>{t("inspectorColObserved")}</chakra.th>
                        <chakra.th css={thCss}>{t("inspectorColSource")}</chakra.th>
                        <chakra.th css={thCss}>{t("inspectorColDb")}</chakra.th>
                        <chakra.th css={thCss}>{t("inspectorColDuration")}</chakra.th>
                        {driver === "mysql" && (
                          <chakra.th css={thCss}>{t("inspectorColRowsExamined")}</chakra.th>
                        )}
                        <chakra.th css={thCss}>{t("inspectorColQuery")}</chakra.th>
                        <chakra.th css={thCss} width="32px" aria-label={t("inspectorColActions")} />
                      </tr>
                    </thead>
                    <tbody>
                      {visibleTail.map((e) => {
                        const finding = liveTailFinding(e.fingerprint);
                        return (
                          <tr key={e.key}>
                            <chakra.td css={tdCss}>
                              {new Date(e.observedAtMs).toLocaleTimeString()}
                              {e.running && (
                                <Tooltip label={t("inspectorRunningTitle")} focusableWrapper>
                                  <chakra.span marginLeft="1.5" color="var(--accent)">
                                    ▶
                                  </chakra.span>
                                </Tooltip>
                              )}
                            </chakra.td>
                            <chakra.td css={tdCss}>
                              {[e.user, e.application || e.host]
                                .filter(Boolean)
                                .join("@") || "–"}
                            </chakra.td>
                            <chakra.td css={tdCss}>{e.database ?? "–"}</chakra.td>
                            <chakra.td css={numTdCss}>{formatMs(e.duration_ms)}</chakra.td>
                            {driver === "mysql" && (
                              <chakra.td css={numTdCss}>{e.rows_examined ?? "–"}</chakra.td>
                            )}
                            <Tooltip label={e.query}>
                              <chakra.td css={queryTdCss}>
                                {oneLine(e.query)}
                                {finding && (
                                  <NPlusOneBadge
                                    title={t("inspectorNPlusOneExplain", {
                                      count: finding.count,
                                      windowMs: finding.windowMs,
                                    })}
                                  />
                                )}
                              </chakra.td>
                            </Tooltip>
                            <chakra.td css={tdCss}>
                              <Tooltip label={t("inspectorCopySql")}>
                                <Button
                                  minWidth="24px"
                                  px="1.5"
                                  py="0.5"
                                  onClick={() => void copySql(e.query)}
                                  aria-label={t("inspectorCopySql")}
                                >
                                  <Icon name="copy" size={ICON_SIZES.sm} />
                                </Button>
                              </Tooltip>
                            </chakra.td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </chakra.table>
                </Box>
              )}
            </>
          )}

          {tab === "stats" && support.statements && (
            <>
              <Flex align="center" gap="3" flexWrap="wrap">
                <chakra.label display="inline-flex" alignItems="center" gap="1.5" fontSize="sm" color="app.textSecondary">
                  <Checkbox
                    checked={showCumulative}
                    aria-label={t("inspectorCumulativeLabel")}
                    onChange={(e) => setShowCumulative(e.target.checked)}
                  />
                  {t("inspectorCumulativeLabel")}
                </chakra.label>
                {!showCumulative && baselineAt != null && (
                  <chakra.span fontSize="xs" color="app.textMuted">
                    {t("inspectorBaselineAt", {
                      time: new Date(baselineAt).toLocaleTimeString(),
                    })}
                  </chakra.span>
                )}
              </Flex>
              {deltaRows.length === 0 ? (
                // tail タブと同じ idle/recording の 2 状態表現 (#847)。
                <EmptyState
                  compact
                  icon={recording ? "hash" : "query"}
                  title={recording ? t("inspectorStatsEmpty") : t("inspectorStatsIdle")}
                />
              ) : (
                <Box overflowX="auto">
                  <chakra.table width="100%" borderCollapse="collapse">
                    <thead>
                      <tr>
                        <chakra.th css={thCss}>{t("inspectorColCalls")}</chakra.th>
                        <chakra.th css={thCss}>{t("inspectorColTotalTime")}</chakra.th>
                        <chakra.th css={thCss}>{t("inspectorColMeanTime")}</chakra.th>
                        <Tooltip label={t("inspectorMaxCumulativeTitle")} focusableWrapper>
                          <chakra.th css={thCss}>{t("inspectorColMaxTime")}</chakra.th>
                        </Tooltip>
                        <chakra.th css={thCss}>
                          {driver === "mysql"
                            ? t("inspectorColRowsExamined")
                            : t("inspectorColRows")}
                        </chakra.th>
                        <chakra.th css={thCss}>{t("inspectorColDb")}</chakra.th>
                        <chakra.th css={thCss}>{t("inspectorColFingerprint")}</chakra.th>
                        <chakra.th css={thCss} width="32px" aria-label={t("inspectorColActions")} />
                      </tr>
                    </thead>
                    <tbody>
                      {deltaRows.map((r) => (
                        <tr key={`${r.digest} ${r.database ?? ""}`}>
                          <chakra.td css={numTdCss}>{r.calls}</chakra.td>
                          <chakra.td css={numTdCss}>{formatMs(r.totalTimeMs)}</chakra.td>
                          <chakra.td css={numTdCss}>{formatMs(r.meanTimeMs)}</chakra.td>
                          <chakra.td css={numTdCss}>{formatMs(r.maxTimeMs)}</chakra.td>
                          <chakra.td css={numTdCss}>{r.rows ?? "–"}</chakra.td>
                          <chakra.td css={tdCss}>{r.database ?? "–"}</chakra.td>
                          <Tooltip label={r.fingerprint}>
                            <chakra.td css={queryTdCss}>
                              {oneLine(r.fingerprint)}
                              {rateFlagged.has(`${r.digest} ${r.database ?? ""}`) && (
                                <NPlusOneBadge
                                  title={t("inspectorNPlusOneRateExplain", {
                                    windowMs: settings.inspectorNPlusOneWindowMs,
                                  })}
                                />
                              )}
                            </chakra.td>
                          </Tooltip>
                          <chakra.td css={tdCss}>
                            <Tooltip label={t("inspectorCopySql")}>
                              <Button
                                minWidth="24px"
                                px="1.5"
                                py="0.5"
                                onClick={() => void copySql(r.fingerprint)}
                                aria-label={t("inspectorCopySql")}
                              >
                                <Icon name="copy" size={ICON_SIZES.sm} />
                              </Button>
                            </Tooltip>
                          </chakra.td>
                        </tr>
                      ))}
                    </tbody>
                  </chakra.table>
                </Box>
              )}
            </>
          )}
        </>
      )}
    </Box>
  );
}
