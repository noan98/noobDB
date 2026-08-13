// クエリ結果のチャート可視化のデータ整形 (純ロジック)。
//
// 取得済みの結果セット (columns / rows) から、X 軸 (カテゴリ) と Y 軸 (数値系列) を
// 抽出し、任意の集計 (none / sum / avg / count) でグループ化したチャート系列を作る。
// 描画は ChartView (SVG) が行う。副作用が無いので Vitest でユニットテストする。

import type { CellValue, Column } from "../api/tauri";
import {
  DIVERGING_RAMPS,
  SEQUENTIAL_RAMPS,
  categoricalColor,
  sampleRamp,
  type ColorRamp,
} from "../colorScale";
import { resultViewKey } from "./resultViewKey";

export type ChartType = "bar" | "line" | "area" | "pie";
export type Aggregation = "none" | "sum" | "avg" | "count";

export interface ChartConfig {
  type: ChartType;
  /** X 軸 (カテゴリ) の列インデックス。 */
  xCol: number;
  /** Y 軸 (数値系列) の列インデックス。複数可。 */
  yCols: number[];
  aggregation: Aggregation;
  /**
   * 系列/値の配色 (#916)。共有カラースケール (`colorScale.ts`) のキーで、
   * 省略時は従来どおりカテゴリスケール。`defaultChartConfig` /
   * `sanitizeChartConfig` は必ず値を入れるため、省略可なのは後から足した
   * フィールドの後方互換 (このフィールドを持たない保存済み設定・テストの
   * 手組みモデル) を型レベルでも認めるためだけ。読み出しは常に
   * `chartPalette()` を通すので未設定でも安全に既定へ倒れる。
   */
  palette?: ChartPaletteKey;
}

export interface ChartSeries {
  name: string;
  values: number[];
}

