/**
 * 閉じたタブの復元 (#1353) の純ロジック。副作用なし。
 *
 * `handleCloseTab` が破棄する直前のタブをスナップショットとして直近 N 件のリングバッファへ
 * 積み、Cmd/Ctrl+Shift+T とコマンドパレットから戻せるようにする。結果・セル編集
 * (pendingEdits)・ストリームは復元対象外 (SQL 本文と接続先だけを戻す)。
 */

import type { QueryBuilderSnapshot } from "./components/QueryBuilder";

/** 保持する最大件数 (スコープ = 接続セッションごと)。一括クローズで閉じた分を戻せる余裕を持たせる。 */
export const MAX_CLOSED_TABS = 20;

/** パレットの「閉じたタブを開き直す」(引数なしで最新を開く) の固定 id。MRU に記録してよい。 */
export const REOPEN_CLOSED_TAB_COMMAND_ID = "nav:reopen-closed-tab";

const CLOSED_TAB_ITEM_PREFIX = `${REOPEN_CLOSED_TAB_COMMAND_ID}:`;

/** パレットの個別復元項目の id。履歴の id は一時的なので MRU には記録しない。 */
export function closedTabItemId(closedId: string): string {
  return `${CLOSED_TAB_ITEM_PREFIX}${closedId}`;
}

/** 個別復元項目の id か。 */
export function isClosedTabItemId(id: string): boolean {
  return id.startsWith(CLOSED_TAB_ITEM_PREFIX);
}

/** 閉じたタブ 1 件のスナップショット。 */
export interface ClosedTab {
  /** 一意な id (パレットの項目キー・個別復元に使う)。 */
  id: string;
  /** どの接続セッションで閉じたか。別接続へは復元しないため一覧もスコープで絞る。 */
  scope: string;
  kind: "table" | "query" | "explain";
  title: string;
  /** 手動リネーム済み (#1390)。復元後の実行で名前が自動命名に上書きされないよう保持する。 */
  titleManual?: boolean;
  /** 閉じた時点の最新本文 (エディタに未反映の編集を含む)。 */
  sql: string;
  database?: string;
  table?: string;
  builderSnapshot?: QueryBuilderSnapshot | null;
  selection?: { anchor: number; head: number };
  closedAt: number;
}

/** スナップショット化に必要なタブの最小フィールド。 */
export interface ClosableTab {
  kind: "table" | "query" | "explain";
  title: string;
  titleManual?: boolean;
  database?: string;
  table?: string;
  builderSnapshot?: QueryBuilderSnapshot | null;
  selection?: { anchor: number; head: number };
}

/**
 * タブからスナップショットを作る。`sql` は `tabSqlStore` から読んだ最新本文を渡す。
 * 復元する価値が無いタブ (本文が空白だけのクエリ / EXPLAIN タブ) は null。
 * table タブは SQL ではなく (database, table) で再オープンするので本文が空でも残す。
 */
export function snapshotClosedTab(
  tab: ClosableTab,
  sql: string,
  meta: { id: string; scope: string; closedAt: number },
  liveSelection?: { anchor: number; head: number },
): ClosedTab | null {
  if (tab.kind === "table") {
    if (!tab.database || !tab.table) return null;
  } else if (sql.trim() === "") {
    return null;
  }
  const out: ClosedTab = {
    id: meta.id,
    scope: meta.scope,
    kind: tab.kind,
    title: tab.title,
    sql,
    closedAt: meta.closedAt,
  };
  if (tab.kind === "query" && tab.titleManual) out.titleManual = true;
  if (tab.database) out.database = tab.database;
  if (tab.table) out.table = tab.table;
  if (tab.builderSnapshot) out.builderSnapshot = tab.builderSnapshot;
  const selection = liveSelection ?? tab.selection;
  if (selection) out.selection = selection;
  return out;
}

/** 同じ内容 (種別・タイトル・本文・接続先・テーブル) か。重複判定に使う。 */
function sameContent(a: ClosedTab, b: ClosedTab): boolean {
  return (
    a.scope === b.scope &&
    a.kind === b.kind &&
    a.title === b.title &&
    a.sql === b.sql &&
    a.database === b.database &&
    a.table === b.table
  );
}

/**
 * 先頭 (最新) に積む。リストは新しい順。同じ内容が既にあれば古い方を取り除いて最新位置へ
 * 寄せる (開閉を繰り返しても同じ行が溜まらない)。スコープごとに `max` 件を超えた古い分を捨てる。
 * 入力は破壊しない。
 */
export function pushClosedTab(
  list: readonly ClosedTab[],
  entry: ClosedTab,
  max: number = MAX_CLOSED_TABS,
): ClosedTab[] {
  const next = [entry, ...list.filter((e) => !sameContent(e, entry))];
  let kept = 0;
  return next.filter((e) => {
    if (e.scope !== entry.scope) return true;
    kept += 1;
    return kept <= max;
  });
}

/** 指定スコープの一覧 (新しい順)。 */
export function closedTabsForScope(list: readonly ClosedTab[], scope: string): ClosedTab[] {
  return list.filter((e) => e.scope === scope);
}

