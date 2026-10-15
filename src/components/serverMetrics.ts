import type { DriverKind, ServerMetrics } from "../api/tauri";

/**
 * サーバ監視ダッシュボード (#731) の純ロジック。カウンタ差分 → レート変換・
 * 在メモリのリングバッファ・時系列系列の抽出を、レンダリングから切り離した副作用
 * なしの純関数として実装する (`queryInspector.ts` / `processList.ts` と同じ方針)。
 * 判定はすべて決定的で AI は使わない。時系列の保持はフロント在メモリのみで、
 * 新規ストレージは増やさない。
 */

// ── リングバッファ ───────────────────────────────────────────────────────

/** バックエンドの生スナップショット 1 サンプル + フロントが受信時刻でスタンプした時刻。 */
export interface MetricSample {
  /** 受信時刻 (エポック ms)。レート計算の分母 (経過時間) に使う。 */
  atMs: number;
  metrics: ServerMetrics;
}

/**
 * リングバッファの安全上限 (サンプル数)。時間窓 (`windowMs`) による pruning が
 * 主で、これは時刻の巻き戻りや極端に大きい窓での暴走を防ぐ副次的な上限。
 */
export const MAX_METRIC_SAMPLES = 1440;

/** ダッシュボードが保持する既定の時間窓 (直近 N 分)。 */
export const DEFAULT_METRICS_WINDOW_SECS = 300;

/**
 * サンプルを 1 つ追加した新しいバッファを返す (入力は変更しない)。時間窓
 * (`windowMs`) より古いサンプルを落とし、加えて `maxSamples` を超えたら**古い方**
 * から切り詰める。新サンプルの時刻を基準に窓を切るため、ポーリング間隔が変わっても
 * 「直近 N 分」を保てる。
 */
export function pushSample(
  buffer: readonly MetricSample[],
  sample: MetricSample,
  windowMs: number,
  maxSamples: number = MAX_METRIC_SAMPLES,
): MetricSample[] {
  const cutoff = sample.atMs - Math.max(0, windowMs);
  const kept = buffer.filter((s) => s.atMs >= cutoff);
  kept.push(sample);
  const cap = Math.max(1, Math.floor(maxSamples));
  return kept.length > cap ? kept.slice(kept.length - cap) : kept;
}

// ── カウンタ差分 → レート ─────────────────────────────────────────────────

/**
 * 累積カウンタ 2 点の差分から毎秒レートを求める。QPS/TPS・スロークエリ発生率・
 * ロック待ち発生率に使う。以下は算出せず `null` (系列のギャップ) を返す:
 * - どちらかが `null` (エンジンが報告しない項目)
 * - 経過時間が 0 以下 (最初のサンプル / 同時刻)
 * - `cur < prev` — サーバ側の統計リセットやエビクションでカウンタが逆行した。
 *   負のレートを出すより「その区間は不明」とするほうが誤解が少ない (#746 の
 *   digest 差分と同じ reset ガード方針)。
 */
export function counterRate(prev: number | null, cur: number | null, dtMs: number): number | null {
  if (prev == null || cur == null) return null;
  if (!(dtMs > 0)) return null;
  if (cur < prev) return null;
  return (cur - prev) / (dtMs / 1000);
}

// ── 時系列系列の抽出 ─────────────────────────────────────────────────────

/** チャートに載る 1 時点。ゲージは瞬時値、レートは直前サンプルとの差分から算出。 */
export interface MetricPoint {
  atMs: number;
  /** ゲージ (瞬時値)。 */
  connections: number | null;
  active: number | null;
  idleInTransaction: number | null;
  lockWaiting: number | null;
  /** スループット (QPS/TPS)。`questions` カウンタの差分レート。 */
  queryRate: number | null;
  /** スロークエリ発生率 (件/秒)。 */
  slowQueryRate: number | null;
  /** 行ロック待ち発生率 (件/秒)。 */
  lockWaitRate: number | null;
}

/**
 * リングバッファを、各点で直前サンプルとの差分レートを算出した時系列に変換する。
 * ゲージ列はそのまま、レート列は `counterRate` で求める (先頭点や reset 直後は
 * `null`)。
 */
export function deriveSeries(samples: readonly MetricSample[]): MetricPoint[] {
  const out: MetricPoint[] = [];
  for (let i = 0; i < samples.length; i++) {
    const cur = samples[i];
    const prev = i > 0 ? samples[i - 1] : null;
    const dtMs = prev ? cur.atMs - prev.atMs : 0;
    out.push({
      atMs: cur.atMs,
      connections: cur.metrics.connections,
      active: cur.metrics.active,
      idleInTransaction: cur.metrics.idle_in_transaction,
      lockWaiting: cur.metrics.lock_waiting,
      queryRate: counterRate(prev?.metrics.questions ?? null, cur.metrics.questions, dtMs),
      slowQueryRate: counterRate(prev?.metrics.slow_queries ?? null, cur.metrics.slow_queries, dtMs),
      lockWaitRate: counterRate(prev?.metrics.lock_waits ?? null, cur.metrics.lock_waits, dtMs),
    });
  }
  return out;
}

/** 数値系列を指す `MetricPoint` のキー。 */
export type MetricSeriesKey =
  | "connections"
  | "active"
  | "idleInTransaction"
  | "lockWaiting"
  | "queryRate"
  | "slowQueryRate"
  | "lockWaitRate";

/** チャート描画用の 1 点 (時刻 + 値)。`null`/非有限値は除外済み。 */
export interface MetricSeriesPoint {
  atMs: number;
  value: number;
}

