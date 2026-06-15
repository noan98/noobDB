/**
 * 数値セルの条件付き書式 (データバー / ヒートマップ) の純ロジック。
 *
 * **表示専用**。列内の min/max を基準に値を正規化し、セル背景の「バー幅」や
 * 「ヒート色」を算出するだけで、コピー・編集・エクスポートの実値には一切影響
 * しない。NULL / 非数値は対象外 (無着色) として明示的に弾く。
 *
 * ヒート色のランプ定義と値 → 色のサンプリングは、可視化全体で共有する
 * カラースケール体系 (`src/colorScale.ts`、#525) を参照する (色を二重定義しない)。
 *
 * すべて副作用のない純関数として切り出し、`cellConditionalFormat.test.ts` で
 * 単体テストする。色/幅マッピングと正規化のリグレッションをここで固定する。
 */

import { SEQUENTIAL_RAMPS, DIVERGING_RAMPS, sampleRamp } from "../colorScale";
import type { ColorRamp } from "../colorScale";

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

/**
 * ヒートマップのパレット定義。共有カラースケール (`colorScale.ts`) の `ColorRamp` を
 * そのまま使う (key / colorBlindSafe / stops を持つ)。
 */
export type HeatPalette = ColorRamp;

/**
 * ヒートマップで選べるパレット。共有スケール体系 (#525) から引く:
 * `blue` / `teal` は単一色相の連続スケールで赤緑色弱でも明度差で読めるため CB セーフ。
 * `warmCool` は青→赤の発散スケールで直感的だが赤緑が同居するため CB セーフではない
 * (選択は任意)。i18n キー `gridPalette_warmCool` との互換のため発散ランプ `coolWarm` を
 * `warmCool` キーで公開する。
 */
export const HEAT_PALETTES: Record<string, HeatPalette> = {
  blue: SEQUENTIAL_RAMPS.blue,
  teal: SEQUENTIAL_RAMPS.teal,
  warmCool: { ...DIVERGING_RAMPS.coolWarm, key: "warmCool" },
};

export const DEFAULT_HEAT_PALETTE = "blue";

/**
 * 正規化値 `t` (0–1) をパレット上の色へ写像し `rgb(...)` 文字列で返す。隣接ストップ
 * を線形補間する。`t` はクランプする。実体は共有スケールの `sampleRamp`。
 */
export function heatmapColor(t: number, palette: HeatPalette): string {
  return sampleRamp(t, palette.stops);
}
