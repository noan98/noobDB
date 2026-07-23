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
 *
 * ── 調和トーン (#790) ──────────────────────────────────────────────────
 * 上記 3 変数はボタンとフォーカスリング程度にしか効かず、選択行・アクティブ状態
 * などの微弱な面 (`App.css` の `--bg-active` / `--bg-active-strong`、Chakra の
 * `app.active` / `app.activeStrong` トークン) はテーマ固定のトーンのままだった。
 * `accentSubtle` / `accentSelection` はこれらの面をアクセント色から派生させる
 * 追加の純関数で、`App.tsx` が `--accent-subtle` / `--accent-selection` として
 * 注入しつつ、既存の `--bg-active` / `--bg-active-strong` 自体もこの値で上書きする
 * (新しい消費側コンポーネントを増やさず、既存の全消費箇所に一括で波及させるため)。
 *
 * 算出方針: テーマの `--bg` 相当の基準色 (`LIGHT_BG` / `DARK_BG`) へ選択色を
 * `mix()` で少量 (subtle) / やや多め (selection) に混ぜる。混合率は、既定アクセント
 * (`#2563eb` ライト / `#4c93f7` ダーク) を入力したときに `App.css` の既存固定値
 * (`--bg-active` 等) と近似する値を逆算して選んでいるため、**アクセント未変更の
 * ユーザーの見た目は変えない** (this 関数は `settings.accentColor` が非 null の
 * ときだけ呼ばれ、null なら `App.css` の固定値がそのまま使われる)。ただし
 * 基準色→固定値の変換は元々 `mix()` 単体では再現できない非線形な手調整だったため
 * (RGB 各チャンネルで逆算した係数が完全には一致しない)、完全一致ではなく近似値
 * になる。詳細は Issue #790 の PR 説明を参照。
 *
 * WCAG セーフティネット: 混合後の面は非テキストだが、その上に乗る本文
 * (`--text`) の可読性を保証するため、`contrastRatio` で下限 (4.5:1, AA 相当) を
 * 満たすまで混合率を段階的に半減させる。混合率 0 は基準色そのもの
 * (`LIGHT_BG`/`DARK_BG`) を返し、これは常に本文と高コントラストなので必ず収束する。
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

/** ライト/ダークそれぞれの `App.css` `--bg` と一致する調和トーンの基準色。 */
const LIGHT_BG: [number, number, number] = [245, 247, 250]; // #f5f7fa
const DARK_BG: [number, number, number] = [13, 17, 23]; // #0d1117

/** 調和トーンの上に乗る本文の代表色。`App.css` の `--text` (各テーマ) と一致。 */
const LIGHT_TEXT_REF = "#1a2330";
const DARK_TEXT_REF = "#e6edf3";

/**
 * 混合率 (基準色からアクセント色へ寄せる割合)。既定アクセント
 * (`#2563eb` ライト / `#4c93f7` ダーク) を入力したとき、`App.css` の既存固定値
 * (`--bg-active` / `--bg-active-strong`) に近似するよう逆算した値。
 */
const TINT_AMOUNT: Record<Theme, { subtle: number; selection: number }> = {
  light: { subtle: 0.08, selection: 0.16 },
  dark: { subtle: 0.45, selection: 0.6 },
};

/** WCAG AA 相当のコントラスト下限。面塗り自体でなく、その上に乗る本文向け。 */
const MIN_TONE_CONTRAST = 4.5;

function toneBase(theme: Theme): [number, number, number] {
  return theme === "dark" ? DARK_BG : LIGHT_BG;
}

function toneTextRef(theme: Theme): string {
  return theme === "dark" ? DARK_TEXT_REF : LIGHT_TEXT_REF;
}

/**
 * 選択色を基準色 (`--bg` 相当) へ `amount` で混ぜ、混合後の面が `textRef` に対して
 * `MIN_TONE_CONTRAST` を満たすまで `amount` を半減させ続ける。`amount` が 0 に
 * 収束すれば基準色そのもの (本文と常に高コントラスト) になるため必ず終了する。
 */
function harmonicTone(hex: string, theme: Theme, amount: number): string {
  const base = toneBase(theme);
  const rgb = parseHex(hex);
  if (!rgb) return toHex(base);
  const textRef = toneTextRef(theme);
  let a = amount;
  let out = toHex(mix(base, rgb, a));
  let guard = 0;
  while (contrastRatio(out, textRef) < MIN_TONE_CONTRAST && guard < 24) {
    a /= 2;
    out = toHex(mix(base, rgb, a));
    guard += 1;
  }
  return out;
}

/**
 * 選択色から派生する控えめな面塗り (`--bg-active` 相当)。ホバーより一段弱い
 * 「薄くアクセントが香る」トーンで、選択行・アクティブ項目の背景に使う。
 */
export function accentSubtle(hex: string, theme: Theme): string {
  return harmonicTone(hex, theme, TINT_AMOUNT[theme].subtle);
}

/**
 * 選択色から派生するやや強めの面塗り (`--bg-active-strong` 相当)。ソート中の
 * 列見出しなど、選択状態をより強調したい面に使う。
 */
export function accentSelection(hex: string, theme: Theme): string {
  return harmonicTone(hex, theme, TINT_AMOUNT[theme].selection);
}

export interface AccentVars {
  accent: string;
  accentHover: string;
  accentText: string;
  accentSubtle: string;
  accentSelection: string;
}

/**
 * 選択されたアクセント色から、注入すべき CSS 変数値を算出する。`App.tsx` が
 * これを `--accent` / `--accent-hover` / `--accent-text` /
 * `--accent-subtle` / `--accent-selection` に書き込む (後者 2 つは
 * `--bg-active` / `--bg-active-strong` も上書きし、選択行・アクティブ状態に波及させる)。
 */
export function accentVars(hex: string, theme: Theme): AccentVars {
  return {
    accent: hex,
    accentHover: accentHover(hex, theme),
    accentText: accentForeground(hex),
    accentSubtle: accentSubtle(hex, theme),
    accentSelection: accentSelection(hex, theme),
  };
}
