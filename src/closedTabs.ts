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
  /** 手動命名か (#1390)。復元後も自動命名で上書きしないために持つ。 */
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
  if (tab.titleManual) out.titleManual = true;
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
    !!a.titleManual === !!b.titleManual &&
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