export interface ChartModel {
  labels: string[];
  series: ChartSeries[];
  /** サンプリングで間引いたときの元の行数 (未間引きなら null)。 */
  sampledFrom: number | null;
  /**
   * 集計なし (`aggregation: "none"`) のとき、Y 列の生値のうち NULL/非数値で
   * あったため `0` へ読み替えた個数の合計 (#646)。集計あり (`sum`/`avg`/`count`)
   * は元から非数値を除外して計算するためこの読み替えが発生せず、常に `0`。
   * `chartNotices` がこの値を見て「一部のセルは 0 として表示している」旨の
   * 控えめな注記を出すために使う。省略時 (テストで手組みしたモデルなど) は
   * `0` 扱い。
   */
  excludedNonNumeric?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 配色 (#916)。グリッドの条件付き書式 (`cellConditionalFormat.ts` の
// `HEAT_PALETTES`) が既に開放している連続/発散ランプを、チャートの系列色にも
// 開放して「値 → 色」の体系をグリッドと揃える。色そのものは共有カラースケール
// (`colorScale.ts`、#525) だけを情報源にし、ここでは**選択肢の集合とサンプリング
// 位置の決め方**しか持たない (色を二重定義しない)。
// ─────────────────────────────────────────────────────────────────────────────

/** チャートで選べる配色のキー。`categorical` は従来どおりの離散パレット。 */
export type ChartPaletteKey = "categorical" | "blue" | "teal" | "coolWarm" | "blueOrange";

export interface ChartPalette {
  key: ChartPaletteKey;
  /** 連続/発散ランプ。離散パレット (`categorical`) では null。 */
  ramp: ColorRamp | null;
  /** カラーブラインド (赤緑色弱) に配慮した配色か。UI の注記に使う。 */
  colorBlindSafe: boolean;
}

export const CHART_PALETTES: Record<ChartPaletteKey, ChartPalette> = {
  categorical: { key: "categorical", ramp: null, colorBlindSafe: true },
  blue: { key: "blue", ramp: SEQUENTIAL_RAMPS.blue, colorBlindSafe: SEQUENTIAL_RAMPS.blue.colorBlindSafe },
  teal: { key: "teal", ramp: SEQUENTIAL_RAMPS.teal, colorBlindSafe: SEQUENTIAL_RAMPS.teal.colorBlindSafe },
  coolWarm: {
    key: "coolWarm",
    ramp: DIVERGING_RAMPS.coolWarm,
    colorBlindSafe: DIVERGING_RAMPS.coolWarm.colorBlindSafe,
  },
  blueOrange: {
    key: "blueOrange",
    ramp: DIVERGING_RAMPS.blueOrange,
    colorBlindSafe: DIVERGING_RAMPS.blueOrange.colorBlindSafe,
  },
};

export const DEFAULT_CHART_PALETTE: ChartPaletteKey = "categorical";

/** キー (未知/未設定を含む) からパレット定義を引く。常に有効な値を返す。 */
export function chartPalette(key: string | undefined | null): ChartPalette {
  if (typeof key === "string" && key in CHART_PALETTES) {
    return CHART_PALETTES[key as ChartPaletteKey];
  }
  return CHART_PALETTES[DEFAULT_CHART_PALETTE];
}

/**
 * ランプ上でサンプリングに使う区間。連続ランプの t=0 は淡すぎて明るい背景に
 * 沈むため下端を切り上げる。発散ランプは中央の淡色が「基準値」を表す設計なので
 * 全域をそのまま使う。
 */
function rampSpan(ramp: ColorRamp): [number, number] {
  return ramp.kind === "diverging" ? [0, 1] : [0.2, 1];
}

/** 単一色でランプを代表させるときの位置 (系列 1 本・値域が退化しているとき)。 */
const RAMP_SOLO_T = 0.75;

/**
 * 系列インデックス → 色。`categorical` は既存の離散パレットを循環参照し、
 * ランプでは系列数で `rampSpan` を等分してサンプリングする (隣接系列の明度差を
 * 確保するため端から端まで使い切る)。`count` が 0 なら空配列。
 */
export function chartSeriesColors(paletteKey: string | undefined, count: number): string[] {
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const { ramp } = chartPalette(paletteKey);
  if (!ramp) return Array.from({ length: n }, (_, i) => categoricalColor(i));
  if (n === 1) return [sampleRamp(RAMP_SOLO_T, ramp.stops)];
  const [lo, hi] = rampSpan(ramp);
  return Array.from({ length: n }, (_, i) => sampleRamp(lo + ((hi - lo) * i) / (n - 1), ramp.stops));
}

/**
 * 値の大小をランプ上の位置へ写した「1 点ごとの色」(#916)。単一数値系列の棒/円を
 * 値で着色するために使う。`categorical` では値による着色を行わないので `null` を
 * 返し、呼び出し側は系列色 1 色にフォールバックする。値域が退化 (空/全同値/
 * 非有限のみ) しているときは大小を色で表せないため単色を返す。
 */
export function chartValueColors(values: number[], paletteKey: string | undefined): string[] | null {
  const { ramp } = chartPalette(paletteKey);
  if (!ramp) return null;
  const solo = sampleRamp(RAMP_SOLO_T, ramp.stops);
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max === min) {
    return values.map(() => solo);
  }
  const [lo, hi] = rampSpan(ramp);
  return values.map((v) => {
    if (!Number.isFinite(v)) return solo;
    return sampleRamp(lo + ((hi - lo) * (v - min)) / (max - min), ramp.stops);
  });
}

/**
 * ランプを CSS の `linear-gradient` として表現する (値で着色しているときの凡例
 * 見本用)。離散パレットは勾配を持たないので `null`。
 */
export function chartRampGradient(paletteKey: string | undefined): string | null {
  const { ramp } = chartPalette(paletteKey);
  if (!ramp) return null;
  const [lo, hi] = rampSpan(ramp);
  const steps = 4;
  const stops = Array.from({ length: steps + 1 }, (_, i) => {
    const t = lo + ((hi - lo) * i) / steps;
    return `${sampleRamp(t, ramp.stops)} ${Math.round((i / steps) * 100)}%`;
  });
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

/** 描画点数の上限。これを超えたら等間隔でサンプリングする。 */
export const MAX_POINTS = 2000;

/** セル値を数値へ変換する (不可なら null)。boolean は 1/0。 */
export function toNumber(v: CellValue): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * 各列が「数値列か」を判定する。非 NULL 値の過半数が数値に変換できれば数値列とみなす。
 * チャートの Y 軸候補・X 軸候補の初期提示に使う。
 */
export function inferNumericColumns(columns: Column[], rows: CellValue[][]): boolean[] {
  return columns.map((_, c) => {
    let total = 0;
    let numeric = 0;
    for (const row of rows) {
      const v = row[c];
      if (v === null || v === undefined) continue;
      total++;
      if (toNumber(v) !== null) numeric++;
    }
    return total > 0 && numeric * 2 >= total;
  });
}

/** 既定のチャート設定を提示する。最初の非数値列を X、最初の数値列を Y にする。 */
export function defaultChartConfig(columns: Column[], rows: CellValue[][]): ChartConfig | null {
  if (columns.length === 0) return null;
  const numeric = inferNumericColumns(columns, rows);
  const firstNumeric = numeric.findIndex((n) => n);
  if (firstNumeric < 0) return null;
  // X はできれば非数値列、無ければ 0 番目 (数値列でも可)。
  const firstNonNumeric = numeric.findIndex((n) => !n);
  const xCol = firstNonNumeric >= 0 ? firstNonNumeric : 0;
  const yCols = [firstNumeric].filter((i) => i !== xCol);
  if (yCols.length === 0) {
    const altY = numeric.findIndex((n, i) => n && i !== xCol);
    if (altY < 0) return null;
    yCols.push(altY);
  }
  return { type: "bar", xCol, yCols, aggregation: "none", palette: DEFAULT_CHART_PALETTE };
}

function cellLabel(v: CellValue): string {
  if (v === null || v === undefined) return "(null)";
  return String(v);
}

/**
 * 設定からチャートモデルを組み立てる。集計が none ならそのまま行を点として扱い
 * (上限超過時はサンプリング)、sum/avg/count なら X 値でグループ化する。
 */
export function buildChartModel(
  columns: Column[],
  rows: CellValue[][],
  config: ChartConfig,
): ChartModel {
  const { xCol, yCols, aggregation } = config;
  const yNames = yCols.map((c) => columns[c]?.name ?? `col${c}`);

  if (aggregation === "none") {
    let working = rows;
    let sampledFrom: number | null = null;
    if (rows.length > MAX_POINTS) {
      sampledFrom = rows.length;
      const step = rows.length / MAX_POINTS;
      working = [];
      for (let i = 0; i < MAX_POINTS; i++) working.push(rows[Math.floor(i * step)]);
    }
    const labels = working.map((r) => cellLabel(r[xCol]));
    // NULL/非数値は 0 として描画する (既存挙動)。何件読み替えたかを数え、
    // ChartView が「一部は 0 として表示している」注記を出すのに使う (#646)。
    let excludedNonNumeric = 0;
    const series: ChartSeries[] = yCols.map((c, si) => ({
      name: yNames[si],
      values: working.map((r) => {
        const n = toNumber(r[c]);
        if (n === null) excludedNonNumeric++;
        return n ?? 0;
      }),
    }));
    return { labels, series, sampledFrom, excludedNonNumeric };
  }

  // グループ集計: X 値ごとに Y を畳み込む。
  const order: string[] = [];
  // NULL / 非数値を集計から除外するため、列ごとに「数値として加算した件数」を別管理する
  // (SQL の SUM/AVG と同じく非 NULL の数値のみを対象にする)。COUNT だけは別軸で
  // 「非 NULL の件数」を数える (SQL の COUNT(col) は数値変換できるかに関わらず非
  // NULL 値をすべて数えるため、文字列など数値化できない値も含める必要がある)。
  const groups = new Map<string, { sums: number[]; numericCounts: number[]; nonNullCounts: number[] }>();
  for (const r of rows) {
    const key = cellLabel(r[xCol]);
    let g = groups.get(key);
    if (!g) {
      g = { sums: yCols.map(() => 0), numericCounts: yCols.map(() => 0), nonNullCounts: yCols.map(() => 0) };
      groups.set(key, g);
      order.push(key);
    }
    yCols.forEach((c, i) => {
      const raw = r[c];
      if (raw !== null && raw !== undefined) g!.nonNullCounts[i] += 1;
      const n = toNumber(raw);
      if (n !== null) {
        g!.sums[i] += n;
        g!.numericCounts[i] += 1;
      }
    });
  }
  const labels = order;
  const series: ChartSeries[] = yCols.map((_, i) => ({
    name: aggregation === "count" ? `COUNT(${yNames[i]})` : `${aggregation.toUpperCase()}(${yNames[i]})`,
    values: order.map((key) => {
      const g = groups.get(key)!;
      if (aggregation === "count") return g.nonNullCounts[i];
      if (aggregation === "avg") {
        const denom = g.numericCounts[i];
        return denom > 0 ? g.sums[i] / denom : 0;
      }
      return g.sums[i];
    }),
  }));
  // 集計あり (sum/avg/count) は非数値・NULL を最初から除外して計算しており
  // 0 への読み替えは発生しない。
  return { labels, series, sampledFrom: null, excludedNonNumeric: 0 };
}

/**
 * 軸の目盛りに使う「キリの良い」値の配列を昇順で返す。
 * `[min, max]` を覆う nice step を求め、その範囲内に収まる目盛り値だけ返す。
 * 値が縮退している (min === max もしくは非有限) 場合はその 1 点のみ返す。
 * グリッド線と Y 軸ラベルを等間隔の読みやすい値に揃えるために使う。
 */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    return [Number.isFinite(min) ? min : 0];
  }
  const niceNum = (range: number, round: boolean): number => {
    const exp = Math.floor(Math.log10(range));
    const frac = range / 10 ** exp;
    let nf: number;
    if (round) {
      nf = frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10;
    } else {
      nf = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
    }
    return nf * 10 ** exp;
  };
  const step = niceNum(niceNum(max - min, false) / Math.max(1, count - 1), true);
  const start = Math.ceil(min / step) * step;
  // 浮動小数の桁ずれ (0.1 + 0.2 など) を丸めるための小数桁数。
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 1e-6; v += step) {
    ticks.push(Number(v.toFixed(decimals)));
  }
  return ticks;
}

