// クエリ結果のチャート可視化 (#440) のデータ整形 (純ロジック)。
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
  const groups = new Map<string, { count: number; sums: number[] }>();
  for (const r of rows) {
    const key = cellLabel(r[xCol]);
    let g = groups.get(key);
    if (!g) {
      g = { count: 0, sums: yCols.map(() => 0) };
      groups.set(key, g);
      order.push(key);
    }
    g.count++;
    yCols.forEach((c, i) => {
      g!.sums[i] += toNumber(r[c]) ?? 0;
    });
  }
  const labels = order;
  const series: ChartSeries[] = yCols.map((_, i) => ({
    name: aggregation === "count" ? `COUNT(${yNames[i]})` : `${aggregation.toUpperCase()}(${yNames[i]})`,
    values: order.map((key) => {
      const g = groups.get(key)!;
      if (aggregation === "count") return g.count;
      if (aggregation === "avg") return g.count > 0 ? g.sums[i] / g.count : 0;
      return g.sums[i];
    }),
  }));
  return { labels, series, sampledFrom: null };
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
