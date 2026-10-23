import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useKeepAliveActive, useRefreshOnReactivate } from "./KeepAlive";
import { Box, chakra, Flex } from "@chakra-ui/react";

import { api, type DriverKind } from "../api/tauri";
import { useT, type I18nKey } from "../i18n";
import { AUTO_REFRESH_INTERVAL_OPTIONS, useSettings } from "../settings";
import { categoricalColor, useIsDarkTheme } from "../colorScale";
import { niceTicks } from "./chartData";
import {
  connectionHeadroom,
  DEFAULT_METRICS_WINDOW_SECS,
  deriveSeries,
  extractSeries,
  formatCount,
  formatRate,
  hasSeriesData,
  METRICS_CSV_HEADER,
  METRICS_WINDOW_OPTIONS_SECS,
  metricsToCsvRows,
  pushSample,
  throughputUnitKey,
  windowSamples,
  type MetricPoint,
  type MetricSample,
  type MetricSeriesKey,
} from "./serverMetrics";
import { StatTile, type StatDeltaGood } from "./StatTile";
import { LATENCY_HISTORY_MAX } from "./connectionHealth";
import { Button, Checkbox, Heading, Select } from "./ui";
import { Icon, ICON_SIZES } from "./Icon";
import { Tooltip } from "./Tooltip";
import { CountUp } from "./CountUp";
import { EmptyState } from "./EmptyState";
import { errorIllustration } from "./illustrations";
import { Callout } from "./Callout";
import { Skeleton } from "./Skeleton";
import { TextExportButton } from "./TextExportButton";
import { tableToCsv } from "./tabularText";
import { Spinner } from "./Spinner";

/**
 * サーバ監視ダッシュボード (#731)。`api.serverMetrics` を一定間隔でポーリングし、
 * 在メモリのリングバッファ (`serverMetrics.ts`) に直近 N 分を蓄積して、接続数 /
 * スループット (QPS/TPS) / ロック待ちの時系列を折れ線で描く。時系列の保持は在メモリ
 * のみで新規ストレージは増やさない。差分 → レート変換とバッファ管理の純ロジックは
 * `serverMetrics.ts` に切り出して Vitest 済み。
 *
 * ライフサイクル: このパネルがマウントされている間だけポーリングし、アンマウント
 * (タブ切替 or プロセスモニタを閉じる) で `clearInterval` により停止するため、接続への
 * 負荷を残さない (`ProcessListPanel` と同じ setInterval + cleanup 方式)。
 *
 * ドライバ差の吸収: 取得できない系列は `null` としてバックエンドが返し、`extractSeries`
 * が落とすので、PostgreSQL のスロークエリ/ロック累積 (非対応) やゲージが空のチャートは
 * 「データなし」の空状態に自然に縮退する。SQLite はサーバを持たず、そもそも呼び出し側
 * (`ProcessListPanel`) がメトリクスタブを出さない。
 */

// 折れ線チャート 1 枚の SVG 座標系。ChartView と同じく viewBox 上で計算し、軸/グリッド
// は CSS 変数でテーマ追従、系列色は可視化共通のカテゴリスケール (colorScale) を参照する。
const CHART_W = 760;
/** バッファに保持する期間 (選べる最長)。 */
const BUFFER_WINDOW_MS = Math.max(...METRICS_WINDOW_OPTIONS_SECS) * 1000;

const CHART_H = 200;
const PAD = { left: 48, right: 14, top: 12, bottom: 26 };
const PLOT_W = CHART_W - PAD.left - PAD.right;
const PLOT_H = CHART_H - PAD.top - PAD.bottom;

interface SeriesDef {
  key: MetricSeriesKey;
  labelKey: I18nKey;
  /** カテゴリスケール上のインデックス (系列色)。 */
  colorIndex: number;
}

/** 1 枚のチャートカードの定義 (タイトル + 単位ラベル + 系列群)。 */
interface ChartDef {
  titleKey: I18nKey;
  /** 縦軸の単位ラベル (i18n キー)。QPS/TPS はドライバで切替のため関数で解決。 */
  unitKey: I18nKey;
  series: SeriesDef[];
}