/**
 * 指定キーの時系列を `{atMs, value}` 配列として取り出す。`null` や非有限値
 * (エンジンが報告しない・レート未算出) は落とすので、そのドライバで取得できない
 * 系列は自然に空配列になる (SQLite/権限不足の degrade をここで吸収する)。
 */
export function extractSeries(points: readonly MetricPoint[], key: MetricSeriesKey): MetricSeriesPoint[] {
  const out: MetricSeriesPoint[] = [];
  for (const p of points) {
    const v = p[key];
    if (v != null && Number.isFinite(v)) out.push({ atMs: p.atMs, value: v });
  }
  return out;
}

/** いずれかのキーに 1 点でも描画可能なデータがあるか (空状態の判定)。 */
export function hasSeriesData(points: readonly MetricPoint[], keys: readonly MetricSeriesKey[]): boolean {
  return keys.some((k) => points.some((p) => p[k] != null && Number.isFinite(p[k] as number)));
}

// ── 表示整形 ─────────────────────────────────────────────────────────────

/**
 * スループット (MySQL) はステートメント数、PostgreSQL はトランザクション数と
 * 意味が異なるため、レート系列のラベルをドライバ種別で切り替える。SQLite は
 * ダッシュボード非対応なので便宜上 MySQL 相当を返す (呼び出し側で導線ごと非表示)。
 */
export function throughputUnitKey(driver: DriverKind): "metricsQpsUnit" | "metricsTpsUnit" {
  return driver === "postgres" ? "metricsTpsUnit" : "metricsQpsUnit";
}

/** レート値の短い表示 (`1.2` / `340` / `12.3k`)。負値/非有限は "–"。 */
export function formatRate(value: number | null): string {
  if (value == null || !Number.isFinite(value) || value < 0) return "–";
  if (value >= 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (value >= 100) return `${Math.round(value)}`;
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

/** 整数カウント (接続数など) の表示。`null`/非有限は "–"。 */
export function formatCount(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "–";
  return `${Math.round(value)}`;
}

// ── 期間切替 (#1622) ─────────────────────────────────────────────────────

/** 表示期間の選択肢 (秒)。5 分 / 15 分 / 60 分。 */
export const METRICS_WINDOW_OPTIONS_SECS: readonly number[] = [300, 900, 3600];

/** 最新サンプルを基準に、直近 `windowMs` に入るサンプルだけを返す (入力は変更しない)。 */
export function windowSamples(samples: readonly MetricSample[], windowMs: number): MetricSample[] {
  const last = samples[samples.length - 1];
  if (!last) return [];
  const cutoff = last.atMs - Math.max(0, windowMs);
  return samples.filter((s) => s.atMs >= cutoff);
}

// ── 接続数の余裕 (#1622) ─────────────────────────────────────────────────

export type ConnectionHeadroomLevel = "ok" | "warn" | "danger";

export interface ConnectionHeadroom {
  used: number;
  max: number;
  /** 使用率 (0〜100 の整数、100 超は 100 に収める)。 */
  percent: number;
  level: ConnectionHeadroomLevel;
}

/** 使用率がこの値 (%) 以上で警告、`DANGER` 以上で危険。 */
export const CONNECTION_WARN_PERCENT = 80;
export const CONNECTION_DANGER_PERCENT = 90;

/**
 * 接続数とサーバ上限から余裕を求める。どちらかが無い / 上限が 0 以下なら `null` (表示しない)。
 * 上限に近づいたら `too many connections` になる前に警告するための材料。
 */
export function connectionHeadroom(
  metrics: Pick<ServerMetrics, "connections" | "max_connections"> | null | undefined,
): ConnectionHeadroom | null {
  const used = metrics?.connections;
  const max = metrics?.max_connections;
  if (used == null || max == null || !Number.isFinite(used) || !Number.isFinite(max) || max <= 0) return null;
  const percent = Math.min(100, Math.max(0, Math.round((used / max) * 100)));
  const level: ConnectionHeadroomLevel =
    percent >= CONNECTION_DANGER_PERCENT ? "danger" : percent >= CONNECTION_WARN_PERCENT ? "warn" : "ok";
  return { used, max, percent, level };
}

// ── CSV 書き出し (#1622) ─────────────────────────────────────────────────

/** CSV の列見出し (`metricsToCsvRows` の列順と一致)。 */
export const METRICS_CSV_HEADER: readonly string[] = [
  "time",
  "connections",
  "max_connections",
  "active",
  "idle_in_transaction",
  "lock_waiting",
  "query_rate_per_sec",
  "slow_query_rate_per_sec",
  "lock_wait_rate_per_sec",
];

/**
 * 在メモリのバッファを CSV 用の行にする。時刻は ISO 8601 (UTC)、レートは小数 4 桁。
 * 取れなかった項目 (`null`) は空欄。レートは `deriveSeries` と同じ差分計算なので、画面のグラフと一致する。
 */
export function metricsToCsvRows(samples: readonly MetricSample[]): (string | number | null)[][] {
  const points = deriveSeries(samples);
  return points.map((p, i) => [
    new Date(p.atMs).toISOString(),
    p.connections,
    samples[i]?.metrics.max_connections ?? null,
    p.active,
    p.idleInTransaction,
    p.lockWaiting,
    roundRate(p.queryRate),
    roundRate(p.slowQueryRate),
    roundRate(p.lockWaitRate),
  ]);
}

function roundRate(v: number | null): number | null {
  return v == null || !Number.isFinite(v) ? null : Math.round(v * 10_000) / 10_000;
}
