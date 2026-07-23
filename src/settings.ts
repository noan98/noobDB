import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";

export interface SyntaxColors {
  keyword: string;
  string: string;
  number: string;
  comment: string;
  function: string;
  operator: string;
}

export interface Settings {
  syntaxColors: {
    light: SyntaxColors;
    dark: SyntaxColors;
  };
  /** Color used to highlight cells changed by a preview, per theme. */
  previewHighlight: {
    light: string;
    dark: string;
  };
  /** Initial number of rows displayed before streaming continues. */
  defaultDisplayCount: number;
  /** Chunk size used to fetch additional rows once the initial batch has been shown. */
  streamPrefetchSize: number;
  /** Auto-append a LIMIT to ad-hoc SELECT queries that lack one. */
  autoLimitEnabled: boolean;
  /** Row cap applied when auto LIMIT kicks in. */
  autoLimitCount: number;
  /** Show a confirmation dialog when connecting to a profile flagged as production. */
  confirmProductionConnect: boolean;
  /**
   * Show a confirmation dialog before running destructive write statements
   * (WHERE-less UPDATE/DELETE, DROP, TRUNCATE). Production profiles always
   * confirm regardless of this flag.
   */
  confirmDangerousQueries: boolean;
  /**
   * 複数結果タブ: true のとき、エディタでのクエリ実行は現在の結果を
   * 置き換えず、SQL を複製した**新しいタブ**で実行して前の結果を残す。複数クエリの
   * 結果を別タブとして保持・比較できるようにする。
   */
  resultsInNewTab: boolean;
  /** Behavior when previously open tabs exist for a profile being reconnected. */
  tabRestoreMode: TabRestoreMode;
  /**
   * Automatically abort an editor query that runs longer than this many
   * seconds. `0` disables the timeout (queries run unbounded as before).
   */
  queryTimeoutSecs: number;
  /**
   * Overall deadline (seconds) for a whole connection attempt — SSH tunnel
   * connect + auth and DB connect together (#684). Stops an unreachable host
   * from hanging on the OS TCP timeout. Backend clamps to [5, 300]; `0`/unset
   * uses the backend default.
   */
  connectTimeoutSecs: number;
  /**
   * Base UI font size in pixels. Scales the whole interface uniformly via the
   * --font-scale CSS variable (scale = fontSizePx / BASE_FONT_SIZE_PX).
   */
  fontSizePx: number;
  /**
   * Global accent color (hex `#rrggbb`) applied across buttons, selection,
   * focus rings and active tabs. `null` keeps the per-theme default accent
   * baked into App.css. Foreground/hover are derived at runtime (see accent.ts).
   */
  accentColor: string | null;
  /**
   * UI density preset. Drives row height / cell padding *and* the vertical
   * padding of interactive controls (buttons / inputs / select / textarea)
   * independently of the font size, via the `data-density` attribute and the
   * `--density-*` / `--control-*` CSS vars (#410, #620). So the same preset
   * tightens or loosens the grid, forms, sidebar and modal footers uniformly.
   */
  density: Density;
  /**
   * Interval (seconds) applied when the result grid's auto-refresh (scheduled
   * re-execution) is toggled on. Remembered globally so the last chosen cadence
   * becomes the default for the next tab. Clamped to AUTO_REFRESH_MIN_SECS.
   */
  autoRefreshDefaultSecs: number;
  /**
   * ライブクエリ・インスペクタ (#746) のポーリング間隔 (秒)。エンジンのメモリ上の
   * 統計を読むだけの軽い SELECT なので、結果グリッドの自動リフレッシュより短い
   * 下限 (2 秒) を許す。記録中のみポーリングされる。
   */
  inspectorPollIntervalSecs: number;
  /** N+1 判定 (#746): 時間窓内でこの回数以上同型クエリが観測されたらフラグする。 */
  inspectorNPlusOneMinCount: number;
  /** N+1 判定 (#746): 「1 リクエスト相当」とみなす時間窓 (ms)。 */
  inspectorNPlusOneWindowMs: number;
  /**
   * How the result grid navigates rows: "scroll" keeps the existing infinite-scroll
   * behaviour; "paginate" adds a footer with page controls instead.
   */
  resultGridMode: ResultGridMode;
  /** Number of rows per page when resultGridMode is "paginate". */
  resultGridPageSize: number;
  /**
   * Behavior when the inline cell editor loses focus (blur). "commit"
   * auto-commits the typed value as a pending edit (the historical default);
   * "confirm" shows a dialog so the user can choose to commit or discard,
   * guarding against accidentally clicking away and losing an in-progress edit.
   */
  cellEditOnBlur: CellEditOnBlur;
  /**
   * Render cell values with type-aware formatting in the result grid: compact
   * JSON, localized date/time, boolean badges and enum color badges.
   * Display-only — copy/edit/export always keep the original value. Turn off to
   * see every cell as the raw string the driver returned.
   */
  richCellRendering: boolean;
  /**
   * Preferred monospace font family for the editor, result grid and code views.
   * `null` keeps the App.css default mono stack. A non-null value is
   * prepended to the shared fallback chain so an uninstalled font degrades
   * gracefully. Driven into the `--font-mono` CSS variable at runtime.
   */
  monoFontFamily: string | null;
  /**
   * Preferred UI (sans-serif) font family. `null` keeps the App.css
   * default sans stack. Prepended to the shared sans fallback chain and driven
   * into `--font-sans` at runtime.
   */
  uiFontFamily: string | null;
  /**
   * Color theme preset. `default` follows the light/dark toggle with the
   * stock palette; other presets are full palettes (currently `dracula`,
   * dark-only) selected via the `data-theme` attribute. Independent of accent
   * color, density and syntax colors, which still override at runtime.
   */
  themePreset: ThemePreset;
  /**
   * Automatically re-establish a dropped connection (idle timeout, network /
   * VPN drop, SSH tunnel loss) using the same profile, with exponential
   * backoff. When off, a dropped connection surfaces a manual Reconnect button
   * instead. A drop detected mid (explicit) transaction never auto-reconnects.
   */
  autoReconnectEnabled: boolean;
  /** Maximum number of auto-reconnect attempts before giving up (clamped 1..20). */
  autoReconnectMaxRetries: number;
  /**
   * ユーザによるキーボードショートカットの上書き (#557)。`ShortcutId` →
   * コンボ文字列 (`shortcutKeys.ts` の正規化形式)。未設定の id は
   * `shortcuts.ts` の既定にフォールバックする。`resolveShortcutBindings` で
   * 既定にマージして利用する。
   */
  shortcutOverrides: Record<string, string>;
  /**
   * 長時間クエリ完了時に OS デスクトップ通知を出す (#707)。ウィンドウが
   * 非フォーカスかつ実行時間が `queryNotificationThresholdSecs` 以上のときのみ
   * 発火する (判定は `queryNotify.ts`)。
   */
  queryNotificationsEnabled: boolean;
  /**
   * クエリ完了通知を出すまでの経過時間の閾値 (秒)。この秒数未満で完了した
   * クエリは (ウィンドウが非フォーカスでも) 通知しない。
   */
  queryNotificationThresholdSecs: number;
  /**
   * 起動時にアプリの更新を自動チェックする (#705)。既定オン。オフにすると
   * 起動時の自動チェックを止め、設定画面の「更新を確認」ボタンからの手動
   * チェックのみになる (オフライン/社内配布/手動運用向けの逃げ道)。ダウンロード・
   * 適用・再起動は本設定に関係なく常にユーザ承認制で、勝手には行われない。
   */
  autoUpdateCheckEnabled: boolean;
  /**
   * クエリエディタのリアルタイム SQL 構文チェック (#704)。既定オン。オンのとき
   * CodeMirror の Lezer パースツリーを使い、括弧の不整合・未終端の文字列/引用符
   * などを実行前に下線 + ガターで表示する。ベストエフォートの編集支援であり
   * 安全判定ではない。誤検出が気になるユーザ向けにオフにできる。
   */
  sqlLintEnabled: boolean;
  /**
   * 実行前の影響行数プリフライト (#737)。既定オン。オンのとき、エディタの現在文が
   * 単純な UPDATE / DELETE のとき対象テーブルと WHERE から `SELECT COUNT(*)` を
   * 組み立ててデバウンス付きで裏実行し、「影響: 約 N 行」「影響: 全行」バッジを
   * 実行ボタン付近に常時表示する。COUNT は読み取りで履歴も汚さないが、重い
   * テーブルへの裏 COUNT を避けたい場合にオフにできる。
   */
  preflightImpactEnabled: boolean;
  /**
   * 実行計画ウォッチ (#743): 接続確立時にウォッチ登録済みスニペットの EXPLAIN を
   * 自動取得して世代記録・変化検知を行う。既定オン。EXPLAIN は読み取り操作のみで
   * 履歴も汚さないが、接続直後の負荷を避けたい場合にオフにできる。
   */
  planWatchOnConnect: boolean;
  /**
   * アプリ内モーション量コントロール (#787)。既定は `system` で、これまでどおり
   * OS の `prefers-reduced-motion` に追従する (`main.tsx` の
   * `MotionConfig reducedMotion="user"` + `App.css` の
   * `@media (prefers-reduced-motion: reduce)`)。`reduced` は OS 設定に関わらず
   * 常にモーションを抑制し、`full` は OS が「動きを減らす」でも常にモーションを
   * 有効化する。OS 設定を変更できない/したくないユーザや、逆に動きを積極的に
   * 楽しみたいユーザ向けのアプリ内の逃げ道。
   */
  motionPreference: MotionPreference;
}