// チャート構成は静的 (系列キー・色・i18n ラベルキーのみ)。再レンダーごとの再生成を
// 避けるためモジュールスコープに置く。スループットの単位ラベルはドライバで切り替える
// ため、描画時に `throughputUnitKey` で上書きする。
const CHARTS: ChartDef[] = [
  {
    titleKey: "metricsChartConnections",
    unitKey: "metricsCountUnit",
    series: [
      { key: "connections", labelKey: "metricsSeriesConnections", colorIndex: 0 },
      { key: "active", labelKey: "metricsSeriesActive", colorIndex: 1 },
      { key: "idleInTransaction", labelKey: "metricsSeriesIdleInTx", colorIndex: 2 },
      { key: "lockWaiting", labelKey: "metricsSeriesLockWaiting", colorIndex: 3 },
    ],
  },
  {
    titleKey: "metricsChartThroughput",
    unitKey: "metricsQpsUnit",
    series: [{ key: "queryRate", labelKey: "metricsSeriesThroughput", colorIndex: 4 }],
  },
  {
    titleKey: "metricsChartProblems",
    unitKey: "metricsPerSecUnit",
    series: [
      { key: "lockWaitRate", labelKey: "metricsSeriesLockWaitRate", colorIndex: 3 },
      { key: "slowQueryRate", labelKey: "metricsSeriesSlowQueryRate", colorIndex: 5 },
    ],
  },
];

/** 先頭に並べる要約タイル (#1833)。各系列の最新値・前回比・直近の推移を一目で見せる。 */
const SUMMARY_TILES: readonly { key: MetricSeriesKey; labelKey: I18nKey; goodWhen: StatDeltaGood }[] = [
  { key: "connections", labelKey: "metricsSeriesConnections", goodWhen: "neutral" },
  { key: "lockWaiting", labelKey: "metricsSeriesLockWaiting", goodWhen: "down" },
  { key: "queryRate", labelKey: "metricsSeriesThroughput", goodWhen: "neutral" },
  { key: "slowQueryRate", labelKey: "metricsSeriesSlowQueryRate", goodWhen: "down" },
];

function MetricSummaryTiles({ points }: { points: MetricPoint[] }) {
  const t = useT();
  const tiles = SUMMARY_TILES.flatMap((def) => {
    const values = extractSeries(points, def.key).map((p) => p.value);
    if (values.length === 0) return [];
    const latest = values[values.length - 1];
    const isRate = def.key.endsWith("Rate");
    return [
      <StatTile
        key={def.key}
        label={t(def.labelKey)}
        value={latest}
        formatter={isRate ? formatRate : formatCount}
        delta={values.length >= 2 ? latest - values[values.length - 2] : null}
        goodWhen={def.goodWhen}
        trend={values.slice(-LATENCY_HISTORY_MAX)}
      />,
    ];
  });
  if (tiles.length === 0) return null;
  return (
    <Flex gap="2" flexWrap="wrap" data-testid="metrics-summary-tiles">
      {tiles}
    </Flex>
  );
}

function timeLabel(atMs: number): string {
  return new Date(atMs).toLocaleTimeString();
}

/**
 * 折れ線チャート 1 枚。指定系列を `extractSeries` で取り出し、共通の時間軸 (全系列の
 * min/max 時刻) と 0 起点の値軸で描く。データのある系列が 1 つも無ければ空状態を出す。
 */
