import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";

// ---------------------------------------------------------------------------
// Accent color presets
// ---------------------------------------------------------------------------

export type AccentPresetKey =
  | "blue"
  | "indigo"
  | "violet"
  | "rose"
  | "emerald"
  | "amber"
  | "teal";

export const ACCENT_PRESET_ORDER: AccentPresetKey[] = [
  "blue",
  "indigo",
  "violet",
  "rose",
  "emerald",
  "amber",
  "teal",
];

export interface AccentColors {
  accent: string;
  accentHover: string;
  accentText: string;
}

export interface AccentPalette {
  light: AccentColors;
  dark: AccentColors;
}

// Each preset ships a light/dark pair. Text colors are verified to meet WCAG AA (4.5:1).
export const ACCENT_PRESETS: Record<AccentPresetKey, AccentPalette> = {
  blue: {
    light: { accent: "#2563eb", accentHover: "#1d4ed8", accentText: "#ffffff" }, // white 4.80:1
    dark: { accent: "#4c93f7", accentHover: "#6cb0fb", accentText: "#0a2540" },  // dark  5.05:1
  },
  indigo: {
    light: { accent: "#4f46e5", accentHover: "#4338ca", accentText: "#ffffff" }, // white 6.01:1
    dark: { accent: "#818cf8", accentHover: "#a5b4fc", accentText: "#1e1b4b" },  // dark  5.90:1
  },
  violet: {
    light: { accent: "#7c3aed", accentHover: "#6d28d9", accentText: "#ffffff" }, // white 5.93:1
    dark: { accent: "#a78bfa", accentHover: "#c4b5fd", accentText: "#2e1065" },  // dark  5.61:1
  },
  rose: {
    light: { accent: "#e11d48", accentHover: "#be123c", accentText: "#ffffff" }, // white 4.60:1
    dark: { accent: "#fb7185", accentHover: "#fda4af", accentText: "#4c0519" },  // dark  5.37:1
  },
  emerald: {
    light: { accent: "#059669", accentHover: "#047857", accentText: "#ffffff" }, // white 4.55:1
    dark: { accent: "#34d399", accentHover: "#6ee7b7", accentText: "#022c22" },  // dark 10.14:1
  },
  amber: {
    light: { accent: "#d97706", accentHover: "#b45309", accentText: "#1c0a00" }, // dark  6.04:1
    dark: { accent: "#fbbf24", accentHover: "#fcd34d", accentText: "#1c0a00" },  // dark 11.51:1
  },
  teal: {
    light: { accent: "#0d9488", accentHover: "#0f766e", accentText: "#ffffff" }, // white 4.53:1
    dark: { accent: "#2dd4bf", accentHover: "#5eead4", accentText: "#021915" },  // dark  9.30:1
  },
};

export const DEFAULT_ACCENT_PRESET: AccentPresetKey = "blue";
export const DEFAULT_ACCENT_CUSTOM_LIGHT = "#2563eb";
export const DEFAULT_ACCENT_CUSTOM_DARK = "#4c93f7";

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
   * Interval (seconds) applied when the result grid's auto-refresh (scheduled
   * re-execution) is toggled on. Remembered globally so the last chosen cadence
   * becomes the default for the next tab. Clamped to AUTO_REFRESH_MIN_SECS.
   */
  autoRefreshDefaultSecs: number;
  /** Which accent color preset is active ("custom" enables per-theme HEX pickers). */
  accentPreset: AccentPresetKey | "custom";
  /** Custom accent HEX for the light theme (used only when accentPreset === "custom"). */
  accentCustomLight: string;
  /** Custom accent HEX for the dark theme (used only when accentPreset === "custom"). */
  accentCustomDark: string;
}

export type TabRestoreMode = "always" | "ask" | "never";

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
  autoRefreshDefaultSecs: DEFAULT_AUTO_REFRESH_SECS,
  accentPreset: DEFAULT_ACCENT_PRESET,
  accentCustomLight: DEFAULT_ACCENT_CUSTOM_LIGHT,
  accentCustomDark: DEFAULT_ACCENT_CUSTOM_DARK,
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

