/**
 * グローバルアクセントカラーのための純粋ロジック。
 *
 * テーマ (`theme.ts` / `App.css`) のアクセントは既定では `--accent` /
 * `--accent-hover` / `--accent-text` の 3 つの CSS 変数で表現され、ライト/ダークで
 * 別々の固定値を持つ。ユーザーがアクセント色を選んだときは、その 1 色を基準に
 * この 3 変数を実行時に算出して `App.tsx` から注入する (`settings.accentColor`)。
 *
 * - hover 色: ライトでは黒へ、ダークでは白へ少し混ぜて明暗を付ける。
 * - 前景色 (アクセント地に乗る文字): 白と濃紺のうちコントラスト比が高い方を選び、
 *   WCAG AA (4.5:1) をできる限り満たす。
 *
 * いずれも DOM に依存しない純粋関数なので Vitest で直接検証できる。
 */

import type { Theme } from "./settings";

/** アクセント地に乗せる暗い前景色。テーマの dark `--accent-text` と同値。 */
export const ACCENT_FG_DARK = "#0a2540";
/** アクセント地に乗せる明るい前景色。 */
export const ACCENT_FG_LIGHT = "#ffffff";

export interface AccentPreset {
  /** i18n ラベルキー解決に使う安定キー。 */
  key: string;
  /** プリセットの色。`null` はテーマ既定 (CSS の固定値) を意味する。 */
  hex: string | null;
}

/**
 * 設定画面に並べるアクセントのプリセット。先頭の "default" はテーマ既定 (色を
 * 注入せず CSS の `--accent` をそのまま使う)。それ以外はライト/ダーク双方で
 * 前景コントラストを確保しやすい、彩度を抑えた色を選んでいる。
 */
export const ACCENT_PRESETS: AccentPreset[] = [
  { key: "default", hex: null },
  { key: "blue", hex: "#2563eb" },
  { key: "indigo", hex: "#4f46e5" },
  { key: "violet", hex: "#7c3aed" },
  { key: "teal", hex: "#0f766e" },
  { key: "green", hex: "#15803d" },
  { key: "amber", hex: "#b45309" },
  { key: "rose", hex: "#e11d48" },
];

function clampByte(n: number): number {
  if (n < 0) return 0;
  if (n > 255) return 255;
  return Math.round(n);
}

/** `#rrggbb` を `[r, g, b]` (0–255) に分解する。不正な入力では null。 */
export function parseHex(hex: string): [number, number, number] | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  const h = hex.slice(1);
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function toHex(rgb: [number, number, number]): string {
  return (
    "#" +
    rgb
      .map((c) => clampByte(c).toString(16).padStart(2, "0"))
      .join("")
  );
}

/** `base` を `target` 方向へ `amount` (0–1) 混ぜる。 */
function mix(
  base: [number, number, number],
  target: [number, number, number],
  amount: number,
): [number, number, number] {
  const a = Math.max(0, Math.min(1, amount));
  return [
    base[0] + (target[0] - base[0]) * a,
    base[1] + (target[1] - base[1]) * a,
    base[2] + (target[2] - base[2]) * a,
  ];
}

function srgbToLinear(c: number): number {
  const cs = c / 255;
  return cs <= 0.03928 ? cs / 12.92 : ((cs + 0.055) / 1.055) ** 2.4;
}

function luminance(rgb: [number, number, number]): number {
  return (
    0.2126 * srgbToLinear(rgb[0]) +
    0.7152 * srgbToLinear(rgb[1]) +
    0.0722 * srgbToLinear(rgb[2])
  );
}

/** 2 色のコントラスト比 (1–21)。入力が不正なら 1 を返す。 */
export function contrastRatio(a: string, b: string): number {
  const ra = parseHex(a);
  const rb = parseHex(b);
  if (!ra || !rb) return 1;
  const la = luminance(ra);
  const lb = luminance(rb);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * アクセント地に乗せる前景文字色。白と濃紺のうちコントラスト比が高い方を返す。
 * 不正な hex のときは白を返す。
 */
export function accentForeground(hex: string): string {
  if (!parseHex(hex)) return ACCENT_FG_LIGHT;
  const onWhite = contrastRatio(hex, ACCENT_FG_LIGHT);
  const onDark = contrastRatio(hex, ACCENT_FG_DARK);
  return onWhite >= onDark ? ACCENT_FG_LIGHT : ACCENT_FG_DARK;
}

/**
 * hover 時のアクセント色。ライトでは黒へ、ダークでは白へ混ぜて明暗を付ける。
 * 不正な hex のときは入力をそのまま返す。
 */
export function accentHover(hex: string, theme: Theme): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const target: [number, number, number] =
    theme === "dark" ? [255, 255, 255] : [0, 0, 0];
  const amount = theme === "dark" ? 0.18 : 0.16;
  return toHex(mix(rgb, target, amount));
}

export interface AccentVars {
  accent: string;
  accentHover: string;
  accentText: string;
}

/**
 * 選択されたアクセント色から、注入すべき 3 つの CSS 変数値を算出する。
 * `App.tsx` がこれを `--accent` / `--accent-hover` / `--accent-text` に書き込む。
 */
export function accentVars(hex: string, theme: Theme): AccentVars {
  return {
    accent: hex,
    accentHover: accentHover(hex, theme),
    accentText: accentForeground(hex),
  };
}