/**
 * Color theme presets. `default` = stock light/dark.
 *
 * - `dracula` — dark-only Dracula palette (#465).
 * - `high-contrast` — WCAG AAA-leaning palette that follows the light/dark
 *   toggle (`hc-light` / `hc-dark`). Pure black/white text on near-pure
 *   backgrounds with strong borders (#558).
 * - `colorblind` — colorblind-safe (Okabe-Ito based) palette that follows the
 *   light/dark toggle (`cb-light` / `cb-dark`). Status / cell / syntax colors
 *   avoid the red↔green axis, using blue / orange / bluish-green / yellow so
 *   states stay distinguishable under red-green (protan/deutan) and blue-yellow
 *   (tritan) color vision (#558).
 * - `nord` — dark-only Nord palette (arctic bluish palette, #598). Aurora /
 *   Frost hues brightened where needed to keep WCAG AA.
 * - `solarized` — Solarized palette that follows the light/dark toggle
 *   (`solarized-light` / `solarized-dark`, #598). Accent hues darkened /
 *   brightened from the canonical values where needed to keep WCAG AA.
 * - `one-dark` — dark-only One Dark (Atom) palette (#598).
 */
export type ThemePreset =
  | "default"
  | "dracula"
  | "nord"
  | "solarized"
  | "one-dark"
  | "high-contrast"
  | "colorblind";

/** Presets offered in settings, in display order. */
export const THEME_PRESET_ORDER: ThemePreset[] = [
  "default",
  "dracula",
  "nord",
  "solarized",
  "one-dark",
  "high-contrast",
  "colorblind",
];
export const DEFAULT_THEME_PRESET: ThemePreset = "default";

/**
 * Maps a preset + the current light/dark theme to the `data-theme` attribute
 * value. Dark-only presets ignore the light/dark toggle. Names end with
 * "-dark"/"-light" so theme.ts `conditions.dark` ([data-theme$=dark]) resolves
 * colored-button tokens correctly.
 */
export function themePresetDataTheme(preset: ThemePreset, theme: Theme): string {
  if (preset === "dracula") return "dracula-dark";
  // Nord / One Dark はダーク専用プリセット (dracula と同じ方式)。名前が "dark" で
  // 終わるため theme.ts の conditions.dark ([data-theme$=dark]) に一致する。
  if (preset === "nord") return "nord-dark";
  if (preset === "one-dark") return "one-dark";
  // solarized / high-contrast / colorblind keep the light/dark axis: the
  // matching App.css block (`solarized-light`/`solarized-dark`,
  // `hc-light`/`hc-dark`, `cb-light`/`cb-dark`) fully overrides the palette
  // while inheriting layout/spacing tokens from `:root`.
  if (preset === "solarized") return theme === "dark" ? "solarized-dark" : "solarized-light";
  if (preset === "high-contrast") return theme === "dark" ? "hc-dark" : "hc-light";
  if (preset === "colorblind") return theme === "dark" ? "cb-dark" : "cb-light";
  return theme;
}

export type TabRestoreMode = "always" | "ask" | "never";

export type ResultGridMode = "scroll" | "paginate";

export type CellEditOnBlur = "commit" | "confirm";
/** Preserve the historical auto-commit behavior; the guard is opt-in. */
export const DEFAULT_CELL_EDIT_ON_BLUR: CellEditOnBlur = "commit";

/** Rich cell rendering is on by default; it is a display-only enhancement. */
export const DEFAULT_RICH_CELL_RENDERING = true;

/** Font family defaults: `null` means "use the App.css default stack". */
export const DEFAULT_MONO_FONT_FAMILY: string | null = null;
export const DEFAULT_UI_FONT_FAMILY: string | null = null;

/** Shared fallback chains, kept in sync with App.css `--font-mono` / `--font-sans`. */
export const MONO_FONT_FALLBACK = 'ui-monospace, "SF Mono", Consolas, monospace';
export const UI_FONT_FALLBACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Noto Sans CJK JP", sans-serif';

/** Monospace presets offered in the appearance settings (primary family names). */
export const MONO_FONT_PRESETS = [
  "JetBrains Mono",
  "Fira Code",
  "Cascadia Code",
  "Source Code Pro",
  "IBM Plex Mono",
  "Menlo",
  "Consolas",
] as const;

/** UI (sans) presets offered in the appearance settings. */
export const UI_FONT_PRESETS = [
  "Inter",
  "Roboto",
  "Segoe UI",
  "Helvetica Neue",
  "Arial",
] as const;

