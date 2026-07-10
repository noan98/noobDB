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
