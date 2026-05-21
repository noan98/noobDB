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
  /** Initial number of rows displayed before streaming continues. */
  defaultDisplayCount: number;
  /** Chunk size used to fetch additional rows once the initial batch has been shown. */
  streamPrefetchSize: number;
  /** Show a confirmation dialog when connecting to a profile flagged as production. */
  confirmProductionConnect: boolean;
}

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

export const DEFAULT_DISPLAY_COUNT = 100;
export const DEFAULT_STREAM_PREFETCH_SIZE = 200;
const MIN_BATCH = 1;
const MAX_BATCH = 100_000;

export const DEFAULT_CONFIRM_PRODUCTION_CONNECT = true;

export const DEFAULT_SETTINGS: Settings = {
  syntaxColors: {
    light: { ...DEFAULT_SYNTAX_COLORS.light },
    dark: { ...DEFAULT_SYNTAX_COLORS.dark },
  },
  defaultDisplayCount: DEFAULT_DISPLAY_COUNT,
  streamPrefetchSize: DEFAULT_STREAM_PREFETCH_SIZE,
  confirmProductionConnect: DEFAULT_CONFIRM_PRODUCTION_CONNECT,
};

const STORAGE_KEY = "tablex.settings";

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

function loadInitial(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as {
      syntaxColors?: { light?: unknown; dark?: unknown };
      defaultDisplayCount?: unknown;
      streamPrefetchSize?: unknown;
      confirmProductionConnect?: unknown;
    };
    return {
      syntaxColors: {
        light: sanitizeColors(parsed.syntaxColors?.light, DEFAULT_SYNTAX_COLORS.light),
        dark: sanitizeColors(parsed.syntaxColors?.dark, DEFAULT_SYNTAX_COLORS.dark),
      },
      defaultDisplayCount: sanitizeCount(parsed.defaultDisplayCount, DEFAULT_DISPLAY_COUNT),
      streamPrefetchSize: sanitizeCount(parsed.streamPrefetchSize, DEFAULT_STREAM_PREFETCH_SIZE),
      confirmProductionConnect:
        typeof parsed.confirmProductionConnect === "boolean"
          ? parsed.confirmProductionConnect
          : DEFAULT_CONFIRM_PRODUCTION_CONNECT,
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

export function setConfirmProductionConnect(value: boolean): void {
  if (current.confirmProductionConnect === value) return;
  current = { ...current, confirmProductionConnect: value };
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