/**
 * 系列全体の最大値・最小値 (軸スケール用)。空なら {min:0,max:0}。
 * `type` は棒/エリアのときだけ 0 基線を含める (面積・高さの基準がわかりやすいよう)。
 * 折れ線は値が密集しているときに 0 起点だと変動がつぶれて読みにくくなるため、
 * 実データのレンジをそのまま使う。省略時は後方互換のため 0 基線を含める
 * (呼び出し側の大半は棒グラフ用途のため)。
 */
export function valueExtent(model: ChartModel, type: ChartType = "bar"): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const s of model.series) {
    for (const v of s.values) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 0 };
  if (type === "line") return { min, max };
  return { min: Math.min(0, min), max: Math.max(0, max) };
}

/**
 * チャートに描き添える控えめな注記の種類 (#646)。破綻ではなく「見た目が
 * 平坦/点 1 つ/値の一部を 0 として読み替えている」ことをユーザに伝えるための
 * ヒントで、いずれもチャート自体は問題なく描画できる (棒 1 本・平坦な線など)。
 */
export type ChartNotice = "singlePoint" | "flatValues" | "nonNumericExcluded";

/**
 * モデルから表示すべき注記を判定する。データが破綻しているわけではないが
 * 「なぜこう見えるか」の説明が無いと不安になりうるケースを拾う:
 *
 * - `singlePoint`: データ点が 1 つだけ (折れ線/面グラフは点が線にならない)。
 * - `flatValues`: 全系列・全点の値が完全に同一 (グラフが水平な直線/同じ高さの
 *   棒になる。バグではなく実データがそうであることを明示する)。
 * - `nonNumericExcluded`: 集計なしで、Y 列の一部が NULL/非数値だったため `0`
 *   として描画している (`ChartModel.excludedNonNumeric`)。
 */
