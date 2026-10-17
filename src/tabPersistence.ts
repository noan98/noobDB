import type { QueryBuilderSnapshot } from "./components/QueryBuilder";

const STORAGE_PREFIX = "noobdb.tabs.";

export interface PersistedTab {
  kind: "table" | "query" | "explain";
  title: string;
  /**
   * ユーザが明示的にリネームした (または名前付きで開いた) タブ (#1390)。true のタブは
   * 実行時の自動命名で上書きしない。旧データには無いので、欠落は false 扱い。
   */
  titleManual?: boolean;
  /** ピン留め済みタブ (#1486)。旧データには無いので、欠落は false 扱い。 */
  pinned?: boolean;
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
  /**
   * Editor caret + selection as document offsets (#678). A caret is
   * `anchor === head`. Clamped to the SQL length on restore, so a stored
   * offset that no longer fits the (out-of-band edited) SQL collapses safely.
   */
  selection?: { anchor: number; head: number };
  /**
   * Result grid vertical scroll position in px (#678). Table tabs only — query
   * tabs don't restore their result, so there's nothing to scroll. Re-applied
   * after the result is re-fetched, clamped to the scrollable range.
   */
  gridScrollTop?: number;
  /** Rows-per-page for paginated table tabs (#678). */
  pageSize?: number;
}

function isValidKind(k: unknown): k is "table" | "query" | "explain" {
  return k === "table" || k === "query" || k === "explain";
}

function isStringPair(v: unknown): v is { column: string; value: string } {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.column === "string" && typeof o.value === "string";
}

