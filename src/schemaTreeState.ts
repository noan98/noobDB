// スキーマツリー (DB / テーブル) の展開状態の永続化 (#677)。
//
// `tabPersistence.ts` / `tableQuickAccess.ts` と同じく、プロファイルごとに localStorage へ
// 状態を永続化する。ツリーは既定ですべて閉じているため、「開いている」DB 名と
// テーブルキー (`db::tbl`) だけを配列で保存する (接続リストのグループ折りたたみと対称)。
// 再接続のたびに作業中の DB へ再ドリルダウンする摩擦を解消するのが目的。
//
// 破損耐性 (#566) の作法に従い、壊れた JSON・型不一致は破棄して空 (= すべて閉じている)
// へフォールバックする。純ロジックのみを提供し、UI 反映と「存在しなくなった DB/テーブルの
// 無視」は `ConnectionList` が担う。

import { type ExplorerTableSort, parseExplorerTableSort } from "./components/explorerTree";

const STORAGE_PREFIX = "noobdb.schematree.";

/**
 * プロファイル単位のツリー展開状態。値 `true` = 開いている。既定 (エントリ無し) は閉じ。
 * `expandedDbs` / `expandedTables` の React state と同型なので、そのまま流し込める。
 */
export interface SchemaTreeState {
  /** データベース名 → 開いているか。 */
  dbs: Record<string, boolean>;
  /** テーブルキー (`db::tbl`) → 開いているか。 */
  tables: Record<string, boolean>;
  /** テーブル / ビューの並べ替え (#1629)。省略 = 既定の `name` (取得順)。 */
  sort?: ExplorerTableSort;
}

export const EMPTY_SCHEMA_TREE: SchemaTreeState = { dbs: {}, tables: {} };

/**
 * パース済み JSON (開いているキーの配列) を妥当な状態へ整える。純粋 (ストレージ非依存)
 * なのでユニットテストできる。未知の形・非文字列は捨てる。
 */
export function normalizeSchemaTree(parsed: unknown): SchemaTreeState {
  if (!parsed || typeof parsed !== "object") return { dbs: {}, tables: {} };
  const o = parsed as Record<string, unknown>;
  const dbs: Record<string, boolean> = {};
  if (Array.isArray(o.dbs)) {
    for (const k of o.dbs) if (typeof k === "string") dbs[k] = true;
  }
  const tables: Record<string, boolean> = {};
  if (Array.isArray(o.tables)) {
    for (const k of o.tables) if (typeof k === "string") tables[k] = true;
  }
  const sort = parseExplorerTableSort(o.sort);
  return sort === "name" ? { dbs, tables } : { dbs, tables, sort };
}

export function loadSchemaTree(profileId: string): SchemaTreeState {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + profileId);
    if (!raw) return { dbs: {}, tables: {} };
    return normalizeSchemaTree(JSON.parse(raw));
  } catch {
    return { dbs: {}, tables: {} };
  }
}

/**
 * 展開状態を保存する。開いているノードが無いときはエントリを削除して、閉じきった
 * 状態 (並べ替えも既定) が確実に既定へ戻るようにする (`saveQuickAccess` と同じ発想)。
 */
export function saveSchemaTree(profileId: string, state: SchemaTreeState): void {
  try {
    const dbs = Object.keys(state.dbs).filter((k) => state.dbs[k]);
    const tables = Object.keys(state.tables).filter((k) => state.tables[k]);
    const sort = parseExplorerTableSort(state.sort);
    if (dbs.length === 0 && tables.length === 0 && sort === "name") {
      localStorage.removeItem(STORAGE_PREFIX + profileId);
    } else {
      localStorage.setItem(
        STORAGE_PREFIX + profileId,
        JSON.stringify(sort === "name" ? { dbs, tables } : { dbs, tables, sort }),
      );
    }
  } catch {
    // ignore (quota / disabled storage)
  }
}
