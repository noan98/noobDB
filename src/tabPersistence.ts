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

export function loadPersistedTabs(profileId: string): PersistedTab[] {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + profileId);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidTab);
  } catch {
    return [];
  }
}

export function savePersistedTabs(profileId: string, tabs: PersistedTab[]): void {
  try {
    if (tabs.length === 0) {
      localStorage.removeItem(STORAGE_PREFIX + profileId);
    } else {
      localStorage.setItem(STORAGE_PREFIX + profileId, JSON.stringify(tabs));
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