function MetricChart({
  points,
  def,
  unitLabel,
}: {
  points: MetricPoint[];
  def: ChartDef;
  unitLabel: string;
}) {
  const t = useT();
  // ダークテーマではコントラストを確保した並行パレットへ切り替える (#1187)。
  const isDark = useIsDarkTheme();
  const keys = def.series.map((s) => s.key);
  const hasData = hasSeriesData(points, keys);

  // 時間ドメイン: 全系列共通に、リングバッファの端から端まで。
  const [t0, t1] = useMemo(() => {
    const times = points.map((p) => p.atMs);
    if (times.length === 0) return [0, 1];
    const lo = Math.min(...times);
    const hi = Math.max(...times);
    return lo === hi ? [lo - 1000, hi + 1000] : [lo, hi];
  }, [points]);

  // 値ドメイン: 0 起点。全系列の最大値から nice な上限を決める。
  const seriesData = useMemo(
    () => def.series.map((s) => ({ ...s, pts: extractSeries(points, s.key) })),
    [def.series, points],
  );
  const yMax = useMemo(() => {
    let m = 0;
    for (const s of seriesData) for (const p of s.pts) if (p.value > m) m = p.value;
    return m;
  }, [seriesData]);
  const yTicks = useMemo(() => niceTicks(0, yMax > 0 ? yMax : 1), [yMax]);
  const yTop = Math.max(yMax, yTicks[yTicks.length - 1] ?? 1, 1);

  const xAt = (atMs: number) => PAD.left + ((atMs - t0) / (t1 - t0)) * PLOT_W;
  const yAt = (v: number) => PAD.top + PLOT_H - (v / yTop) * PLOT_H;

  return (
    <Box
      borderWidth="1px"
      borderColor="app.border"
      borderRadius="md"
      p="3"
      bg="app.surface"
      shadow="elevationRaised"
    >
      <Flex align="baseline" justify="space-between" gap="2" mb="1.5" flexWrap="wrap">
        <Heading as="h3" role="subheading">
          {t(def.titleKey)}
        </Heading>
        <chakra.span fontSize="xs" color="app.textMuted">
          {unitLabel}
        </chakra.span>
      </Flex>

      {/* 凡例 + 現在値。 */}
      <Flex gap="3.5" flexWrap="wrap" mb="1.5">
        {def.series.map((s) => {
          const pts = extractSeries(points, s.key);
          const latest = pts.length > 0 ? pts[pts.length - 1].value : null;
          const isRate = s.key.endsWith("Rate");
          return (
            <Flex key={s.key} align="center" gap="1" fontSize="xs" color="app.textSecondary">
              <chakra.span
                display="inline-block"
                width="10px"
                height="10px"
                borderRadius="xs"
                style={{ background: categoricalColor(s.colorIndex, isDark) }}
              />
              {t(s.labelKey)}
              <chakra.span fontFamily="var(--font-mono)" textStyle="numeric" color="app.text">
                {latest == null ? (
                  isRate ? (
                    formatRate(latest)
                  ) : (
                    formatCount(latest)
                  )
                ) : (
                  <CountUp value={latest} formatter={isRate ? formatRate : formatCount} />
                )}
              </chakra.span>
            </Flex>
          );
        })}
      </Flex>

      {hasData ? (
        <chakra.svg
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          width="100%"
          height="auto"
          role="img"
          aria-label={t(def.titleKey)}
          preserveAspectRatio="none"
        >
          {/* 横グリッド + 値軸ラベル。 */}
          {yTicks.map((tick) => {
            const y = yAt(tick);
            return (
              <g key={tick}>
                <line
                  x1={PAD.left}
                  y1={y}
                  x2={CHART_W - PAD.right}
                  y2={y}
                  stroke="var(--border)"
                  strokeWidth={1}
                />
                <text
                  x={PAD.left - 6}
                  y={y + 3}
                  textAnchor="end"
                  style={{ fontSize: "var(--text-2xs)" }}
                  fill="var(--text-muted)"
                >
                  {tick}
                </text>
              </g>
            );
          })}
          {/* 時間軸ラベル (両端)。 */}
          <text
            x={PAD.left}
            y={CHART_H - 8}
            textAnchor="start"
            style={{ fontSize: "var(--text-2xs)" }}
            fill="var(--text-muted)"
          >
            {timeLabel(t0)}
          </text>
          <text
            x={CHART_W - PAD.right}
            y={CHART_H - 8}
            textAnchor="end"
            style={{ fontSize: "var(--text-2xs)" }}
            fill="var(--text-muted)"
          >
            {timeLabel(t1)}
          </text>
          {/* 系列の折れ線。 */}
          {seriesData.map((s) => {
            if (s.pts.length === 0) return null;
            const d = s.pts.map((p) => `${xAt(p.atMs)},${yAt(p.value)}`).join(" ");
            const color = categoricalColor(s.colorIndex, isDark);
            return (
              <g key={s.key}>
                {s.pts.length === 1 ? (
                  <circle cx={xAt(s.pts[0].atMs)} cy={yAt(s.pts[0].value)} r={2.5} fill={color} />
                ) : (
                  <polyline points={d} fill="none" stroke={color} strokeWidth={1.75} />
                )}
              </g>
            );
          })}
        </chakra.svg>
      ) : (
        // 未報告/未対応の系列 (ドライバ差 or 初回サンプル未取得):
        // 「データなし」系の軽量アイコンを compact で割り当てる (#847)。
        <EmptyState compact icon="chart" title={t("metricsNoSeriesData")} />
      )}
    </Box>
  );
}

