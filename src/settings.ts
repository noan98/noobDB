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
  /** Behavior when previously open tabs exist for a profile being reconnected. */
  tabRestoreMode: TabRestoreMode;
  /**
   * Automatically abort an editor query that runs longer than this many
   * seconds. `0` disables the timeout (queries run unbounded as before).
   */
  queryTimeoutSecs: number;
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
   * UI density preset. Drives row height / cell padding independently of the
   * font size, via the `data-density` attribute and `--density-*` CSS vars.
   */
  density: Density;
  /**
   * Interval (seconds) applied when the result grid's auto-refresh (scheduled
   * re-execution) is toggled on. Remembered globally so the last chosen cadence
   * becomes the default for the next tab. Clamped to AUTO_REFRESH_MIN_SECS.
   */
  autoRefreshDefaultSecs: number;
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
   * JSON, localized date/time, boolean badges and enum color badges (#451).
   * Display-only — copy/edit/export always keep the original value. Turn off to
   * see every cell as the raw string the driver returned.
   */
  richCellRendering: boolean;
  /**
   * Preferred monospace font family for the editor, result grid and code views
   * (#449). `null` keeps the App.css default mono stack. A non-null value is
   * prepended to the shared fallback chain so an uninstalled font degrades
   * gracefully. Driven into the `--font-mono` CSS variable at runtime.
   */
  monoFontFamily: string | null;
  /**
   * Preferred UI (sans-serif) font family (#449). `null` keeps the App.css
   * default sans stack. Prepended to the shared sans fallback chain and driven
   * into `--font-sans` at runtime.
   */
  uiFontFamily: string | null;
  /**
   * Color theme preset (#465). `default` follows the light/dark toggle with the
   * stock palette; other presets are full palettes (currently `dracula`,
   * dark-only) selected via the `data-theme` attribute. Independent of accent
   * color, density and syntax colors, which still override at runtime.
   */
  themePreset: ThemePreset;
}

/** Color theme presets (#465). `default` = stock light/dark. */
export type ThemePreset = "default" | "dracula";

/** Presets offered in settings, in display order. */
export const THEME_PRESET_ORDER: ThemePreset[] = ["default", "dracula"];
export const DEFAULT_THEME_PRESET: ThemePreset = "default";

/**
 * Maps a preset + the current light/dark theme to the `data-theme` attribute
 * value. Dark-only presets ignore the light/dark toggle. Names end with
 * "-dark"/"-light" so theme.ts `conditions.dark` ([data-theme$=dark]) resolves
 * colored-button tokens correctly.
 */
export function themePresetDataTheme(preset: ThemePreset, theme: Theme): string {
  if (preset === "dracula") return "dracula-dark";
  return theme;
}

export type TabRestoreMode = "always" | "ask" | "never";

export type ResultGridMode = "scroll" | "paginate";

export type CellEditOnBlur = "commit" | "confirm";
/** Preserve the historical auto-commit behavior; the guard is opt-in. */
export const DEFAULT_CELL_EDIT_ON_BLUR: CellEditOnBlur = "commit";

/** Rich cell rendering is on by default; it is a display-only enhancement. */
export const DEFAULT_RICH_CELL_RENDERING = true;

/** Font family defaults: `null` means "use the App.css default stack" (#449). */
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
  | "githubLight"
  | "githubDark"
  | "monokai";

export const SYNTAX_PRESET_ORDER: SyntaxPresetKey[] = [
  "defaultLight",
  "defaultDark",
  "solarizedLight",
  "solarizedDark",
  "dracula",
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
  tabRestoreMode: DEFAULT_TAB_RESTORE_MODE,
  queryTimeoutSecs: DEFAULT_QUERY_TIMEOUT_SECS,
  fontSizePx: DEFAULT_FONT_SIZE_PX,
  accentColor: DEFAULT_ACCENT_COLOR,
  density: DEFAULT_DENSITY,
  autoRefreshDefaultSecs: DEFAULT_AUTO_REFRESH_SECS,
  resultGridMode: DEFAULT_RESULT_GRID_MODE,
  resultGridPageSize: DEFAULT_RESULT_GRID_PAGE_SIZE,
  cellEditOnBlur: DEFAULT_CELL_EDIT_ON_BLUR,
  richCellRendering: DEFAULT_RICH_CELL_RENDERING,
  monoFontFamily: DEFAULT_MONO_FONT_FAMILY,
  uiFontFamily: DEFAULT_UI_FONT_FAMILY,
  themePreset: DEFAULT_THEME_PRESET,
};

/** Clamps an auto-refresh cadence (seconds) to the allowed range. */
export function sanitizeAutoRefreshSecs(input: unknown, fallback: number): number {
  if (typeof input !== "number" || !Number.isFinite(input)) return fallback;
  const n = Math.floor(input);
  if (n < AUTO_REFRESH_MIN_SECS) return AUTO_REFRESH_MIN_SECS;
  if (n > AUTO_REFRESH_MAX_SECS) return AUTO_REFRESH_MAX_SECS;
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

function loadInitial(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as {
      syntaxColors?: { light?: unknown; dark?: unknown };
      previewHighlight?: { light?: unknown; dark?: unknown };
      defaultDisplayCount?: unknown;
      streamPrefetchSize?: unknown;
      autoLimitEnabled?: unknown;
      autoLimitCount?: unknown;
      confirmProductionConnect?: unknown;
      confirmDangerousQueries?: unknown;
      tabRestoreMode?: unknown;
      queryTimeoutSecs?: unknown;
      fontSizePx?: unknown;
      accentColor?: unknown;
      density?: unknown;
      autoRefreshDefaultSecs?: unknown;
      resultGridMode?: unknown;
      resultGridPageSize?: unknown;
      cellEditOnBlur?: unknown;
      richCellRendering?: unknown;
      monoFontFamily?: unknown;
      uiFontFamily?: unknown;
      themePreset?: unknown;
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
      tabRestoreMode: sanitizeTabRestoreMode(parsed.tabRestoreMode, DEFAULT_TAB_RESTORE_MODE),
      queryTimeoutSecs: sanitizeTimeout(parsed.queryTimeoutSecs, DEFAULT_QUERY_TIMEOUT_SECS),
      fontSizePx: sanitizeFontSizePx(parsed.fontSizePx, DEFAULT_FONT_SIZE_PX),
      accentColor: sanitizeAccentColor(parsed.accentColor, DEFAULT_ACCENT_COLOR),
      density: sanitizeDensity(parsed.density, DEFAULT_DENSITY),
      autoRefreshDefaultSecs: sanitizeAutoRefreshSecs(
        parsed.autoRefreshDefaultSecs,
        DEFAULT_AUTO_REFRESH_SECS,
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
    };
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

export function setQueryTimeoutSecs(value: number): void {
  const next = sanitizeTimeout(value, current.queryTimeoutSecs);
  if (current.queryTimeoutSecs === next) return;
  current = { ...current, queryTimeoutSecs: next };
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

export function resetStreamingDefaults(): void {
  current = {
    ...current,
    defaultDisplayCount: DEFAULT_DISPLAY_COUNT,
    streamPrefetchSize: DEFAULT_STREAM_PREFETCH_SIZE,
  };
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
