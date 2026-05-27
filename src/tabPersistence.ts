const STORAGE_PREFIX = "noobdb.tabs.";

export interface PersistedTab {
  kind: "table" | "query" | "explain";
  title: string;
  database?: string;
  table?: string;
  sql: string;
}

function isValidKind(k: unknown): k is "table" | "query" | "explain" {
  return k === "table" || k === "query" || k === "explain";
}

function isValidTab(v: unknown): v is PersistedTab {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (!isValidKind(o.kind)) return false;
  if (typeof o.title !== "string") return false;
  if (typeof o.sql !== "string") return false;
  if (o.database !== undefined && o.database !== null && typeof o.database !== "string") return false;
  if (o.table !== undefined && o.table !== null && typeof o.table !== "string") return false;
  return true;
}

/** One pane's worth of restored tabs plus which of them was active. */
export interface PersistedPane {
  tabs: PersistedTab[];
  activeIndex: number;
}

/**
 * The persisted split-view layout: an ordered list of panes (1 or 2) and which
 * pane held focus. Serialised under the same per-profile key as the legacy
 * flat tab array; `loadPersistedWorkspace` reads both shapes.
 */
export interface PersistedWorkspace {
  panes: PersistedPane[];
  activePane: number;
}

const EMPTY_WORKSPACE: PersistedWorkspace = { panes: [], activePane: 0 };

function isValidPane(v: unknown): v is PersistedPane {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return Array.isArray(o.tabs);
}

function totalTabs(ws: PersistedWorkspace): number {
  return ws.panes.reduce((n, p) => n + p.tabs.length, 0);
}

/**
 * Coerce already-parsed JSON into a valid workspace. Pure (no storage access)
 * so it can be unit-tested. Accepts the legacy bare-array shape (one pane) and
 * the versioned `{ panes, activePane }` shape; anything else collapses to an
 * empty workspace. Invalid tabs/panes are dropped and indices are clamped.
 */
export function normalizePersistedWorkspace(parsed: unknown): PersistedWorkspace {
  // Legacy format: a bare array of tabs → a single pane.
  if (Array.isArray(parsed)) {
    const tabs = parsed.filter(isValidTab);
    return tabs.length > 0 ? { panes: [{ tabs, activeIndex: 0 }], activePane: 0 } : EMPTY_WORKSPACE;
  }
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).panes)) {
    const rawPanes = (parsed as { panes: unknown[] }).panes;
    const panes: PersistedPane[] = rawPanes
      .filter(isValidPane)
      .map((p) => {
        const tabs = p.tabs.filter(isValidTab);
        const activeIndex =
          typeof p.activeIndex === "number" && p.activeIndex >= 0 && p.activeIndex < tabs.length
            ? p.activeIndex
            : 0;
        return { tabs, activeIndex };
      })
      .filter((p) => p.tabs.length > 0);
    if (panes.length === 0) return EMPTY_WORKSPACE;
    const rawActive = (parsed as { activePane?: unknown }).activePane;
    const activePane =
      typeof rawActive === "number" ? Math.min(Math.max(0, Math.trunc(rawActive)), panes.length - 1) : 0;
    return { panes, activePane };
  }
  return EMPTY_WORKSPACE;
}

export function loadPersistedWorkspace(profileId: string): PersistedWorkspace {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + profileId);
    if (!raw) return EMPTY_WORKSPACE;
    return normalizePersistedWorkspace(JSON.parse(raw));
  } catch {
    return EMPTY_WORKSPACE;
  }
}

export function savePersistedWorkspace(profileId: string, ws: PersistedWorkspace): void {
  try {
    if (totalTabs(ws) === 0) {
      localStorage.removeItem(STORAGE_PREFIX + profileId);
    } else {
      localStorage.setItem(STORAGE_PREFIX + profileId, JSON.stringify(ws));
    }
  } catch {
    // ignore
  }
}

export function clearPersistedTabs(profileId: string): void {
  try {
    localStorage.removeItem(STORAGE_PREFIX + profileId);
  } catch {
    // ignore
  }
}