/** Wrap a family name in quotes when it contains spaces (and isn't already quoted). */
function quoteFamily(family: string): string {
  const f = family.trim();
  if (/[\s]/.test(f) && !/^['"].*['"]$/.test(f)) return `"${f}"`;
  return f;
}

/**
 * Builds a full font stack from a chosen family by prepending it to the shared
 * fallback chain, so an uninstalled font degrades to the platform default
 * instead of breaking. Returns `null` for the default (no override).
 */
export function monoFontStack(family: string | null): string | null {
  if (!family) return null;
  return `${quoteFamily(family)}, ${MONO_FONT_FALLBACK}`;
}

export function uiFontStack(family: string | null): string | null {
  if (!family) return null;
  return `${quoteFamily(family)}, ${UI_FONT_FALLBACK}`;
}

export type Density = "compact" | "normal" | "spacious";

/** Density presets offered in the appearance settings, in display order. */
export const DENSITY_ORDER: Density[] = ["compact", "normal", "spacious"];
export const DEFAULT_DENSITY: Density = "normal";

/**
 * モーション量プリファレンス (#787). `system` は OS の `prefers-reduced-motion`
 * に追従 (既定)、`full` は OS 設定に関わらず常にモーション有効、`reduced` は
 * OS 設定に関わらず常に抑制する。値はそのまま `document.documentElement` の
 * `data-motion` 属性に反映され (`App.tsx`)、`App.css` の
 * `:root[data-motion="reduced"]` / `:root[data-motion="full"]` ルールと
 * `main.tsx` の `MotionConfig reducedMotion` ("user"/"never"/"always") の
 * 両方から参照される単一の情報源。
 */
export type MotionPreference = "system" | "full" | "reduced";

/** モーション量プリファレンスの表示順 (設定 UI のセグメント順)。 */
export const MOTION_PREFERENCE_ORDER: MotionPreference[] = ["system", "full", "reduced"];
export const DEFAULT_MOTION_PREFERENCE: MotionPreference = "system";

/** Default accent color: `null` means "use the per-theme CSS default". */
export const DEFAULT_ACCENT_COLOR: string | null = null;

/** Pixel size that maps to a 1.0 font scale (the unscaled default). */
export const BASE_FONT_SIZE_PX = 14;
export const DEFAULT_FONT_SIZE_PX = BASE_FONT_SIZE_PX;
export const MIN_FONT_SIZE_PX = 10;
export const MAX_FONT_SIZE_PX = 24;

export const DEFAULT_SYNTAX_COLORS: Record<Theme, SyntaxColors> = {
  light: {
    keyword: "#7c3aed",
    string: "#b91c1c",
    number: "#0f5c2e",
    comment: "#6b7280",
    function: "#2563eb",
    operator: "#4b5563",
  },
  dark: {
    keyword: "#c4b5fd",
    string: "#fca5a5",
    number: "#6ee7a8",
    comment: "#8b94a3",
    function: "#93c5fd",
    operator: "#cbd5e1",
  },
};

export type SyntaxPresetKey =
  | "defaultLight"
  | "defaultDark"
  | "solarizedLight"
  | "solarizedDark"
  | "dracula"
  | "nord"
  | "oneDark"
  | "githubLight"
  | "githubDark"
  | "monokai";

export const SYNTAX_PRESET_ORDER: SyntaxPresetKey[] = [
  "defaultLight",
  "defaultDark",
  "solarizedLight",
  "solarizedDark",
  "dracula",
  "nord",
  "oneDark",
  "githubLight",
  "githubDark",
  "monokai",
];

export const SYNTAX_PRESETS: Record<SyntaxPresetKey, SyntaxColors> = {
  defaultLight: DEFAULT_SYNTAX_COLORS.light,
  defaultDark: DEFAULT_SYNTAX_COLORS.dark,
  solarizedLight: {
    keyword: "#859900",
    string: "#2aa198",
    number: "#d33682",
    comment: "#93a1a1",
    function: "#268bd2",
    operator: "#586e75",
  },
  solarizedDark: {
    keyword: "#859900",
    string: "#2aa198",
    number: "#d33682",
    comment: "#586e75",
    function: "#268bd2",
    operator: "#93a1a1",
  },
  dracula: {
    keyword: "#ff79c6",
    string: "#f1fa8c",
    number: "#bd93f9",
    comment: "#6272a4",
    function: "#50fa7b",
    operator: "#ff79c6",
  },
  // Nord / One Dark はテーマプリセット (#598) の App.css `--syntax-*` と同値。
  // テーマプリセット選択後にここから同名プリセットを適用するとエディタの
  // シンタックス配色が UI 全体の配色と一貫する。
  nord: {
    keyword: "#81a1c1",
    string: "#a3be8c",
    number: "#b48ead",
    comment: "#94a3bd",
    function: "#88c0d0",
    operator: "#d8dee9",
  },
  oneDark: {
    keyword: "#c678dd",
    string: "#98c379",
    number: "#e5c07b",
    comment: "#8b93a2",
    function: "#61afef",
    operator: "#abb2bf",
  },
  githubLight: {
    keyword: "#cf222e",
    string: "#0a3069",
    number: "#0550ae",
    comment: "#6e7781",
    function: "#8250df",
    operator: "#24292f",
  },
  githubDark: {
    keyword: "#ff7b72",
    string: "#a5d6ff",
    number: "#79c0ff",
    comment: "#8b949e",
    function: "#d2a8ff",
    operator: "#c9d1d9",
  },
  monokai: {
    keyword: "#f92672",
    string: "#e6db74",
    number: "#ae81ff",
    comment: "#75715e",
    function: "#66d9ef",
    operator: "#f8f8f2",
  },
};

/**
 * Returns the preset key whose palette exactly matches `colors`, or null
 * when the colors have been edited beyond any preset (i.e. "Custom").
 */
export function detectSyntaxPreset(colors: SyntaxColors): SyntaxPresetKey | null {
  const keys = Object.keys(colors) as (keyof SyntaxColors)[];
  for (const name of SYNTAX_PRESET_ORDER) {
    const palette = SYNTAX_PRESETS[name];
    if (keys.every((k) => palette[k].toLowerCase() === colors[k].toLowerCase())) {
      return name;
    }
  }
  return null;
}

export const DEFAULT_PREVIEW_HIGHLIGHT: Record<Theme, string> = {
  light: "#2563eb",
  dark: "#3b82f6",
};

export const DEFAULT_DISPLAY_COUNT = 100;
export const DEFAULT_STREAM_PREFETCH_SIZE = 200;
export const DEFAULT_AUTO_LIMIT_ENABLED = true;
export const DEFAULT_AUTO_LIMIT_COUNT = 1000;
const MIN_BATCH = 1;
const MAX_BATCH = 100_000;

export const DEFAULT_CONFIRM_PRODUCTION_CONNECT = true;

export const DEFAULT_CONFIRM_DANGEROUS_QUERIES = true;

export const DEFAULT_TAB_RESTORE_MODE: TabRestoreMode = "ask";

export const DEFAULT_QUERY_TIMEOUT_SECS = 30;
const MAX_QUERY_TIMEOUT_SECS = 86_400;

/** Connect timeout defaults/bounds, mirroring the backend clamp (#684). */
export const DEFAULT_CONNECT_TIMEOUT_SECS = 30;
export const MIN_CONNECT_TIMEOUT_SECS = 5;
export const MAX_CONNECT_TIMEOUT_SECS = 300;

export const DEFAULT_RESULT_GRID_MODE: ResultGridMode = "scroll";
export const DEFAULT_RESULT_GRID_PAGE_SIZE = 100;
/** Page-size options offered in the result grid's paginator selector. */
export const RESULT_GRID_PAGE_SIZE_OPTIONS = [50, 100, 200, 500, 1000] as const;
const MIN_PAGE_SIZE = 1;
const MAX_PAGE_SIZE = 100_000;

/**
 * Smallest auto-refresh cadence we allow. Polling faster than this risks
 * piling load onto the DB and connection pool for little practical gain.
 */
export const AUTO_REFRESH_MIN_SECS = 5;
const AUTO_REFRESH_MAX_SECS = 3_600;
/** Preset cadences offered in the result grid's auto-refresh selector. */
export const AUTO_REFRESH_INTERVAL_OPTIONS = [5, 10, 30, 60, 300] as const;
export const DEFAULT_AUTO_REFRESH_SECS = 10;

/** ライブクエリ・インスペクタ (#746) のポーリング間隔プリセットと境界。 */
export const INSPECTOR_INTERVAL_OPTIONS = [2, 5, 10, 30] as const;
export const DEFAULT_INSPECTOR_POLL_SECS = 5;
const MIN_INSPECTOR_POLL_SECS = 2;
const MAX_INSPECTOR_POLL_SECS = 300;
/** N+1 判定 (#746) の既定閾値と境界 (`queryInspector.ts` の既定と揃える)。 */
export const DEFAULT_INSPECTOR_N_PLUS_ONE_MIN_COUNT = 10;
export const DEFAULT_INSPECTOR_N_PLUS_ONE_WINDOW_MS = 2000;
const MIN_INSPECTOR_N_PLUS_ONE_MIN_COUNT = 2;
const MAX_INSPECTOR_N_PLUS_ONE_MIN_COUNT = 1000;
const MIN_INSPECTOR_N_PLUS_ONE_WINDOW_MS = 100;
const MAX_INSPECTOR_N_PLUS_ONE_WINDOW_MS = 60_000;

export const DEFAULT_AUTO_RECONNECT_ENABLED = true;
export const DEFAULT_AUTO_RECONNECT_MAX_RETRIES = 5;
export const MIN_AUTO_RECONNECT_RETRIES = 1;
export const MAX_AUTO_RECONNECT_RETRIES = 20;

/** クエリ完了通知 (#707) は既定オン、閾値は既定 10 秒。 */
export const DEFAULT_QUERY_NOTIFICATIONS_ENABLED = true;
export const DEFAULT_QUERY_NOTIFICATION_THRESHOLD_SECS = 10;
export const MIN_QUERY_NOTIFICATION_THRESHOLD_SECS = 1;
export const MAX_QUERY_NOTIFICATION_THRESHOLD_SECS = 3_600;

/** 起動時のアプリ更新チェック (#705) は既定オン。 */
export const DEFAULT_AUTO_UPDATE_CHECK_ENABLED = true;

/** リアルタイム SQL 構文チェック (#704) は既定オン。 */
export const DEFAULT_SQL_LINT_ENABLED = true;

/** 実行前の影響行数プリフライト (#737) は既定オン。 */
export const DEFAULT_PREFLIGHT_IMPACT_ENABLED = true;

/** 実行計画ウォッチ (#743) の接続時自動チェックは既定オン。 */
export const DEFAULT_PLAN_WATCH_ON_CONNECT = true;

export const DEFAULT_SETTINGS: Settings = {
  syntaxColors: {
    light: { ...DEFAULT_SYNTAX_COLORS.light },
    dark: { ...DEFAULT_SYNTAX_COLORS.dark },
  },
  previewHighlight: { ...DEFAULT_PREVIEW_HIGHLIGHT },
  defaultDisplayCount: DEFAULT_DISPLAY_COUNT,
  streamPrefetchSize: DEFAULT_STREAM_PREFETCH_SIZE,
  autoLimitEnabled: DEFAULT_AUTO_LIMIT_ENABLED,
  autoLimitCount: DEFAULT_AUTO_LIMIT_COUNT,
  confirmProductionConnect: DEFAULT_CONFIRM_PRODUCTION_CONNECT,
  confirmDangerousQueries: DEFAULT_CONFIRM_DANGEROUS_QUERIES,
  resultsInNewTab: false,
  tabRestoreMode: DEFAULT_TAB_RESTORE_MODE,
  queryTimeoutSecs: DEFAULT_QUERY_TIMEOUT_SECS,
  connectTimeoutSecs: DEFAULT_CONNECT_TIMEOUT_SECS,
  fontSizePx: DEFAULT_FONT_SIZE_PX,
  accentColor: DEFAULT_ACCENT_COLOR,
  density: DEFAULT_DENSITY,
  autoRefreshDefaultSecs: DEFAULT_AUTO_REFRESH_SECS,
  inspectorPollIntervalSecs: DEFAULT_INSPECTOR_POLL_SECS,
  inspectorNPlusOneMinCount: DEFAULT_INSPECTOR_N_PLUS_ONE_MIN_COUNT,
  inspectorNPlusOneWindowMs: DEFAULT_INSPECTOR_N_PLUS_ONE_WINDOW_MS,
  resultGridMode: DEFAULT_RESULT_GRID_MODE,
  resultGridPageSize: DEFAULT_RESULT_GRID_PAGE_SIZE,
  cellEditOnBlur: DEFAULT_CELL_EDIT_ON_BLUR,
  richCellRendering: DEFAULT_RICH_CELL_RENDERING,
  monoFontFamily: DEFAULT_MONO_FONT_FAMILY,
  uiFontFamily: DEFAULT_UI_FONT_FAMILY,
  themePreset: DEFAULT_THEME_PRESET,
  autoReconnectEnabled: DEFAULT_AUTO_RECONNECT_ENABLED,
  autoReconnectMaxRetries: DEFAULT_AUTO_RECONNECT_MAX_RETRIES,
  shortcutOverrides: {},
  queryNotificationsEnabled: DEFAULT_QUERY_NOTIFICATIONS_ENABLED,
  queryNotificationThresholdSecs: DEFAULT_QUERY_NOTIFICATION_THRESHOLD_SECS,
  autoUpdateCheckEnabled: DEFAULT_AUTO_UPDATE_CHECK_ENABLED,
  sqlLintEnabled: DEFAULT_SQL_LINT_ENABLED,
  preflightImpactEnabled: DEFAULT_PREFLIGHT_IMPACT_ENABLED,
  planWatchOnConnect: DEFAULT_PLAN_WATCH_ON_CONNECT,
  motionPreference: DEFAULT_MOTION_PREFERENCE,
};

/** Clamps the auto-reconnect retry count to the allowed range. */
export function sanitizeAutoReconnectRetries(input: unknown, fallback: number): number {
  if (typeof input !== "number" || !Number.isFinite(input)) return fallback;
  const n = Math.floor(input);
  if (n < MIN_AUTO_RECONNECT_RETRIES) return MIN_AUTO_RECONNECT_RETRIES;
  if (n > MAX_AUTO_RECONNECT_RETRIES) return MAX_AUTO_RECONNECT_RETRIES;
  return n;
}

/** Clamps an auto-refresh cadence (seconds) to the allowed range. */
export function sanitizeAutoRefreshSecs(input: unknown, fallback: number): number {
  if (typeof input !== "number" || !Number.isFinite(input)) return fallback;
  const n = Math.floor(input);
  if (n < AUTO_REFRESH_MIN_SECS) return AUTO_REFRESH_MIN_SECS;
  if (n > AUTO_REFRESH_MAX_SECS) return AUTO_REFRESH_MAX_SECS;
  return n;
}

/** 整数値を [min, max] に丸める共通クランプ (インスペクタ #746 の各設定用)。 */
function sanitizeIntInRange(input: unknown, fallback: number, min: number, max: number): number {
  if (typeof input !== "number" || !Number.isFinite(input)) return fallback;
  const n = Math.floor(input);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/** Clamps the query-completion notification threshold (seconds) to the allowed range (#707). */
export function sanitizeQueryNotificationThresholdSecs(input: unknown, fallback: number): number {
  if (typeof input !== "number" || !Number.isFinite(input)) return fallback;
  const n = Math.floor(input);
  if (n < MIN_QUERY_NOTIFICATION_THRESHOLD_SECS) return MIN_QUERY_NOTIFICATION_THRESHOLD_SECS;
  if (n > MAX_QUERY_NOTIFICATION_THRESHOLD_SECS) return MAX_QUERY_NOTIFICATION_THRESHOLD_SECS;
  return n;
}

/** Clamps a timeout (seconds) to a non-negative integer; `0` means disabled. */
function sanitizeTimeout(input: unknown, fallback: number): number {
  if (typeof input !== "number" || !Number.isFinite(input)) return fallback;
  const n = Math.floor(input);
  if (n < 0) return 0;
  if (n > MAX_QUERY_TIMEOUT_SECS) return MAX_QUERY_TIMEOUT_SECS;
  return n;
}

/** Clamp a connect timeout to [MIN, MAX], falling back to the default for
 *  invalid input (#684). Mirrors the backend clamp so the two never disagree. */
function sanitizeConnectTimeout(input: unknown): number {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return DEFAULT_CONNECT_TIMEOUT_SECS;
  }
  const n = Math.floor(input);
  // 0 / 非正値は「未設定 = 既定値」を意味する (JSON/バックエンドの clamp と一致)。
  // 最短タイムアウト (MIN) に丸めると、ユーザが 0 にしたとき意図せず 5 秒になる。
  if (n <= 0) return DEFAULT_CONNECT_TIMEOUT_SECS;
  if (n < MIN_CONNECT_TIMEOUT_SECS) return MIN_CONNECT_TIMEOUT_SECS;
  if (n > MAX_CONNECT_TIMEOUT_SECS) return MAX_CONNECT_TIMEOUT_SECS;
  return n;
}

function sanitizeTabRestoreMode(input: unknown, fallback: TabRestoreMode): TabRestoreMode {
  return input === "always" || input === "ask" || input === "never" ? input : fallback;
}

function sanitizeDensity(input: unknown, fallback: Density): Density {
  return input === "compact" || input === "normal" || input === "spacious"
    ? input
    : fallback;
}

function sanitizeResultGridMode(input: unknown, fallback: ResultGridMode): ResultGridMode {
  return input === "scroll" || input === "paginate" ? input : fallback;
}

function sanitizePageSize(input: unknown, fallback: number): number {
  if (typeof input !== "number" || !Number.isFinite(input)) return fallback;
  const n = Math.floor(input);
  if (n < MIN_PAGE_SIZE) return MIN_PAGE_SIZE;
  if (n > MAX_PAGE_SIZE) return MAX_PAGE_SIZE;
  return n;
}

function sanitizeAccentColor(input: unknown, fallback: string | null): string | null {
  if (input === null) return null;
  return isHexColor(input) ? input : fallback;
}

/**
 * Validates a user-provided font family. `null` (default) passes through. A
 * string is trimmed and accepted only when it contains the safe characters a
 * CSS font-family list uses (letters, digits, spaces, quotes, commas, hyphens),
 * guarding against CSS injection via `;{}<>()`. Returns `fallback` otherwise.
 */
function sanitizeFontFamily(input: unknown, fallback: string | null): string | null {
  if (input === null) return null;
  if (typeof input !== "string") return fallback;
  const v = input.trim();
  if (v.length === 0) return null;
  if (v.length > 120) return fallback;
  if (!/^[\w \-'",]+$/.test(v)) return fallback;
  return v;
}

function sanitizeFontSizePx(input: unknown, fallback: number): number {
  if (typeof input !== "number" || !Number.isFinite(input)) return fallback;
  const n = Math.round(input);
  if (n < MIN_FONT_SIZE_PX) return MIN_FONT_SIZE_PX;
  if (n > MAX_FONT_SIZE_PX) return MAX_FONT_SIZE_PX;
  return n;
}

function sanitizeThemePreset(input: unknown, fallback: ThemePreset): ThemePreset {
  return THEME_PRESET_ORDER.includes(input as ThemePreset) ? (input as ThemePreset) : fallback;
}

function sanitizeMotionPreference(input: unknown, fallback: MotionPreference): MotionPreference {
  return MOTION_PREFERENCE_ORDER.includes(input as MotionPreference)
    ? (input as MotionPreference)
    : fallback;
}

/**
 * 永続化されたショートカット上書きマップを検証する。文字列値のエントリのみ
 * 受け入れ、空文字や非文字列は捨てる (壊れた localStorage 耐性)。id の妥当性は
 * `resolveShortcutBindings` 側で既知 id のみ採用するため、ここでは形だけ整える。
 */
function sanitizeShortcutOverrides(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (input && typeof input === "object") {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim().length > 0) out[k] = v;
    }
  }
  return out;
}

const STORAGE_KEY = "noobdb.settings";

function isHexColor(v: unknown): v is string {
  return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
}

function sanitizeColors(input: unknown, fallback: SyntaxColors): SyntaxColors {
  const out: SyntaxColors = { ...fallback };
  if (input && typeof input === "object") {
    for (const key of Object.keys(fallback) as (keyof SyntaxColors)[]) {
      const v = (input as Record<string, unknown>)[key];
      if (isHexColor(v)) out[key] = v;
    }
  }
  return out;
}

function sanitizeCount(input: unknown, fallback: number): number {
  if (typeof input !== "number" || !Number.isFinite(input)) return fallback;
  const n = Math.floor(input);
  if (n < MIN_BATCH) return MIN_BATCH;
  if (n > MAX_BATCH) return MAX_BATCH;
  return n;
}

function sanitizeHighlight(input: unknown, fallback: string): string {
  return isHexColor(input) ? input : fallback;
}

/**
 * Coerces already-parsed JSON (of unknown shape) into a fully-valid `Settings`,
 * field by field. Pure (no storage access) so it can be unit-tested directly
 * against legacy formats, missing keys, and type mismatches. Each field falls
 * back to its default when absent or malformed, so a partially-corrupt blob
 * never crashes the store or surfaces an out-of-range value. A non-object input
 * (number, string, array, null) collapses to `DEFAULT_SETTINGS`.
 */
export function normalizeSettings(input: unknown): Settings {
  if (!input || typeof input !== "object") return DEFAULT_SETTINGS;
  const parsed = input as {
    syntaxColors?: { light?: unknown; dark?: unknown };
    previewHighlight?: { light?: unknown; dark?: unknown };
    defaultDisplayCount?: unknown;
    streamPrefetchSize?: unknown;
    autoLimitEnabled?: unknown;
    autoLimitCount?: unknown;
    confirmProductionConnect?: unknown;
    confirmDangerousQueries?: unknown;
    resultsInNewTab?: unknown;
    tabRestoreMode?: unknown;
    queryTimeoutSecs?: unknown;
    connectTimeoutSecs?: unknown;
    fontSizePx?: unknown;
    accentColor?: unknown;
    density?: unknown;
    autoRefreshDefaultSecs?: unknown;
    inspectorPollIntervalSecs?: unknown;
    inspectorNPlusOneMinCount?: unknown;
    inspectorNPlusOneWindowMs?: unknown;
    resultGridMode?: unknown;
    resultGridPageSize?: unknown;
    cellEditOnBlur?: unknown;
    richCellRendering?: unknown;
    monoFontFamily?: unknown;
    uiFontFamily?: unknown;
    themePreset?: unknown;
    autoReconnectEnabled?: unknown;
    autoReconnectMaxRetries?: unknown;
    shortcutOverrides?: unknown;
    queryNotificationsEnabled?: unknown;
    queryNotificationThresholdSecs?: unknown;
    autoUpdateCheckEnabled?: unknown;
    sqlLintEnabled?: unknown;
    preflightImpactEnabled?: unknown;
    planWatchOnConnect?: unknown;
    motionPreference?: unknown;
  };
  return {
    syntaxColors: {
      light: sanitizeColors(parsed.syntaxColors?.light, DEFAULT_SYNTAX_COLORS.light),
      dark: sanitizeColors(parsed.syntaxColors?.dark, DEFAULT_SYNTAX_COLORS.dark),
    },
    previewHighlight: {
      light: sanitizeHighlight(parsed.previewHighlight?.light, DEFAULT_PREVIEW_HIGHLIGHT.light),
      dark: sanitizeHighlight(parsed.previewHighlight?.dark, DEFAULT_PREVIEW_HIGHLIGHT.dark),
    },
    defaultDisplayCount: sanitizeCount(parsed.defaultDisplayCount, DEFAULT_DISPLAY_COUNT),
    streamPrefetchSize: sanitizeCount(parsed.streamPrefetchSize, DEFAULT_STREAM_PREFETCH_SIZE),
    autoLimitEnabled:
      typeof parsed.autoLimitEnabled === "boolean"
        ? parsed.autoLimitEnabled
        : DEFAULT_AUTO_LIMIT_ENABLED,
    autoLimitCount: sanitizeCount(parsed.autoLimitCount, DEFAULT_AUTO_LIMIT_COUNT),
    confirmProductionConnect:
      typeof parsed.confirmProductionConnect === "boolean"
        ? parsed.confirmProductionConnect
        : DEFAULT_CONFIRM_PRODUCTION_CONNECT,
    confirmDangerousQueries:
      typeof parsed.confirmDangerousQueries === "boolean"
        ? parsed.confirmDangerousQueries
        : DEFAULT_CONFIRM_DANGEROUS_QUERIES,
    resultsInNewTab:
      typeof parsed.resultsInNewTab === "boolean" ? parsed.resultsInNewTab : false,
    tabRestoreMode: sanitizeTabRestoreMode(parsed.tabRestoreMode, DEFAULT_TAB_RESTORE_MODE),
    queryTimeoutSecs: sanitizeTimeout(parsed.queryTimeoutSecs, DEFAULT_QUERY_TIMEOUT_SECS),
    connectTimeoutSecs: sanitizeConnectTimeout(parsed.connectTimeoutSecs),
    fontSizePx: sanitizeFontSizePx(parsed.fontSizePx, DEFAULT_FONT_SIZE_PX),
    accentColor: sanitizeAccentColor(parsed.accentColor, DEFAULT_ACCENT_COLOR),
    density: sanitizeDensity(parsed.density, DEFAULT_DENSITY),
    autoRefreshDefaultSecs: sanitizeAutoRefreshSecs(
      parsed.autoRefreshDefaultSecs,
      DEFAULT_AUTO_REFRESH_SECS,
    ),
    inspectorPollIntervalSecs: sanitizeIntInRange(
      parsed.inspectorPollIntervalSecs,
      DEFAULT_INSPECTOR_POLL_SECS,
      MIN_INSPECTOR_POLL_SECS,
      MAX_INSPECTOR_POLL_SECS,
    ),
    inspectorNPlusOneMinCount: sanitizeIntInRange(
      parsed.inspectorNPlusOneMinCount,
      DEFAULT_INSPECTOR_N_PLUS_ONE_MIN_COUNT,
      MIN_INSPECTOR_N_PLUS_ONE_MIN_COUNT,
      MAX_INSPECTOR_N_PLUS_ONE_MIN_COUNT,
    ),
    inspectorNPlusOneWindowMs: sanitizeIntInRange(
      parsed.inspectorNPlusOneWindowMs,
      DEFAULT_INSPECTOR_N_PLUS_ONE_WINDOW_MS,
      MIN_INSPECTOR_N_PLUS_ONE_WINDOW_MS,
      MAX_INSPECTOR_N_PLUS_ONE_WINDOW_MS,
    ),
    resultGridMode: sanitizeResultGridMode(parsed.resultGridMode, DEFAULT_RESULT_GRID_MODE),
    resultGridPageSize: sanitizePageSize(parsed.resultGridPageSize, DEFAULT_RESULT_GRID_PAGE_SIZE),
    cellEditOnBlur:
      parsed.cellEditOnBlur === "commit" || parsed.cellEditOnBlur === "confirm"
        ? parsed.cellEditOnBlur
        : DEFAULT_CELL_EDIT_ON_BLUR,
    richCellRendering:
      typeof parsed.richCellRendering === "boolean"
        ? parsed.richCellRendering
        : DEFAULT_RICH_CELL_RENDERING,
    monoFontFamily: sanitizeFontFamily(parsed.monoFontFamily, DEFAULT_MONO_FONT_FAMILY),
    uiFontFamily: sanitizeFontFamily(parsed.uiFontFamily, DEFAULT_UI_FONT_FAMILY),
    themePreset: sanitizeThemePreset(parsed.themePreset, DEFAULT_THEME_PRESET),
    autoReconnectEnabled:
      typeof parsed.autoReconnectEnabled === "boolean"
        ? parsed.autoReconnectEnabled
        : DEFAULT_AUTO_RECONNECT_ENABLED,
    autoReconnectMaxRetries: sanitizeAutoReconnectRetries(
      parsed.autoReconnectMaxRetries,
      DEFAULT_AUTO_RECONNECT_MAX_RETRIES,
    ),
    shortcutOverrides: sanitizeShortcutOverrides(parsed.shortcutOverrides),
    queryNotificationsEnabled:
      typeof parsed.queryNotificationsEnabled === "boolean"
        ? parsed.queryNotificationsEnabled
        : DEFAULT_QUERY_NOTIFICATIONS_ENABLED,
    queryNotificationThresholdSecs: sanitizeQueryNotificationThresholdSecs(
      parsed.queryNotificationThresholdSecs,
      DEFAULT_QUERY_NOTIFICATION_THRESHOLD_SECS,
    ),
    autoUpdateCheckEnabled:
      typeof parsed.autoUpdateCheckEnabled === "boolean"
        ? parsed.autoUpdateCheckEnabled
        : DEFAULT_AUTO_UPDATE_CHECK_ENABLED,
    sqlLintEnabled:
      typeof parsed.sqlLintEnabled === "boolean"
        ? parsed.sqlLintEnabled
        : DEFAULT_SQL_LINT_ENABLED,
    preflightImpactEnabled:
      typeof parsed.preflightImpactEnabled === "boolean"
        ? parsed.preflightImpactEnabled
        : DEFAULT_PREFLIGHT_IMPACT_ENABLED,
    planWatchOnConnect:
      typeof parsed.planWatchOnConnect === "boolean"
        ? parsed.planWatchOnConnect
        : DEFAULT_PLAN_WATCH_ON_CONNECT,
    motionPreference: sanitizeMotionPreference(parsed.motionPreference, DEFAULT_MOTION_PREFERENCE),
  };
}

/**
 * Schema tag/version for the settings export file (#679). Bump the version
 * if the export shape changes incompatibly; `normalizeSettings` keeps older
 * exports loadable regardless, since it treats unknown/missing fields as
 * defaults field by field.
 */
export const SETTINGS_EXPORT_KIND = "noobdb-settings";
export const SETTINGS_EXPORT_VERSION = 1;

export interface SettingsExportFile {
  kind: typeof SETTINGS_EXPORT_KIND;
  version: number;
  exportedAt: string;
  settings: Settings;
}

/**
 * Serializes app settings (including keybinding overrides, which already
 * live in `shortcutOverrides`) to a pretty-printed JSON string for the
 * "export settings" feature (#679). Deliberately excludes connection
 * profiles and secrets, which have their own dedicated export
 * (`export_profiles` / #442).
 */
export function serializeSettingsExport(
  settings: Settings,
  exportedAt: string = new Date().toISOString(),
): string {
  const file: SettingsExportFile = {
    kind: SETTINGS_EXPORT_KIND,
    version: SETTINGS_EXPORT_VERSION,
    exportedAt,
    settings,
  };
  return JSON.stringify(file, null, 2);
}

/**
 * Parses a settings export JSON string back into a fully-valid `Settings`
 * object. Accepts either the wrapped `{ kind, version, settings }` shape
 * this app produces, or a bare `Settings`-shaped object (so a hand-edited
 * file, or a future export format, still loads something sensible). Always
 * routed through `normalizeSettings`, so a corrupt, foreign, or malicious
 * JSON file can never crash the app or smuggle in an out-of-range value —
 * at worst it silently falls back to defaults field by field. Throws only
 * when `raw` is not valid JSON at all; callers should catch that to show an
 * error toast.
 */
export function deserializeSettingsImport(raw: string): Settings {
  const parsed: unknown = JSON.parse(raw);
  const inner =
    parsed && typeof parsed === "object" && "settings" in parsed
      ? (parsed as { settings?: unknown }).settings
      : parsed;
  return normalizeSettings(inner);
}

function loadInitial(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

let current: Settings = loadInitial();
const listeners = new Set<() => void>();

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // ignore
  }
}

export function getSettings(): Settings {
  return current;
}

export function setSyntaxColor(theme: Theme, key: keyof SyntaxColors, value: string): void {
  if (!isHexColor(value)) return;
  const themeColors = { ...current.syntaxColors[theme], [key]: value };
  current = {
    ...current,
    syntaxColors: { ...current.syntaxColors, [theme]: themeColors },
  };
  persist();
  listeners.forEach((cb) => cb());
}

export function setPreviewHighlight(theme: Theme, value: string): void {
  if (!isHexColor(value)) return;
  if (current.previewHighlight[theme] === value) return;
  current = {
    ...current,
    previewHighlight: { ...current.previewHighlight, [theme]: value },
  };
  persist();
  listeners.forEach((cb) => cb());
}

export function resetPreviewHighlight(theme: Theme): void {
  if (current.previewHighlight[theme] === DEFAULT_PREVIEW_HIGHLIGHT[theme]) return;
  current = {
    ...current,
    previewHighlight: {
      ...current.previewHighlight,
      [theme]: DEFAULT_PREVIEW_HIGHLIGHT[theme],
    },
  };
  persist();
  listeners.forEach((cb) => cb());
}

export function resetSyntaxColors(theme: Theme): void {
  current = {
    ...current,
    syntaxColors: {
      ...current.syntaxColors,
      [theme]: { ...DEFAULT_SYNTAX_COLORS[theme] },
    },
  };
  persist();
  listeners.forEach((cb) => cb());
}

export function applySyntaxPreset(name: SyntaxPresetKey, theme: Theme): void {
  const palette = SYNTAX_PRESETS[name];
  if (!palette) return;
  current = {
    ...current,
    syntaxColors: {
      ...current.syntaxColors,
      [theme]: { ...palette },
    },
  };
  persist();
  listeners.forEach((cb) => cb());
}

export function setDefaultDisplayCount(value: number): void {
  const next = sanitizeCount(value, current.defaultDisplayCount);
  if (next === current.defaultDisplayCount) return;
  current = { ...current, defaultDisplayCount: next };
  persist();
  listeners.forEach((cb) => cb());
}

export function setStreamPrefetchSize(value: number): void {
  const next = sanitizeCount(value, current.streamPrefetchSize);
  if (next === current.streamPrefetchSize) return;
  current = { ...current, streamPrefetchSize: next };
  persist();
  listeners.forEach((cb) => cb());
}

export function setAutoLimitEnabled(value: boolean): void {
  if (current.autoLimitEnabled === value) return;
  current = { ...current, autoLimitEnabled: value };
  persist();
  listeners.forEach((cb) => cb());
}

export function setAutoLimitCount(value: number): void {
  const next = sanitizeCount(value, current.autoLimitCount);
  if (next === current.autoLimitCount) return;
  current = { ...current, autoLimitCount: next };
  persist();
  listeners.forEach((cb) => cb());
}

export function setConfirmProductionConnect(value: boolean): void {
  if (current.confirmProductionConnect === value) return;
  current = { ...current, confirmProductionConnect: value };
  persist();
  listeners.forEach((cb) => cb());
}

export function setConfirmDangerousQueries(value: boolean): void {
  if (current.confirmDangerousQueries === value) return;
  current = { ...current, confirmDangerousQueries: value };
  persist();
  listeners.forEach((cb) => cb());
}

export function setResultsInNewTab(value: boolean): void {
  if (current.resultsInNewTab === value) return;
  current = { ...current, resultsInNewTab: value };
  persist();
  listeners.forEach((cb) => cb());
}

export function setQueryTimeoutSecs(value: number): void {
  const next = sanitizeTimeout(value, current.queryTimeoutSecs);
  if (current.queryTimeoutSecs === next) return;
  current = { ...current, queryTimeoutSecs: next };
  persist();
  listeners.forEach((cb) => cb());
}

export function setConnectTimeoutSecs(value: number): void {
  const next = sanitizeConnectTimeout(value);
  if (current.connectTimeoutSecs === next) return;
  current = { ...current, connectTimeoutSecs: next };
  persist();
  listeners.forEach((cb) => cb());
}

export function setTabRestoreMode(value: TabRestoreMode): void {
  const next = sanitizeTabRestoreMode(value, current.tabRestoreMode);
  if (current.tabRestoreMode === next) return;
  current = { ...current, tabRestoreMode: next };
  persist();
  listeners.forEach((cb) => cb());
}

export function setFontSizePx(value: number): void {
  const next = sanitizeFontSizePx(value, current.fontSizePx);
  if (current.fontSizePx === next) return;
  current = { ...current, fontSizePx: next };
  persist();
  listeners.forEach((cb) => cb());
}

export function setAccentColor(value: string | null): void {
  const next = sanitizeAccentColor(value, current.accentColor);
  if (current.accentColor === next) return;
  current = { ...current, accentColor: next };
  persist();
  listeners.forEach((cb) => cb());
}

export function setDensity(value: Density): void {
  const next = sanitizeDensity(value, current.density);
  if (current.density === next) return;
  current = { ...current, density: next };
  persist();
  listeners.forEach((cb) => cb());
}

export function setAutoRefreshDefaultSecs(value: number): void {
  const next = sanitizeAutoRefreshSecs(value, current.autoRefreshDefaultSecs);
  if (current.autoRefreshDefaultSecs === next) return;
  current = { ...current, autoRefreshDefaultSecs: next };
  persist();
  listeners.forEach((cb) => cb());
}

export function setInspectorPollIntervalSecs(value: number): void {
  const next = sanitizeIntInRange(
    value,
    current.inspectorPollIntervalSecs,
    MIN_INSPECTOR_POLL_SECS,
    MAX_INSPECTOR_POLL_SECS,
  );
  if (current.inspectorPollIntervalSecs === next) return;
  current = { ...current, inspectorPollIntervalSecs: next };
  persist();
  listeners.forEach((cb) => cb());
}

export function setInspectorNPlusOneMinCount(value: number): void {
  const next = sanitizeIntInRange(
    value,
    current.inspectorNPlusOneMinCount,
    MIN_INSPECTOR_N_PLUS_ONE_MIN_COUNT,
    MAX_INSPECTOR_N_PLUS_ONE_MIN_COUNT,
  );
  if (current.inspectorNPlusOneMinCount === next) return;
  current = { ...current, inspectorNPlusOneMinCount: next };
  persist();
  listeners.forEach((cb) => cb());
}

export function setInspectorNPlusOneWindowMs(value: number): void {
  const next = sanitizeIntInRange(
    value,
    current.inspectorNPlusOneWindowMs,
    MIN_INSPECTOR_N_PLUS_ONE_WINDOW_MS,
    MAX_INSPECTOR_N_PLUS_ONE_WINDOW_MS,
  );
  if (current.inspectorNPlusOneWindowMs === next) return;
  current = { ...current, inspectorNPlusOneWindowMs: next };
  persist();
  listeners.forEach((cb) => cb());
}

export function setResultGridMode(value: ResultGridMode): void {
  const next = sanitizeResultGridMode(value, current.resultGridMode);
  if (current.resultGridMode === next) return;
  current = { ...current, resultGridMode: next };
  persist();
  listeners.forEach((cb) => cb());
}

export function setResultGridPageSize(value: number): void {
  const next = sanitizePageSize(value, current.resultGridPageSize);
  if (current.resultGridPageSize === next) return;
  current = { ...current, resultGridPageSize: next };
  persist();
  listeners.forEach((cb) => cb());
}

export function setCellEditOnBlur(value: CellEditOnBlur): void {
  const next = value === "commit" || value === "confirm" ? value : DEFAULT_CELL_EDIT_ON_BLUR;
  if (current.cellEditOnBlur === next) return;
  current = { ...current, cellEditOnBlur: next };
  persist();
  listeners.forEach((cb) => cb());
}

export function setRichCellRendering(value: boolean): void {
  if (current.richCellRendering === value) return;
  current = { ...current, richCellRendering: value };
  persist();
  listeners.forEach((cb) => cb());
}

export function setMonoFontFamily(value: string | null): void {
  const next = sanitizeFontFamily(value, current.monoFontFamily);
  if (current.monoFontFamily === next) return;
  current = { ...current, monoFontFamily: next };
  persist();
  listeners.forEach((cb) => cb());
}

export function setUiFontFamily(value: string | null): void {
  const next = sanitizeFontFamily(value, current.uiFontFamily);
  if (current.uiFontFamily === next) return;
  current = { ...current, uiFontFamily: next };
  persist();
  listeners.forEach((cb) => cb());
}

export function setThemePreset(value: ThemePreset): void {
  const next = sanitizeThemePreset(value, current.themePreset);
  if (current.themePreset === next) return;
  current = { ...current, themePreset: next };
  persist();
  listeners.forEach((cb) => cb());
}

export function setMotionPreference(value: MotionPreference): void {
  const next = sanitizeMotionPreference(value, current.motionPreference);
  if (current.motionPreference === next) return;
  current = { ...current, motionPreference: next };
  persist();
  listeners.forEach((cb) => cb());
}

export function setAutoReconnectEnabled(value: boolean): void {
  if (current.autoReconnectEnabled === value) return;
  current = { ...current, autoReconnectEnabled: value };
  persist();
  listeners.forEach((cb) => cb());
}

export function setAutoReconnectMaxRetries(value: number): void {
  const next = sanitizeAutoReconnectRetries(value, current.autoReconnectMaxRetries);
  if (current.autoReconnectMaxRetries === next) return;
  current = { ...current, autoReconnectMaxRetries: next };
  persist();
  listeners.forEach((cb) => cb());
}

export function setQueryNotificationsEnabled(value: boolean): void {
  if (current.queryNotificationsEnabled === value) return;
  current = { ...current, queryNotificationsEnabled: value };
  persist();
  listeners.forEach((cb) => cb());
}

export function setQueryNotificationThresholdSecs(value: number): void {
  const next = sanitizeQueryNotificationThresholdSecs(value, current.queryNotificationThresholdSecs);
  if (current.queryNotificationThresholdSecs === next) return;
  current = { ...current, queryNotificationThresholdSecs: next };
  persist();
  listeners.forEach((cb) => cb());
}

export function setAutoUpdateCheckEnabled(value: boolean): void {
  if (current.autoUpdateCheckEnabled === value) return;
  current = { ...current, autoUpdateCheckEnabled: value };
  persist();
  listeners.forEach((cb) => cb());
}

export function setSqlLintEnabled(value: boolean): void {
  if (current.sqlLintEnabled === value) return;
  current = { ...current, sqlLintEnabled: value };
  persist();
  listeners.forEach((cb) => cb());
}

export function setPreflightImpactEnabled(value: boolean): void {
  if (current.preflightImpactEnabled === value) return;
  current = { ...current, preflightImpactEnabled: value };
  persist();
  listeners.forEach((cb) => cb());
}

export function setPlanWatchOnConnect(value: boolean): void {
  if (current.planWatchOnConnect === value) return;
  current = { ...current, planWatchOnConnect: value };
  persist();
  listeners.forEach((cb) => cb());
}

/**
 * 1 つのショートカットの上書きを設定/解除する (#557)。`combo` が null または
 * 空文字なら既定へ戻す (= マップから削除)。`combo` を与えるとその id を上書きする。
 */
export function setShortcutBinding(id: string, combo: string | null): void {
  const next = { ...current.shortcutOverrides };
  if (combo === null || combo.trim().length === 0) {
    if (!(id in next)) return;
    delete next[id];
  } else {
    if (next[id] === combo) return;
    next[id] = combo;
  }
  current = { ...current, shortcutOverrides: next };
  persist();
  listeners.forEach((cb) => cb());
}

/** すべてのショートカット上書きをクリアして既定へ戻す。 */
export function resetShortcutBindings(): void {
  if (Object.keys(current.shortcutOverrides).length === 0) return;
  current = { ...current, shortcutOverrides: {} };
  persist();
  listeners.forEach((cb) => cb());
}

export function resetStreamingDefaults(): void {
  current = {
    ...current,
    defaultDisplayCount: DEFAULT_DISPLAY_COUNT,
    streamPrefetchSize: DEFAULT_STREAM_PREFETCH_SIZE,
  };
  persist();
  listeners.forEach((cb) => cb());
}

/**
 * Resets the Appearance section (font size, density, font families, theme
 * preset, accent color, motion preference) to defaults (#679, #787), matching
 * the scoped "reset to defaults" buttons the Streaming / Syntax highlighting /
 * Preview highlight sections already have. Leaves syntax colors and the
 * preview highlight color untouched — those already have their own per-theme
 * resets (`resetSyntaxColors` / `resetPreviewHighlight`).
 */
export function resetAppearanceDefaults(): void {
  current = {
    ...current,
    fontSizePx: DEFAULT_FONT_SIZE_PX,
    density: DEFAULT_DENSITY,
    monoFontFamily: DEFAULT_MONO_FONT_FAMILY,
    uiFontFamily: DEFAULT_UI_FONT_FAMILY,
    themePreset: DEFAULT_THEME_PRESET,
    accentColor: DEFAULT_ACCENT_COLOR,
    motionPreference: DEFAULT_MOTION_PREFERENCE,
  };
  persist();
  listeners.forEach((cb) => cb());
}

/**
 * Replaces the entire settings object in one shot — used by "import
 * settings" (#679). Routed through `normalizeSettings` again as defense in
 * depth, even though callers are expected to have already validated via
 * `deserializeSettingsImport`.
 */
export function replaceAllSettings(next: Settings): void {
  current = normalizeSettings(next);
  persist();
  listeners.forEach((cb) => cb());
}

/**
 * Resets every setting — every section plus keybinding overrides — to
 * defaults ("Reset all to defaults", #679). Unlike the scoped per-section
 * resets above, this is a broad, hard-to-undo action, so callers should
 * gate it behind a confirmation dialog.
 */
export function resetAllSettings(): void {
  current = { ...DEFAULT_SETTINGS };
  persist();
  listeners.forEach((cb) => cb());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, getSettings, getSettings);
}
