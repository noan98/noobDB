/**
 * テーマプリセットのミニパレットプレビュー (#789) の純ロジック。
 *
 * 設定画面のテーマプリセット選択がテキストラベルのみで、実際に選択して画面全体を
 * 切り替えるまで見た目が分からない (テーマ資産が「発見されない」) 問題への対応。
 * 各プリセットの代表的な CSS 変数値 (背景 / サーフェス / アクセント / テキスト /
 * キーワード色) を data-theme 属性値ごとに保持し、`SettingsView` がスウォッチ付き
 * カードとして描画する。
 *
 * ## 色値の二重管理について
 *
 * 実行時に `document.documentElement` の `data-theme` 属性を一時的に全プリセット分
 * スワップして `getComputedStyle` で読み取る案も検討したが、(1) ルート要素の属性を
 * 連続でスワップする処理は `App.tsx` が `data-theme` を購読する副作用
 * (`useEffect(() => root.setAttribute(...))`) と競合しうる、(2) `App.css` を
 * `?raw` でバンドルに含める代替も本リポジトリでは**テスト専用**の技法として使われて
 * おり (`themeContrast.test.ts` 等)、本番バンドルへ 4000 行超の CSS 全文を文字列と
 * して含めるのはバンドルサイズ観点で見合わない — という理由から、
 * **静的マップ + 同期テストで固定する方式**を採用した (CLAUDE.md が許容する代替案)。
 * 値は `src/App.css` の各 `:root[data-theme="..."]` ブロック (および素の `:root` /
 * `:root[data-theme="dark"]`) の `--bg` / `--bg-elevated` / `--accent` / `--text` /
 * `--syntax-keyword` と**厳密に一致**させること。ズレは
 * `src/__tests__/themePresetPreview.test.ts` が `App.css?raw` を解析して検出する
 * (App.css 側の値を変更したらこのマップも追随させる)。
 */

import { themePresetDataTheme, type Theme, type ThemePreset } from "./settings";

/** プレビューに使う代表トークンの組。 */
export interface ThemePreviewColors {
  bg: string;
  surface: string;
  accent: string;
  text: string;
  keyword: string;
}

/**
 * data-theme 属性値 → 代表色。`App.css` の対応ブロックの `--bg` / `--bg-elevated` /
 * `--accent` / `--text` / `--syntax-keyword` と同値を保つこと。
 * (`themePresetDataTheme` が返す値の全網羅: "light"/"dark" は既定プリセット、
 * 残りは追加プリセットの `data-theme` 値。)
 */
const PREVIEW_COLORS_BY_DATA_THEME: Record<string, ThemePreviewColors> = {
  // 既定 (:root / :root[data-theme="dark"])
  light: { bg: "#f5f7fa", surface: "#ffffff", accent: "#2563eb", text: "#1a2330", keyword: "#7c3aed" },
  dark: { bg: "#0d1117", surface: "#161b22", accent: "#4c93f7", text: "#e6edf3", keyword: "#c4b5fd" },
  // Dracula (ダーク専用)
  "dracula-dark": {
    bg: "#282a36",
    surface: "#343746",
    accent: "#bd93f9",
    text: "#f8f8f2",
    keyword: "#ff79c6",
  },
  // Nord (ダーク専用)
  "nord-dark": { bg: "#2e3440", surface: "#3b4252", accent: "#88c0d0", text: "#eceff4", keyword: "#81a1c1" },
  // Solarized (light/dark 追従)
  "solarized-light": {
    bg: "#fdf6e3",
    surface: "#fffcf2",
    accent: "#1e6ea5",
    text: "#073642",
    keyword: "#627100",
  },
  "solarized-dark": {
    bg: "#002b36",
    surface: "#073642",
    accent: "#3ca2e8",
    text: "#eee8d5",
    keyword: "#8fa800",
  },
  // One Dark (ダーク専用)
  "one-dark": { bg: "#282c34", surface: "#2f343e", accent: "#61afef", text: "#d7dae0", keyword: "#c678dd" },
  // High contrast (light/dark 追従)
  "hc-light": { bg: "#ffffff", surface: "#ffffff", accent: "#0033cc", text: "#000000", keyword: "#0000cc" },
  "hc-dark": { bg: "#000000", surface: "#121212", accent: "#66a3ff", text: "#ffffff", keyword: "#d98cff" },
  // Colorblind-safe (light/dark 追従)
  "cb-light": { bg: "#f5f7fa", surface: "#ffffff", accent: "#005b8f", text: "#1a2330", keyword: "#6f3a9e" },
  "cb-dark": { bg: "#0d1117", surface: "#161b22", accent: "#56b4e9", text: "#e6edf3", keyword: "#c79af0" },
};

/**
 * プリセット + 現在の light/dark テーマから、プレビューに使う代表色を返す。
 * `themePresetDataTheme` と同じ合成規則 (ダーク専用プリセットは light/dark 切替を
 * 無視する等) にそのまま追従する。未知の data-theme 値 (将来プリセット追加時の
 * マップ更新漏れ) は現在の theme の既定色へフォールバックする。
 */
export function themePreviewColors(preset: ThemePreset, theme: Theme): ThemePreviewColors {
  const dataTheme = themePresetDataTheme(preset, theme);
  return PREVIEW_COLORS_BY_DATA_THEME[dataTheme] ?? PREVIEW_COLORS_BY_DATA_THEME[theme];
}

/** UI が並べるチップの順序 (安定キー)。ラベル解決は呼び出し側の i18n に委ねる。 */
export const THEME_PREVIEW_CHIP_ORDER: (keyof ThemePreviewColors)[] = [
  "bg",
  "surface",
  "accent",
  "text",
  "keyword",
];

/**
 * `THEME_PREVIEW_CHIP_ORDER` の色を均等分割した CSS `linear-gradient(...)` 文字列を
 * 返す。5 色のチップを別々の DOM 要素として並べると、設定画面のように多数の
 * プリセットカードを同時マウントする場面で要素数が (プリセット数 × チップ数) 分
 * 積み上がりレンダーコストが増える。1 要素の背景グラデーションにまとめることで
 * 見た目 (色の帯が並ぶミニパレット) を保ったまま要素数を減らす (#789)。
 */
export function themePreviewGradient(colors: ThemePreviewColors): string {
  const n = THEME_PREVIEW_CHIP_ORDER.length;
  const stops = THEME_PREVIEW_CHIP_ORDER.map((chip, i) => {
    const from = (i / n) * 100;
    const to = ((i + 1) / n) * 100;
    return `${colors[chip]} ${from}% ${to}%`;
  });
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}