/** 指定スコープの履歴を捨てる (接続セッションの終了時)。他スコープは保つ。入力は破壊しない。 */
export function dropClosedTabsForScope(list: readonly ClosedTab[], scope: string): ClosedTab[] {
  return list.filter((e) => e.scope !== scope);
}

/**
 * 復元する 1 件を取り出す。`id` 省略時はスコープ内で最新。見つからなければ
 * `entry: null` で一覧はそのまま返す。
 */
export function takeClosedTab(
  list: readonly ClosedTab[],
  scope: string,
  id?: string,
): { entry: ClosedTab | null; rest: ClosedTab[] } {
  const entry = list.find((e) => e.scope === scope && (id === undefined || e.id === id)) ?? null;
  if (!entry) return { entry: null, rest: list.slice() };
  return { entry, rest: list.filter((e) => e !== entry) };
}

// ---------------------------------------------------------------------------
// 再起動後も残す (#1631)
// ---------------------------------------------------------------------------
//
// 履歴の中身 (SQL・タイトル・接続先の database / table) は秘密情報を含まないので、接続プロファイルごとに
// localStorage へ保存し、接続したときに読み戻す。閲覧者ごとの便宜なので、読めなければ空で動く
// (try/catch)。結果・セル編集・クエリビルダのスナップショットは保存しない。

const PERSIST_PREFIX = "noobdb.closedTabs.v1.";

/** 1 件の SQL 本文として保存する最大文字数 (巨大な貼り付けで容量を使い切らないため)。 */
export const MAX_PERSISTED_CLOSED_SQL_CHARS = 200_000;

/** 保存する 1 件 (スコープ = 接続セッションは再接続で変わるので持たない)。 */
export interface PersistedClosedTab {
  kind: ClosedTab["kind"];
  title: string;
  titleManual?: boolean;
  sql: string;
  database?: string;
  table?: string;
  selection?: { anchor: number; head: number };
  closedAt: number;
}

/** 保存用に縮める。新しい順のまま上限 (`max`) 件まで。SQL が長すぎるエントリは捨てる。 */
export function toPersistedClosedTabs(
  list: readonly ClosedTab[],
  max: number = MAX_CLOSED_TABS,
): PersistedClosedTab[] {
  const out: PersistedClosedTab[] = [];
  for (const e of list) {
    if (e.sql.length > MAX_PERSISTED_CLOSED_SQL_CHARS) continue;
    const item: PersistedClosedTab = {
      kind: e.kind,
      title: e.title,
      sql: e.sql,
      closedAt: e.closedAt,
    };
    if (e.titleManual) item.titleManual = true;
    if (e.database) item.database = e.database;
    if (e.table) item.table = e.table;
    if (e.selection) item.selection = { anchor: e.selection.anchor, head: e.selection.head };
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

function isOffsetNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/** パース済み JSON から妥当なエントリだけ取り出す (形が壊れたものは捨てる)。純粋。 */
export function normalizePersistedClosedTabs(parsed: unknown): PersistedClosedTab[] {
  if (!Array.isArray(parsed)) return [];
  const out: PersistedClosedTab[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    if (o.kind !== "table" && o.kind !== "query" && o.kind !== "explain") continue;
    if (typeof o.title !== "string" || typeof o.sql !== "string") continue;
    if (o.sql.length > MAX_PERSISTED_CLOSED_SQL_CHARS) continue;
    const item: PersistedClosedTab = {
      kind: o.kind,
      title: o.title,
      sql: o.sql,
      closedAt: isOffsetNumber(o.closedAt) ? o.closedAt : 0,
    };
    if (o.titleManual === true && o.kind === "query") item.titleManual = true;
    if (typeof o.database === "string" && o.database) item.database = o.database;
    if (typeof o.table === "string" && o.table) item.table = o.table;
    // table タブは (database, table) で開き直すので、どちらかが欠けた壊れた項目は復元できない。
    if (o.kind === "table" && (!item.database || !item.table)) continue;
    const sel = o.selection as Record<string, unknown> | undefined;
    if (sel && isOffsetNumber(sel.anchor) && isOffsetNumber(sel.head)) {
      item.selection = { anchor: Math.trunc(sel.anchor), head: Math.trunc(sel.head) };
    }
    out.push(item);
    if (out.length >= MAX_CLOSED_TABS) break;
  }
  return out;
}

/** 保存した履歴を、いまの接続セッション (`scope`) の履歴として組み直す。`makeId` は一意な id を返す。 */
export function restoreClosedTabs(
  persisted: readonly PersistedClosedTab[],
  scope: string,
  makeId: () => string,
): ClosedTab[] {
  return persisted.map((p) => ({ ...p, id: makeId(), scope }));
}

export function loadPersistedClosedTabs(profileId: string): PersistedClosedTab[] {
  try {
    const raw = localStorage.getItem(PERSIST_PREFIX + profileId);
    if (!raw) return [];
    return normalizePersistedClosedTabs(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function savePersistedClosedTabs(profileId: string, list: readonly PersistedClosedTab[]): void {
  try {
    if (list.length === 0) localStorage.removeItem(PERSIST_PREFIX + profileId);
    else localStorage.setItem(PERSIST_PREFIX + profileId, JSON.stringify(list));
  } catch {
    // ignore (quota / disabled storage)
  }
}
