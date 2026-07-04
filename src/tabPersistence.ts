import type { QueryBuilderSnapshot } from "./components/QueryBuilder";

const STORAGE_PREFIX = "noobdb.tabs.";

export interface PersistedTab {
  kind: "table" | "query" | "explain";
  title: string;
  database?: string;
  table?: string;
  sql: string;
  /**
   * Optional Query Builder snapshot. Restored when the same tab is
   * reopened so users don't have to rebuild WHERE / ORDER BY / LIMIT inputs
   * after a reconnect. Mirrors `QueryBuilderSnapshot` — kept structural here
   * (rather than `QueryBuilderSnapshot`) so the persisted JSON shape stays
   * decoupled from the component's internals.
   */
  builderSnapshot?: QueryBuilderSnapshot;
}

function isValidKind(k: unknown): k is "table" | "query" | "explain" {
  return k === "table" || k === "query" || k === "explain";
}

function isStringPair(v: unknown): v is { column: string; value: string } {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.column === "string" && typeof o.value === "string";
}

function isWhereCondition(
  v: unknown,
): v is { column: string; operator: string; value: string } {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.column === "string" &&
    typeof o.operator === "string" &&
    typeof o.value === "string"
  );
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isValidBuilderSnapshot(v: unknown): v is QueryBuilderSnapshot {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.kind !== "SELECT" && o.kind !== "UPDATE" && o.kind !== "DELETE" && o.kind !== "INSERT") {
    return false;
  }
  if (typeof o.database !== "string") return false;
  if (typeof o.table !== "string") return false;
  if (typeof o.selectAll !== "boolean") return false;
  if (typeof o.limit !== "string") return false;
  // `whereEnabled` / `limitEnabled` were added later; tolerate older snapshots
  // that omit them (they default to enabled when restored) but reject wrong types.
  if (o.whereEnabled !== undefined && typeof o.whereEnabled !== "boolean") return false;
  if (o.limitEnabled !== undefined && typeof o.limitEnabled !== "boolean") return false;
  if (!isStringArray(o.selectColumns)) return false;
  if (!Array.isArray(o.whereConditions) || !o.whereConditions.every(isWhereCondition)) return false;
  if (!Array.isArray(o.setPairs) || !o.setPairs.every(isStringPair)) return false;
  if (!Array.isArray(o.insertPairs) || !o.insertPairs.every(isStringPair)) return false;
  return true;
}

function isValidTab(v: unknown): v is PersistedTab {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (!isValidKind(o.kind)) return false;
  if (typeof o.title !== "string") return false;
  if (typeof o.sql !== "string") return false;
  if (o.database !== undefined && o.database !== null && typeof o.database !== "string") return false;
  if (o.table !== undefined && o.table !== null && typeof o.table !== "string") return false;
  // A malformed `builderSnapshot` is dropped silently rather than rejecting the
  // whole tab — the SQL editor state is still useful even if the saved builder
  // shape no longer matches.
  return true;
}

/**
 * Strip fields the validator can't vouch for. Run after `isValidTab` so the
 * returned object is safe to surface to consumers that trust the typed shape.
 */
function sanitizeTab(raw: unknown): PersistedTab | null {
  if (!isValidTab(raw)) return null;
  const o = raw as Record<string, unknown> & PersistedTab;
  const out: PersistedTab = { kind: o.kind, title: o.title, sql: o.sql };
  if (typeof o.database === "string") out.database = o.database;
  if (typeof o.table === "string") out.table = o.table;
  if (isValidBuilderSnapshot(o.builderSnapshot)) {
    out.builderSnapshot = o.builderSnapshot;
  }
  return out;
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

function sanitizeTabs(raw: unknown[]): PersistedTab[] {
  return raw
    .map(sanitizeTab)
    .filter((t): t is PersistedTab => t != null);
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
    const tabs = sanitizeTabs(parsed);
    return tabs.length > 0 ? { panes: [{ tabs, activeIndex: 0 }], activePane: 0 } : EMPTY_WORKSPACE;
  }
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).panes)) {
    const rawPanes = (parsed as { panes: unknown[] }).panes;
    const panes: PersistedPane[] = rawPanes
      .filter(isValidPane)
      .map((p) => {
        const tabs = sanitizeTabs(p.tabs);
        // 非整数 (例: 1.5) が紛れ込んだ localStorage を読み込んでも `builtTabs[1.5]`
        // のような範囲外アクセスにならないよう、範囲検証の前に整数化する
        // (`activePane` の `Math.trunc` 正規化と対称)。truncate 後もなお範囲外なら
        // 0 にフォールバックする既存の挙動は維持する。
        const truncatedIndex =
          typeof p.activeIndex === "number" && Number.isFinite(p.activeIndex)
            ? Math.trunc(p.activeIndex)
            : NaN;
        const activeIndex =
          truncatedIndex >= 0 && truncatedIndex < tabs.length ? truncatedIndex : 0;
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