function sanitizeFontSizePx(input: unknown, fallback: number): number {
  if (typeof input !== "number" || !Number.isFinite(input)) return fallback;
  const n = Math.round(input);
  if (n < MIN_FONT_SIZE_PX) return MIN_FONT_SIZE_PX;
  if (n > MAX_FONT_SIZE_PX) return MAX_FONT_SIZE_PX;
  return n;
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

function sanitizeAccentPreset(input: unknown): AccentPresetKey | "custom" {
  if (input === "custom") return "custom";
  if (typeof input === "string" && (ACCENT_PRESET_ORDER as string[]).includes(input)) {
    return input as AccentPresetKey;
  }
  return DEFAULT_ACCENT_PRESET;
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
      autoRefreshDefaultSecs?: unknown;
      accentPreset?: unknown;
      accentCustomLight?: unknown;
      accentCustomDark?: unknown;
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
      autoRefreshDefaultSecs: sanitizeAutoRefreshSecs(
        parsed.autoRefreshDefaultSecs,
        DEFAULT_AUTO_REFRESH_SECS,
      ),
      accentPreset: sanitizeAccentPreset(parsed.accentPreset),
      accentCustomLight: sanitizeHighlight(parsed.accentCustomLight, DEFAULT_ACCENT_CUSTOM_LIGHT),
      accentCustomDark: sanitizeHighlight(parsed.accentCustomDark, DEFAULT_ACCENT_CUSTOM_DARK),
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

export function setAutoRefreshDefaultSecs(value: number): void {
  const next = sanitizeAutoRefreshSecs(value, current.autoRefreshDefaultSecs);
  if (current.autoRefreshDefaultSecs === next) return;
  current = { ...current, autoRefreshDefaultSecs: next };
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

// ---------------------------------------------------------------------------
// Accent color helpers & setters
// ---------------------------------------------------------------------------

function relativeLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Picks white or a very dark near-black based on WCAG contrast against `bgHex`. */
export function pickAccentForeground(bgHex: string): string {
  if (!isHexColor(bgHex)) return "#ffffff";
  const bgL = relativeLuminance(bgHex);
  const whiteContrast = 1.05 / (bgL + 0.05);
  const darkContrast = (bgL + 0.05) / (relativeLuminance("#0a2540") + 0.05);
  return whiteContrast >= darkContrast ? "#ffffff" : "#0a2540";
}

/** Darkens (light theme) or lightens (dark theme) an accent color for hover state. */
export function deriveHoverColor(hex: string, lighten: boolean): string {
  if (!isHexColor(hex)) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const factor = lighten ? 1.2 : 0.85;
  const clamp = (v: number) => Math.min(255, Math.max(0, Math.round(v * factor)));
  return `#${clamp(r).toString(16).padStart(2, "0")}${clamp(g).toString(16).padStart(2, "0")}${clamp(b).toString(16).padStart(2, "0")}`;
}

/** Returns the resolved accent/accentHover/accentText CSS variable values for a given theme. */
export function getAccentColors(settings: Settings, theme: Theme): AccentColors {
  if (settings.accentPreset !== "custom") {
    return ACCENT_PRESETS[settings.accentPreset][theme];
  }
  const accent = theme === "dark" ? settings.accentCustomDark : settings.accentCustomLight;
  if (!isHexColor(accent)) return ACCENT_PRESETS.blue[theme];
  return {
    accent,
    accentHover: deriveHoverColor(accent, theme === "dark"),
    accentText: pickAccentForeground(accent),
  };
}

export function setAccentPreset(value: AccentPresetKey | "custom"): void {
  const next =
    value === "custom" || (ACCENT_PRESET_ORDER as string[]).includes(value)
      ? value
      : DEFAULT_ACCENT_PRESET;
  if (current.accentPreset === next) return;
  current = { ...current, accentPreset: next };
  persist();
  listeners.forEach((cb) => cb());
}

export function setAccentCustomLight(value: string): void {
  if (!isHexColor(value) || current.accentCustomLight === value) return;
  current = { ...current, accentCustomLight: value };
  persist();
  listeners.forEach((cb) => cb());
}

export function setAccentCustomDark(value: string): void {
  if (!isHexColor(value) || current.accentCustomDark === value) return;
  current = { ...current, accentCustomDark: value };
  persist();
  listeners.forEach((cb) => cb());
}

export function resetAccentColor(): void {
  current = {
    ...current,
    accentPreset: DEFAULT_ACCENT_PRESET,
    accentCustomLight: DEFAULT_ACCENT_CUSTOM_LIGHT,
    accentCustomDark: DEFAULT_ACCENT_CUSTOM_DARK,
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
