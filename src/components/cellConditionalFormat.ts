/**
 * 数値セルの条件付き書式 (データバー / ヒートマップ) の純ロジック。
 *
 * **表示専用**。列内の min/max を基準に値を正規化し、セル背景の「バー幅」や
 * 「ヒート色」を算出するだけで、コピー・編集・エクスポートの実値には一切影響
 * しない。NULL / 非数値は対象外 (無着色) として明示的に弾く。
 *
 * すべて副作用のない純関数として切り出し、`cellConditionalFormat.test.ts` で
 * 単体テストする。色/幅マッピングと正規化のリグレッションをここで固定する。
 */

/** 列ごとの適用モード。 */
export type CondFormatMode = "off" | "bar" | "heat";

export interface NumericStats {
  min: number;
  max: number;
}

/** セル値を数値へ寄せる。数値化できなければ `null` (= 対象外)。 */
export function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 列の数値群から min/max を求める。数値が 1 つも無ければ `null`。 */
export function computeNumericStats(values: Iterable<unknown>): NumericStats | null {
  let min = Infinity;
  let max = -Infinity;
  let seen = false;
  for (const v of values) {
    const n = toNumber(v);
    if (n === null) continue;
    seen = true;
    if (n < min) min = n;
    if (n > max) max = n;
  }
  return seen ? { min, max } : null;
}

/**
 * 値を [0,1] に正規化する。範囲が退化 (min===max) している列では 0 を返し、
 * バーやヒートが「すべて同じ」にならないようにする (呼び出し側で無着色にできる)。
 * 範囲外の値はクランプする。
 */
export function normalize(value: number, stats: NumericStats): number {
  const range = stats.max - stats.min;
  if (range <= 0) return 0;
  const t = (value - stats.min) / range;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** データバーの幅 (パーセント, 0–100)。 */
export function dataBarPercent(value: number, stats: NumericStats): number {
  return normalize(value, stats) * 100;
}

/** ヒートマップのパレット定義 (明→濃の hex ストップ列)。 */
export interface HeatPalette {
  key: string;
  /** カラーブラインド (赤緑) に配慮した単色相系か。 */
  colorBlindSafe: boolean;
  stops: string[];
}

/**
 * 既定で用意するパレット。`blue` / `teal` は単一色相の連続スケールで赤緑色弱でも
 * 明度差で読めるため CB セーフ。`warmCool` は青→赤の発散系で直感的だが赤緑が
 * 同居するため CB セーフではない (選択は任意)。
 */
export const HEAT_PALETTES: Record<string, HeatPalette> = {
  blue: { key: "blue", colorBlindSafe: true, stops: ["#eff6ff", "#93c5fd", "#1d4ed8"] },
  teal: { key: "teal", colorBlindSafe: true, stops: ["#effcf6", "#7edcc0", "#0f766e"] },
  warmCool: { key: "warmCool", colorBlindSafe: false, stops: ["#2563eb", "#f8fafc", "#dc2626"] },
};

export const DEFAULT_HEAT_PALETTE = "blue";

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/**
 * 正規化値 `t` (0–1) をパレット上の色へ写像し `rgb(...)` 文字列で返す。隣接ストップ
 * を線形補間する。`t` はクランプする。
 */
export function heatmapColor(t: number, palette: HeatPalette): string {
  const stops = palette.stops;
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  if (stops.length === 1) {
    const [r, g, b] = hexToRgb(stops[0]);
    return `rgb(${r}, ${g}, ${b})`;
  }
  const scaled = clamped * (stops.length - 1);
  const i = Math.min(Math.floor(scaled), stops.length - 2);
  const frac = scaled - i;
  const [r1, g1, b1] = hexToRgb(stops[i]);
  const [r2, g2, b2] = hexToRgb(stops[i + 1]);
  const mix = (a: number, b: number) => Math.round(a + (b - a) * frac);
  return `rgb(${mix(r1, r2)}, ${mix(g1, g2)}, ${mix(b1, b2)})`;
}