/**
 * `MetricChart` 1 枚分のロード中プレースホルダ (#846)。初回サンプル取得が
 * 終わるまでは `hasSeriesData` が常に false になり本来の「データなし」空状態
 * (`metricsNoSeriesData`) と見分けが付かないため、初回ロード中に限りタイトル/
 * 凡例/チャート領域の構造をシマーで予兆表示する。ロード状態の ARIA 告知は
 * ツールバーの `Spinner` (role="status") が担うため、ここは `aria-hidden`。
 */
function MetricChartSkeleton({ def }: { def: ChartDef }) {
  const t = useT();
  return (
    <Box
      borderWidth="1px"
      borderColor="app.border"
      borderRadius="md"
      p="3"
      bg="app.surface"
      shadow="elevationRaised"
      aria-hidden
    >
      <Flex align="baseline" justify="space-between" gap="2" mb="1.5">
        <Heading as="h3" role="subheading">
          {t(def.titleKey)}
        </Heading>
      </Flex>
      <Flex gap="3.5" flexWrap="wrap" mb="1.5">
        {def.series.map((s, i) => (
          <Skeleton key={s.key} height="10px" style={{ width: "68px", animationDelay: `${i * 0.05}s` }} />
        ))}
      </Flex>
      <Skeleton height="150px" />
    </Box>
  );
}