export function chartNotices(model: ChartModel): ChartNotice[] {
  const notices: ChartNotice[] = [];
  if (model.labels.length === 1) notices.push("singlePoint");
  const allValues = model.series.flatMap((s) => s.values);
  if (model.labels.length > 1 && allValues.length > 0 && allValues.every((v) => v === allValues[0])) {
    notices.push("flatValues");
  }
  if ((model.excludedNonNumeric ?? 0) > 0) notices.push("nonNumericExcluded");
  return notices;
}

// ─────────────────────────────────────────────────────────────────────────────
// 設定の永続化 (#909)。実行 SQL のフィンガープリント単位で localStorage に保存し、
// 再実行・タブ切替・タブ復元・再起動をまたいで復元する。破損耐性は既存パターン
// (`gridFooter.ts` の `readStoredFooterState` 等) に倣い、壊れた JSON・型不一致・
// 列構成が変わって参照が成立しない設定は破棄して呼び出し側の既定値へ委ねる。
// ─────────────────────────────────────────────────────────────────────────────

const CHART_CONFIG_NAMESPACE = "noobdb.chartconfig.v1";

/** 実行 SQL からチャート設定の永続化キーを作る。SQL が無ければ永続化しない。 */
export function chartConfigKeyFrom(sql: string | undefined): string | undefined {
  return resultViewKey(CHART_CONFIG_NAMESPACE, sql);
}