function isWhereCondition(v: unknown): v is { column: string; operator: string; value: string } {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  // `value2` (BETWEEN の上端) は後から足したので省略可 (#1627)。
  if (o.value2 !== undefined && typeof o.value2 !== "string") return false;
  return typeof o.column === "string" && typeof o.operator === "string" && typeof o.value === "string";
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isOrderByItem(v: unknown): v is { column: string; direction: "ASC" | "DESC" } {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.column === "string" && (o.direction === "ASC" || o.direction === "DESC");
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
  // `offset` (OFFSET 入力) は後から足したので、旧データは持たない。型が違うものだけ弾く (#1627)。
  if (o.offset !== undefined && typeof o.offset !== "string") return false;
  // `whereEnabled` / `limitEnabled` were added later; tolerate older snapshots
  // that omit them (they default to enabled when restored) but reject wrong types.
  if (o.whereEnabled !== undefined && typeof o.whereEnabled !== "boolean") return false;
  if (o.limitEnabled !== undefined && typeof o.limitEnabled !== "boolean") return false;
  // `orderBy` is likewise a later addition (ORDER BY builder support) — an
  // older persisted snapshot simply has no `orderBy` key at all, and must
  // keep restoring rather than being rejected wholesale.
  if (o.orderBy !== undefined && (!Array.isArray(o.orderBy) || !o.orderBy.every(isOrderByItem))) {
    return false;
  }
  if (!isStringArray(o.selectColumns)) return false;
  if (!Array.isArray(o.whereConditions) || !o.whereConditions.every(isWhereCondition)) return false;
  if (!Array.isArray(o.setPairs) || !o.setPairs.every(isStringPair)) return false;
  if (!Array.isArray(o.insertPairs) || !o.insertPairs.every(isStringPair)) return false;
  return true;
}

/** A finite, non-negative integer offset (caret/scroll positions). */
function isOffset(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/** A `{ anchor, head }` selection with two valid offsets. */
function isValidSelection(v: unknown): v is { anchor: number; head: number } {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return isOffset(o.anchor) && isOffset(o.head);
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
  // 真のときだけ持つ (旧データ・不正な型は無視して自動命名のまま)。
  if (o.titleManual === true) out.titleManual = true;
  if (o.pinned === true) out.pinned = true;
  if (isValidBuilderSnapshot(o.builderSnapshot)) {
    out.builderSnapshot = o.builderSnapshot;
  }
  // Fidelity fields (#678) are all optional and dropped silently if malformed —
  // the editor text / result is still useful without the caret or scroll.
  if (isValidSelection(o.selection)) {
    // CodeMirror のオフセットは整数前提なので丸める (手編集/破損データ対策)。
    out.selection = { anchor: Math.trunc(o.selection.anchor), head: Math.trunc(o.selection.head) };
  }
  if (isOffset(o.gridScrollTop)) out.gridScrollTop = o.gridScrollTop;
  // 0 < pageSize < 1 が trunc で 0 にならないよう、trunc 後に正数判定する。
  if (isOffset(o.pageSize)) {
    const ps = Math.trunc(o.pageSize);
    if (ps > 0) out.pageSize = ps;
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
  return raw.map(sanitizeTab).filter((t): t is PersistedTab => t != null);
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
    // activePane は元配列の添字なので、無効/空ペインを除く前の添字を持ち回る。
    const kept = rawPanes
      .map((p, origIndex) => ({ p, origIndex }))
      .filter((e): e is { p: PersistedPane; origIndex: number } => isValidPane(e.p))
      .map(({ p, origIndex }) => {
        const tabs = sanitizeTabs(p.tabs);
        // 非整数 (例: 1.5) が紛れ込んだ localStorage を読み込んでも `builtTabs[1.5]`
        // のような範囲外アクセスにならないよう、範囲検証の前に整数化する
        // (`activePane` の `Math.trunc` 正規化と対称)。truncate 後もなお範囲外なら
        // 0 にフォールバックする既存の挙動は維持する。
        const truncatedIndex =
          typeof p.activeIndex === "number" && Number.isFinite(p.activeIndex)
            ? Math.trunc(p.activeIndex)
            : NaN;
        const activeIndex = truncatedIndex >= 0 && truncatedIndex < tabs.length ? truncatedIndex : 0;
        return { pane: { tabs, activeIndex }, origIndex };
      })
      .filter((e) => e.pane.tabs.length > 0);
    const panes: PersistedPane[] = kept.map((e) => e.pane);
    if (panes.length === 0) return EMPTY_WORKSPACE;
    const rawActive = (parsed as { activePane?: unknown }).activePane;
    let activePane = 0;
    if (typeof rawActive === "number") {
      const orig = Math.max(0, Math.trunc(rawActive));
      const mapped = kept.findIndex((e) => e.origIndex === orig);
      // 除去されたペイン/範囲外を指していた場合は最寄りの末尾側へ丸める (従来どおり)
      activePane = mapped >= 0 ? mapped : Math.min(orig, panes.length - 1);
    }
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

/**
 * 保存するワークスペースを決める純関数。復元確認で「今回は開かない」を選んだ接続は、
 * 保持分 (`kept`) を失わないようにする (#1615):
 * - 保持なし → `current` をそのまま保存。
 * - 保持あり・現在のタブなし → `kept` をそのまま保存し直す (セッション中に閉じたタブを残さない)。
 * - 保持あり・現在のタブあり → 保持分をペイン構造ごと `current.panes` の後ろに足す
 *   (`activePane` は現在のまま)。何度呼んでも `kept` から作るので重複しない。
 */
export function resolveWorkspaceToSave(
  current: PersistedWorkspace,
  kept: PersistedWorkspace | undefined,
): PersistedWorkspace {
  if (!kept || totalTabs(kept) === 0) return current;
  if (totalTabs(current) === 0) return kept;
  if (current.panes.length + kept.panes.length <= MAX_PERSISTED_PANES) {
    return { panes: [...current.panes, ...kept.panes], activePane: current.activePane };
  }
  // 画面は最大 2 ペインまでしか描かないので、超える分は最後のペインの末尾にタブとして足す。
  const lastIdx = current.panes.length - 1;
  const panes = current.panes.map((pane, i) =>
    i === lastIdx ? { ...pane, tabs: [...pane.tabs, ...keptTabs(kept)] } : pane,
  );
  return { panes, activePane: current.activePane };
}

/** 画面が描けるペイン数の上限 (分割表示は 2 ペインまで)。 */
const MAX_PERSISTED_PANES = 2;

function keptTabs(kept: PersistedWorkspace): PersistedTab[] {
  return kept.panes.flatMap((pane) => pane.tabs);
}

/**
 * `resolveWorkspaceToSave` が足した保持分を保存済みワークスペースから外し、セッション中に開いた
 * タブだけを返す。保持中の接続へ戻ったとき、保持分は復元せずに (ダイアログで選ぶまで保持のまま)
 * そのセッションのタブだけを復元するために使う。末尾のペインが保持分と一致しなければ
 * (保持分が足されていない) そのまま返す。
 */
export function splitKeptFromSaved(saved: PersistedWorkspace, kept: PersistedWorkspace): PersistedWorkspace {
  const n = kept.panes.length;
  if (n === 0) return saved;
  const tail = saved.panes.slice(saved.panes.length - n);
  if (tail.length === n && JSON.stringify(tail) === JSON.stringify(kept.panes)) {
    const panes = saved.panes.slice(0, saved.panes.length - n);
    return { panes, activePane: Math.min(saved.activePane, Math.max(0, panes.length - 1)) };
  }
  // ペイン数の上限で最後のペインの末尾にタブとして足された場合。
  const flat = keptTabs(kept);
  const last = saved.panes[saved.panes.length - 1];
  if (!last || flat.length === 0 || last.tabs.length < flat.length) return saved;
  const lastTail = last.tabs.slice(last.tabs.length - flat.length);
  if (JSON.stringify(lastTail) !== JSON.stringify(flat)) return saved;
  const rest = last.tabs.slice(0, last.tabs.length - flat.length);
  const panes =
    rest.length > 0
      ? [
          ...saved.panes.slice(0, -1),
          { ...last, tabs: rest, activeIndex: Math.min(last.activeIndex, rest.length - 1) },
        ]
      : saved.panes.slice(0, -1);
  return { panes, activePane: Math.min(saved.activePane, Math.max(0, panes.length - 1)) };
}

export function clearPersistedTabs(profileId: string): void {
  try {
    localStorage.removeItem(STORAGE_PREFIX + profileId);
  } catch {
    // ignore
  }
}
