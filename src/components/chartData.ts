// クエリ結果のチャート可視化のデータ整形 (純ロジック)。
//
// 取得済みの結果セット (columns / rows) から、X 軸 (カテゴリ) と Y 軸 (数値系列) を
// 抽出し、任意の集計 (none / sum / avg / count) でグループ化したチャート系列を作る。
// 描画は ChartView (SVG) が行う。副作用が無いので Vitest でユニットテストする。

import type { CellValue, Column } from "../api/tauri";

export type ChartType = "bar" | "line" | "area" | "pie";
export type Aggregation = "none" | "sum" | "avg" | "count";

export interface ChartConfig {
  type: ChartType;
  /** X 軸 (カテゴリ) の列インデックス。 */
  xCol: number;
  /** Y 軸 (数値系列) の列インデックス。複数可。 */
  yCols: number[];
  aggregation: Aggregation;
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
  return { type: "bar", xCol, yCols, aggregation: "none" };
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
    const series: ChartSeries[] = yCols.map((c, si) => ({
      name: yNames[si],
      values: working.map((r) => toNumber(r[c]) ?? 0),
    }));
    return { labels, series, sampledFrom };
  }

  // グループ集計: X 値ごとに Y を畳み込む。
  const order: string[] = [];
  // NULL / 非数値を集計から除外するため、列ごとに「数値として加算した件数」を別管理する
  // (SQL の SUM/AVG/COUNT(col) と同じく非 NULL の数値のみを対象にする)。
  const groups = new Map<string, { sums: number[]; numericCounts: number[] }>();
  for (const r of rows) {
    const key = cellLabel(r[xCol]);
    let g = groups.get(key);
    if (!g) {
      g = { sums: yCols.map(() => 0), numericCounts: yCols.map(() => 0) };
      groups.set(key, g);
      order.push(key);
    }
    yCols.forEach((c, i) => {
      const n = toNumber(r[c]);
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
      if (aggregation === "count") return g.numericCounts[i];
      if (aggregation === "avg") {
        const denom = g.numericCounts[i];
        return denom > 0 ? g.sums[i] / denom : 0;
      }
      return g.sums[i];
    }),
  }));
  return { labels, series, sampledFrom: null };
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

/** 系列全体の最大値・最小値 (軸スケール用)。空なら {min:0,max:0}。 */
export function valueExtent(model: ChartModel): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const s of model.series) {
    for (const v of s.values) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 0 };
  // バー/エリアは 0 基線を含める。
  return { min: Math.min(0, min), max: Math.max(0, max) };
}