export function ServerMetricsPanel({ sessionId, driver }: { sessionId: string; driver: DriverKind }) {
  const t = useT();
  const settings = useSettings();

  const [samples, setSamples] = useState<MetricSample[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  // ポーリング間隔の既定は既存設定 autoRefreshDefaultSecs を流用する (#731)。
  const [intervalSecs, setIntervalSecs] = useState<number>(settings.autoRefreshDefaultSecs);
  const busyRef = useRef(false);
  // 取得の世代番号。セッション切替前に始まった取得の遅延応答を捨てる。
  const loadSeqRef = useRef(0);
  // 表示期間 (#1622)。バッファは選べる最長 (60 分) まで常に保持し、表示側で期間に切る。
  // 期間を切り替えても取得の履歴を捨てず、短くしてから戻しても過去の分が残る。
  const [windowSecs, setWindowSecs] = useState<number>(DEFAULT_METRICS_WINDOW_SECS);
  const windowMs = windowSecs * 1000;

  const load = useCallback(
    async (force = false) => {
      if (busyRef.current && !force) return;
      const seq = ++loadSeqRef.current;
      busyRef.current = true;
      setLoading(true);
      try {
        const m = await api.serverMetrics(sessionId);
        if (seq !== loadSeqRef.current) return;
        // 受信時刻でスタンプしてリングバッファへ (差分レートの分母に使う)。
        const at = Date.now();
        setSamples((cur) => pushSample(cur, { atMs: at, metrics: m }, BUFFER_WINDOW_MS));
        setError(null);
        setUpdatedAt(new Date(at));
      } catch (e) {
        if (seq !== loadSeqRef.current) return;
        setError(String(e));
      } finally {
        if (seq === loadSeqRef.current) {
          busyRef.current = false;
          setLoading(false);
        }
      }
    },
    [sessionId],
  );

  // 初回ロード + セッション切替時のリセット。
  useEffect(() => {
    setSamples([]);
    setError(null);
    setUpdatedAt(null);
    // 旧セッションの取得が飛んでいても新セッションの初回取得は必ず走らせる。
    void load(true);
  }, [load]);

  // ポーリング。アンマウント (タブ切替/パネルを閉じる) で clearInterval → 停止。
  // 非表示の間 (keep-alive, #1311) は止め、戻ったら 1 度取り直す。
  const active = useKeepAliveActive();
  useEffect(() => {
    if (!autoRefresh || !active) return;
    const handle = setInterval(() => {
      void load();
    }, intervalSecs * 1000);
    return () => clearInterval(handle);
  }, [autoRefresh, intervalSecs, load, active]);
  useRefreshOnReactivate(active, load);

  // バッファは最長期間ぶん持っているので、表示側で選択中の期間に切る。
  const visibleSamples = useMemo(() => windowSamples(samples, windowMs), [samples, windowMs]);
  const points = useMemo(() => deriveSeries(visibleSamples), [visibleSamples]);
  const headroom = useMemo(
    () => connectionHeadroom(visibleSamples[visibleSamples.length - 1]?.metrics),
    [visibleSamples],
  );

  // ポーリング間隔の選択肢: 共通プリセット + 設定既定値 (重複排除し昇順)。
  const intervalOptions = useMemo(() => {
    const set = new Set<number>([...AUTO_REFRESH_INTERVAL_OPTIONS, settings.autoRefreshDefaultSecs]);
    return [...set].sort((a, b) => a - b);
  }, [settings.autoRefreshDefaultSecs]);

  const throughputUnit = t(throughputUnitKey(driver));

  return (
    <Flex direction="column" gap="3">
      <chakra.p margin={0} fontSize="sm" color="app.textMuted">
        {t("metricsDesc", { mins: Math.round(windowSecs / 60) })}
      </chakra.p>

      <Flex align="center" gap="3" flexWrap="wrap">
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
            onChange={(e) => {
              setAutoRefresh(e.target.checked);
              // ON に戻したときは次の間隔を待たず、すぐ取得する。
              if (e.target.checked) void load();
            }}
          />
          {t("autoRefreshLabel")}
        </chakra.label>
        <Select
          aria-label={t("autoRefreshIntervalAria")}
          value={String(intervalSecs)}
          onChange={(e) => {
            setIntervalSecs(Number(e.target.value));
            if (autoRefresh) void load();
          }}
          width="auto"
        >
          {intervalOptions.map((s) => (
            <option key={s} value={s}>
              {s % 60 === 0
                ? t("autoRefreshIntervalMins", { mins: s / 60 })
                : t("autoRefreshIntervalSecs", { secs: s })}
            </option>
          ))}
        </Select>
        {/* 自動更新のたびに loading が切り替わるので、disabled や包み要素の切替でボタンを作り直さない
            (キーボードフォーカスが落ちる)。二重実行は load() 側の busyRef が防ぐ。 */}
        <Tooltip label={t("metricsRefresh")}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t("metricsRefresh")}
            onClick={() => void load()}
          >
            <Icon name="refresh" size={ICON_SIZES.md} />
          </Button>
        </Tooltip>
        {loading && <Spinner size={14} />}
        {updatedAt && (
          <chakra.span fontSize="xs" color="app.textMuted" textStyle="numeric">
            {t("processUpdatedAt", { time: updatedAt.toLocaleTimeString() })}
          </chakra.span>
        )}
        <Select
          aria-label={t("metricsWindowAria")}
          value={String(windowSecs)}
          onChange={(e) => setWindowSecs(Number(e.target.value))}
          width="auto"
        >
          {METRICS_WINDOW_OPTIONS_SECS.map((s) => (
            <option key={s} value={s}>
              {t("metricsWindowOption", { mins: s / 60 })}
            </option>
          ))}
        </Select>
        <TextExportButton
          formats={[
            {
              id: "csv",
              label: "CSV",
              build: () => tableToCsv(METRICS_CSV_HEADER, metricsToCsvRows(visibleSamples)),
            },
          ]}
          filenameBase={`server-metrics-${driver}`}
          disabled={visibleSamples.length === 0}
          label={t("metricsExportCsv")}
        />
      </Flex>

      {headroom && (
        <Callout
          tone={headroom.level === "ok" ? "info" : "warning"}
          role="status"
          data-testid="metrics-connection-headroom"
        >
          {t(
            headroom.level === "ok"
              ? "metricsConnectionHeadroom"
              : headroom.level === "warn"
                ? "metricsConnectionHeadroomWarn"
                : "metricsConnectionHeadroomDanger",
            { used: headroom.used, max: headroom.max, percent: headroom.percent },
          )}
        </Callout>
      )}

      {updatedAt && <MetricSummaryTiles points={points} />}

      {error && (
        // ポーリング失敗: チャート自体は直前サンプルのまま表示を続けるため、全体を
        // 置き換えない compact な EmptyState + 再取得導線で通知する (#848)。
        <EmptyState
          compact
          illustration={errorIllustration(error)}
          icon="warning"
          title={t("metricsLoadError", { error })}
          action={{ label: t("metricsRetry"), onClick: () => void load() }}
        />
      )}

      {!updatedAt && loading
        ? // 初回ロード中 (まだ 1 度もサンプルを取得していない): 「データなし」
          // 空状態と混同しないよう、チャートカードの構造をシマーで予兆表示する
          // (#846)。
          CHARTS.map((def) => <MetricChartSkeleton key={def.titleKey} def={def} />)
        : CHARTS.map((def) => (
            <MetricChart
              key={def.titleKey}
              points={points}
              def={def}
              unitLabel={def.titleKey === "metricsChartThroughput" ? throughputUnit : t(def.unitKey)}
            />
          ))}
    </Flex>
  );
}