const CHART_TYPES: ChartType[] = ["bar", "line", "area", "pie"];
const AGGREGATIONS: Aggregation[] = ["none", "sum", "avg", "count"];

/**
 * パース済み JSON を現在の列構成に照らして妥当な `ChartConfig` に整える。純粋
 * (ストレージ非依存) なのでユニットテストできる。型不正・列参照が範囲外・X 軸が
 * 消えた場合は `null` を返し、呼び出し側は `defaultChartConfig` へ安全に縮退する。
 * 保存時に Y 軸が空 (ユーザが意図的に全解除) だった場合はそのまま尊重するが、
 * 保存時に Y 軸があったのに列構成の変化で全滅した場合は `null` (縮退) にする —
 * 「列が変わった」ことの検出に使う。
 */
export function sanitizeChartConfig(raw: unknown, columns: Column[]): ChartConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  const type = o.type;
  if (typeof type !== "string" || !CHART_TYPES.includes(type as ChartType)) return null;

  const aggregation = o.aggregation;
  if (typeof aggregation !== "string" || !AGGREGATIONS.includes(aggregation as Aggregation)) return null;

  const xCol = o.xCol;
  if (typeof xCol !== "number" || !Number.isInteger(xCol) || xCol < 0 || xCol >= columns.length) return null;

  const yColsRaw = o.yCols;
  if (!Array.isArray(yColsRaw)) return null;
  const seen = new Set<number>();
  const yCols: number[] = [];
  for (const y of yColsRaw) {
    if (typeof y === "number" && Number.isInteger(y) && y >= 0 && y < columns.length && y !== xCol && !seen.has(y)) {
      seen.add(y);
      yCols.push(y);
    }
  }
  // 保存時に Y 軸が選ばれていたのに、列構成の変化で 1 つも生き残らなかった
  // 場合だけ縮退する。保存時から空だったなら (ユーザの意図的な全解除) 尊重する。
  if (yColsRaw.length > 0 && yCols.length === 0) return null;

  // 配色 (#916) は後から足したフィールドなので、欠けている旧設定や未知のキーは
  // 縮退させず既定へ埋める (他フィールドと違い、参照の整合性を壊さないため)。
  const palette = chartPalette(typeof o.palette === "string" ? o.palette : undefined).key;

  return { type: type as ChartType, xCol, yCols, aggregation: aggregation as Aggregation, palette };
}

/**
 * 保存済みチャート設定を読む。キー無し・壊れた JSON・型不一致・列構成の不整合は
 * `null` を返し、呼び出し側 (`ChartView`) は `defaultChartConfig` にフォールバック
 * する (private mode / quota / 破損に耐える。#566 と同じ方針)。
 */
export function readStoredChartConfig(key: string | undefined, columns: Column[]): ChartConfig | null {
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    return sanitizeChartConfig(JSON.parse(raw), columns);
  } catch {
    return null;
  }
}

/** チャート設定を保存する。キー無し (SQL 未実行) のときは何もしない。 */
export function writeStoredChartConfig(key: string | undefined, config: ChartConfig): void {
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(config));
  } catch {
    // ignore (private mode, quota)
  }
}
