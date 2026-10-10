/**
 * Database Explorer (サイドバーのスキーマツリー) の階層整理 (#1112 / Epic #1110
 * Phase 2) の純ロジック。副作用なし (DOM / Tauri に触れない) なので Vitest で
 * 単体テストできる。
 *
 * ## 階層
 *
 * ```
 * Connection
 * └ Database (PostgreSQL ではスキーマ)
 *   ├ Tables
 *   │ └ table ─┬ Columns
 *   │          ├ Indexes
 *   │          └ Foreign keys
 *   ├ Views (マテリアライズドビュー含む) ─ 列はテーブルと同じく展開できる
 *   └ Procedures / Functions / Triggers (定義を開くだけ)
 * ```
 *
 * #1112 以前は `list_tables` がビューも返す (全ドライバ共通) ため、ビューが
 * 「テーブル一覧」と「ビュー」グループの 2 箇所に出ていた。前者はテーブルの
 * アイコンのままで、後者は定義を開くだけ (データも列も見られない) という、
 * 同じオブジェクトが別物に見える状態だった。ここで 1 箇所へ振り分ける。
 */

import type { IndexInfo, SchemaObject, SchemaObjectKind, TableColumnInfo } from "../api/tauri";
import type { TableRef } from "../tableQuickAccess";

/** ビューとして扱う (= テーブル一覧から外して「ビュー」グループへ置く) 種別。 */
const VIEW_KINDS: ReadonlySet<SchemaObjectKind> = new Set(["view", "materialized_view"]);

/** 定義だけを開くオブジェクトの表示順 (ビュー系を除く)。 */
const ROUTINE_ORDER: readonly SchemaObjectKind[] = ["procedure", "function", "trigger"];

/** 「ビュー」グループに並ぶノード。列の展開・データを開く導線はテーブルと共通。 */
export interface ExplorerViewNode {
  name: string;
  kind: "view" | "materialized_view";
  /** 定義 (DDL) を開くときの一意識別子。`SchemaObject.id` をそのまま運ぶ。 */
  id: string | null;
}

export interface ExplorerDatabaseGroups {
  /** 「テーブル」グループ。ビューと判明したものは除く (`list_tables` の順を保つ)。 */
  tables: string[];
  /** 「ビュー」グループ。`list_tables` に含まれていたビューだけ (順は `list_tables`)。 */
  views: ExplorerViewNode[];
  /**
   * 定義を開くだけのオブジェクト (ルーチン / トリガー / `list_tables` と名前が
   * 突き合わなかったビュー)。種別ごとの表示順に並べ替え済み。突き合わなかった
   * ビューをここへ残すのは、名前の表記ゆれ (スキーマ修飾など) があってもビューが
   * ツリーから消えないようにするため。
   */
  objects: SchemaObject[];
}

/**
 * データベース直下のノードを「テーブル / ビュー / その他オブジェクト」へ振り分ける。
 *
 * `objects` が未取得 (`undefined`) の間は振り分けられないので、`tables` をそのまま
 * テーブルとして返す (取得後にビューが「ビュー」グループへ移る)。
 */
export function partitionDatabaseNodes(
  tables: readonly string[],
  objects: readonly SchemaObject[] | undefined,
): ExplorerDatabaseGroups {
  const viewByName = new Map<string, SchemaObject>();
  for (const o of objects ?? []) {
    if (VIEW_KINDS.has(o.kind) && !viewByName.has(o.name)) viewByName.set(o.name, o);
  }
  const listed = new Set(tables);
  const views: ExplorerViewNode[] = [];
  const plainTables: string[] = [];
  for (const name of tables) {
    const v = viewByName.get(name);
    if (v) views.push({ name, kind: v.kind as ExplorerViewNode["kind"], id: v.id });
    else plainTables.push(name);
  }
  const rank = (k: SchemaObjectKind) => {
    if (VIEW_KINDS.has(k)) return k === "view" ? 0 : 1;
    return 2 + ROUTINE_ORDER.indexOf(k);
  };
  const rest = (objects ?? [])
    .filter((o) => !(VIEW_KINDS.has(o.kind) && listed.has(o.name)))
    .map((o, i) => ({ o, i }))
    // 種別順で安定ソート (同じ種別の中はバックエンドの順を保つ)。
    .sort((a, b) => rank(a.o.kind) - rank(b.o.kind) || a.i - b.i)
    .map(({ o }) => o);
  return { tables: plainTables, views, objects: rest };
}

/**
 * データベース直下に「テーブル」見出しを出すか。テーブルしか無いデータベースで
 * 見出しを出すと 1 行増えるだけで情報が増えない (UX 方針「常時表示する情報を
 * 絞る」) ので、他のグループと並ぶときだけ出す。
 */
export function showTablesHeader(groups: ExplorerDatabaseGroups): boolean {
  return groups.tables.length > 0 && (groups.views.length > 0 || groups.objects.length > 0);
}

/** 外部キー 1 本 (列 → 参照先)。`describe_table` の列情報から導出する。 */
export interface ExplorerForeignKey {
  column: string;
  referencedTable: string;
  referencedColumn: string | null;
}

/** 列情報から外部キーを取り出す (列の順を保つ)。 */
export function foreignKeysOf(columns: readonly TableColumnInfo[]): ExplorerForeignKey[] {
  const out: ExplorerForeignKey[] = [];
  for (const c of columns) {
    if (c.referenced_table) {
      out.push({
        column: c.name,
        referencedTable: c.referenced_table,
        referencedColumn: c.referenced_column,
      });
    }
  }
  return out;
}

/** 外部キーの参照先の表示 (`table.column`、列不明なら `table`)。 */
export function foreignKeyTargetLabel(fk: ExplorerForeignKey): string {
  return fk.referencedColumn ? `${fk.referencedTable}.${fk.referencedColumn}` : fk.referencedTable;
}

/**
 * テーブル (ビュー) を展開したときの子グループ。列だけのテーブルで「列」見出しを
 * 出すのは冗長なので、インデックスか外部キーと並ぶときだけ見出しを付ける。
 */
export interface ExplorerTableGroups {
  showColumnsHeader: boolean;
  indexes: IndexInfo[];
  foreignKeys: ExplorerForeignKey[];
}

export function tableChildGroups(
  columns: readonly TableColumnInfo[],
  indexes: readonly IndexInfo[] | undefined,
): ExplorerTableGroups {
  const idx = [...(indexes ?? [])];
  const fks = foreignKeysOf(columns);
  return {
    showColumnsHeader: columns.length > 0 && (idx.length > 0 || fks.length > 0),
    indexes: idx,
    foreignKeys: fks,
  };
}

/**
 * ツリーの「データベース」階層が実際に何を表すか。PostgreSQL は接続が 1 つの
 * 実データベースに固定され、この階層にはスキーマ (名前空間) が並ぶ
 * (バックエンドの `databases()` の実装に対応)。ツールチップと読み上げで取り違え
 * ないよう、ドライバごとに呼び分ける。
 */
export function explorerContainerKind(driver: string): "database" | "schema" {
  return driver === "postgres" ? "schema" : "database";
}

// --- 見えている行のフラット配列 (#1315) ---
//
// スキーマツリーは数千行になりうるので、アクティブ接続のサブツリーを「いま見えている行」の
// フラットな配列にして、`ConnectionList` が窓の分だけ描画する (仮想化)。展開状態と検索時の
// 強制展開のルールはここ 1 か所に持ち、DOM を持たないので Vitest で境界ケースを固定できる。

/** `describe_table` 済みのテーブルキー (`db::table`)。ツリー全体で共通の識別子。 */
export const tableKey = (db: string, tbl: string) => `${db}::${tbl}`;

/** 見出し行の種別。 */
export type ExplorerHeaderGroup =
  | "favorites"
  | "recent"
  | "tables"
  | "views"
  | "columns"
  | "indexes"
  | "foreignKeys"
  | SchemaObjectKind;

interface ExplorerRowBase {
  /** 仮想化の行キー兼 `data-tree-key`。見出し・プレースホルダは `hdr:` / `ph:` 始まり。 */
  key: string;
  /** プロファイル直下を 0 とした入れ子の深さ (破線インデントの段数)。 */
  depth: number;
  /** 兄弟の集合 (`aria-posinset` / `aria-setsize` の単位)。 */
  parent: string;
  /** フォーカスできる行 (`role=treeitem`) だけが持つ。同じ親の中での位置 (1 始まり)。 */
  posInSet?: number;
  /** フォーカスできる行だけが持つ。同じ親の中の行数。 */
  setSize?: number;
}

export type ExplorerRow = ExplorerRowBase &
  (
    | { kind: "header"; group: ExplorerHeaderGroup; count: number | null }
    | { kind: "loading" }
    | { kind: "empty"; message: "databases" | "tables" | "columns" }
    | { kind: "quick"; ref: TableRef; variant: "favorite" | "recent" }
    | { kind: "db"; db: string; open: boolean }
    | {
        kind: "table";
        db: string;
        tbl: string;
        /** ビューなら振り分け結果のノード、テーブルなら null。 */
        view: ExplorerViewNode | null;
        open: boolean;
        rowEst: number | null | undefined;
        comment: string | undefined;
        isActive: boolean;
      }
    | { kind: "column"; db: string; tbl: string; col: TableColumnInfo }
    | { kind: "index"; db: string; tbl: string; idx: IndexInfo }
    | { kind: "foreignKey"; db: string; tbl: string; fk: ExplorerForeignKey }
    | { kind: "object"; db: string; o: SchemaObject }
  );

/** キーボードフォーカスを受ける行か (`role=treeitem` を持つ行)。 */
export function isFocusableExplorerRow(row: ExplorerRow): boolean {
  return row.kind !== "header" && row.kind !== "loading" && row.kind !== "empty";
}

/** `describe_table` の列情報ごとの外部キー。列配列が同一参照のあいだは同じ配列を返し、
 *  行の `memo` (外部キーのオブジェクト参照で比較) が再構築で無効にならないようにする。 */
const foreignKeyCache = new WeakMap<readonly TableColumnInfo[], ExplorerForeignKey[]>();
function cachedForeignKeys(cols: readonly TableColumnInfo[]): ExplorerForeignKey[] {
  let fks = foreignKeyCache.get(cols);
  if (!fks) {
    fks = foreignKeysOf(cols);
    foreignKeyCache.set(cols, fks);
  }
  return fks;
}

/** 検索結果の照合関数 (検索していなければ null)。 */
export interface ExplorerMatchers {
  db: (db: string) => boolean;
  table: (db: string, tbl: string) => boolean;
  column: (db: string, tbl: string) => boolean;
}

export interface ExplorerRowsInput {
  databases: readonly string[] | null;
  tables: Readonly<Record<string, string[] | undefined>>;
  schemaObjects: Readonly<Record<string, SchemaObject[] | undefined>>;
  tableColumns: Readonly<Record<string, TableColumnInfo[] | undefined>>;
  tableIndexes: Readonly<Record<string, IndexInfo[] | undefined>>;
  expandedDbs: Readonly<Record<string, boolean | undefined>>;
  expandedTables: Readonly<Record<string, boolean | undefined>>;
  /** 小文字化・trim 済みの検索クエリ (検索していなければ空文字)。 */
  query: string;
  /** プロファイル自身のメタ情報ではなくスキーマ (DB / テーブル / 列) で絞り込んでいるか。 */
  schemaFiltered: boolean;
  matchers: ExplorerMatchers | null;
  /** DB ごとの振り分け。呼び出し側がキャッシュして、ビューのノードを同一参照に保つ。 */
  partition: (db: string, tables: string[], objects: SchemaObject[] | undefined) => ExplorerDatabaseGroups;
  /** ルーチン / トリガーなどの定義を開ける (= そのグループを出す) か。 */
  showObjects: boolean;
  favorites: readonly TableRef[];
  recent: readonly TableRef[];
  rowEstimate: (db: string, tbl: string) => number | null | undefined;
  comment: (db: string, tbl: string) => string | undefined;
  isActiveTable: (db: string, tbl: string) => boolean;
}

const OBJECT_GROUP_ORDER: readonly SchemaObjectKind[] = [
  "view",
  "materialized_view",
  "procedure",
  "function",
  "trigger",
];

/**
 * アクティブ接続のサブツリーを、いま見えている行のフラットな配列にする。
 *
 * - データベースは `expandedDbs`、テーブルは `expandedTables` で開く。スキーマ検索で絞り込み中
 *   (`schemaFiltered`) は、ヒットした DB / 列を持つテーブルを強制的に開く。
 * - 絞り込み中は、DB 名 / テーブル名にヒットしたものだけを出し、テーブル名がヒットしない
 *   テーブルは列名がヒットした列だけを出す (インデックス・外部キー・ルーチンは出さない)。
 * - 閉じているノードの子は配列に入らない (行が無いので描画もされない)。
 */
export function buildExplorerRows(input: ExplorerRowsInput): ExplorerRow[] {
  const { query: q, schemaFiltered, matchers } = input;
  const searching = q.length > 0;
  const rows: ExplorerRow[] = [];

  const quick = (variant: "favorite" | "recent", refs: readonly TableRef[]) => {
    const group = variant === "favorite" ? "favorites" : "recent";
    if (refs.length === 0) return;
    rows.push({ key: `hdr:${group}`, depth: 0, parent: "root", kind: "header", group, count: null });
    for (const ref of refs) {
      rows.push({
        key: `qa:${variant}:${tableKey(ref.database, ref.table)}`,
        depth: 0,
        parent: "root",
        kind: "quick",
        ref,
        variant,
      });
    }
  };
  quick("favorite", input.favorites);
  quick("recent", input.recent);

  const databases = input.databases;
  if (databases === null) {
    rows.push({ key: "ph:databases", depth: 0, parent: "root", kind: "loading" });
  } else if (databases.length === 0) {
    rows.push({ key: "ph:databases", depth: 0, parent: "root", kind: "empty", message: "databases" });
  } else {
    for (const db of databases) {
      if (schemaFiltered && !(matchers?.db(db) ?? false)) continue;
      const dbNameHit = searching && db.toLowerCase().includes(q);
      const dbOpen = !!input.expandedDbs[db] || (schemaFiltered && (matchers?.db(db) ?? false));
      const dbKey = `db:${db}`;
      rows.push({ key: dbKey, depth: 0, parent: "root", kind: "db", db, open: dbOpen });
      if (!dbOpen) continue;

      const dbTables = input.tables[db];
      if (dbTables === undefined) {
        rows.push({ key: `ph:tables:${db}`, depth: 1, parent: dbKey, kind: "loading" });
        continue;
      }
      const groups = input.partition(db, dbTables, input.schemaObjects[db]);
      if (dbTables.length === 0) {
        rows.push({ key: `ph:notables:${db}`, depth: 1, parent: dbKey, kind: "empty", message: "tables" });
        if (!schemaFiltered && input.showObjects) pushObjects(rows, db, dbKey, groups.objects);
        continue;
      }
      const visibleTables = groups.tables.filter(
        (tbl) => !schemaFiltered || dbNameHit || (matchers?.table(db, tbl) ?? false),
      );
      const visibleViews = groups.views.filter(
        (v) => !schemaFiltered || dbNameHit || (matchers?.table(db, v.name) ?? false),
      );
      if (showTablesHeader(groups) && visibleTables.length > 0) {
        rows.push({
          key: `hdr:tables:${db}`,
          depth: 1,
          parent: dbKey,
          kind: "header",
          group: "tables",
          count: visibleTables.length,
        });
      }
      for (const tbl of visibleTables) pushTable(input, rows, db, tbl, null, dbKey, dbNameHit);
      if (visibleViews.length > 0) {
        rows.push({
          key: `hdr:views:${db}`,
          depth: 1,
          parent: dbKey,
          kind: "header",
          group: "views",
          count: visibleViews.length,
        });
      }
      for (const v of visibleViews) pushTable(input, rows, db, v.name, v, dbKey, dbNameHit);
      if (!schemaFiltered && input.showObjects) pushObjects(rows, db, dbKey, groups.objects);
    }
  }

  assignSetPositions(rows);
  return rows;
}

function pushObjects(rows: ExplorerRow[], db: string, dbKey: string, objects: readonly SchemaObject[]): void {
  if (objects.length === 0) return;
  for (const kind of OBJECT_GROUP_ORDER) {
    const items = objects.filter((o) => o.kind === kind);
    if (items.length === 0) continue;
    rows.push({ key: `hdr:obj:${db}:${kind}`, depth: 1, parent: dbKey, kind: "header", group: kind, count: null });
    for (const o of items) {
      rows.push({
        key: `so:${db}:${kind}:${o.name}:${o.id ?? ""}`,
        depth: 1,
        parent: dbKey,
        kind: "object",
        db,
        o,
      });
    }
  }
}

function pushTable(
  input: ExplorerRowsInput,
  rows: ExplorerRow[],
  db: string,
  tbl: string,
  view: ExplorerViewNode | null,
  dbKey: string,
  dbNameHit: boolean,
): void {
  const { query: q, schemaFiltered, matchers } = input;
  const key = tableKey(db, tbl);
  const rowKey = `tbl:${key}`;
  const open = !!input.expandedTables[key] || (schemaFiltered && (matchers?.column(db, tbl) ?? false));
  rows.push({
    key: rowKey,
    depth: 1,
    parent: dbKey,
    kind: "table",
    db,
    tbl,
    view,
    open,
    rowEst: input.rowEstimate(db, tbl),
    comment: input.comment(db, tbl),
    isActive: input.isActiveTable(db, tbl),
  });
  if (!open) return;

  // 絞り込み中でも、DB / テーブル自体がヒットしていれば列は全部出す。
  const showAllCols = !schemaFiltered || dbNameHit || (q.length > 0 && tbl.toLowerCase().includes(q));
  const cols = input.tableColumns[key];
  const indexes = input.tableIndexes[key];
  const fks = cols ? cachedForeignKeys(cols) : [];
  if (cols === undefined) {
    rows.push({ key: `ph:cols:${key}`, depth: 2, parent: rowKey, kind: "loading" });
  } else if (cols.length === 0) {
    rows.push({ key: `ph:nocols:${key}`, depth: 2, parent: rowKey, kind: "empty", message: "columns" });
  } else {
    // 列だけのテーブルで「列」見出しを出すのは冗長なので、他のグループと並ぶときだけ。
    if (showAllCols && ((indexes?.length ?? 0) > 0 || fks.length > 0)) {
      rows.push({ key: `hdr:cols:${key}`, depth: 2, parent: rowKey, kind: "header", group: "columns", count: null });
    }
    for (const col of cols) {
      if (!showAllCols && !col.name.toLowerCase().includes(q)) continue;
      rows.push({ key: `col:${key}:${col.name}`, depth: 2, parent: rowKey, kind: "column", db, tbl, col });
    }
  }
  if (showAllCols && indexes && indexes.length > 0) {
    rows.push({ key: `hdr:idx:${key}`, depth: 2, parent: rowKey, kind: "header", group: "indexes", count: null });
    for (const idx of indexes) {
      rows.push({ key: `idx:${key}:${idx.name}`, depth: 2, parent: rowKey, kind: "index", db, tbl, idx });
    }
  }
  if (showAllCols && fks.length > 0) {
    rows.push({ key: `hdr:fk:${key}`, depth: 2, parent: rowKey, kind: "header", group: "foreignKeys", count: null });
    for (const fk of fks) {
      rows.push({ key: `fk:${key}:${fk.column}`, depth: 2, parent: rowKey, kind: "foreignKey", db, tbl, fk });
    }
  }
}

/** フォーカスできる行に `aria-posinset` / `aria-setsize` 用の位置を振る (窓の外の兄弟は DOM に
 *  無いので、支援技術は DOM を数えられない)。 */
function assignSetPositions(rows: ExplorerRow[]): void {
  const sizes = new Map<string, number>();
  for (const row of rows) {
    if (isFocusableExplorerRow(row)) sizes.set(row.parent, (sizes.get(row.parent) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  for (const row of rows) {
    if (!isFocusableExplorerRow(row)) continue;
    const n = (seen.get(row.parent) ?? 0) + 1;
    seen.set(row.parent, n);
    row.posInSet = n;
    row.setSize = sizes.get(row.parent);
  }
}

/** 行のラベル (先頭文字ジャンプの照合用)。フォーカスできない行は空。 */
export function explorerRowLabel(row: ExplorerRow): string {
  switch (row.kind) {
    case "db":
      return row.db;
    case "table":
      return row.tbl;
    case "quick":
      return row.ref.table;
    case "column":
      return row.col.name;
    case "index":
      return row.idx.columns.join(", ") || row.idx.name;
    case "foreignKey":
      return row.fk.column;
    case "object":
      return row.o.name;
    default:
      return "";
  }
}

/** 行が展開できるノードか (`aria-expanded` を持つか) と、いま開いているか。 */
export function explorerRowExpansion(row: ExplorerRow): { expandable: boolean; open: boolean } {
  if (row.kind === "db" || row.kind === "table") return { expandable: true, open: row.open };
  return { expandable: false, open: false };
}

// --- テーブルの複数選択 (#1399) ---
//
// Ctrl(Cmd) / Shift クリックで選んだテーブルをまとめて DDL 取得 / エクスポート / ダンプ / DROP
// できるようにする選択モデルの純ロジック。選択は「同一接続・同一データベース (PostgreSQL では
// スキーマ)」の中に限る — 別のデータベースのテーブルを選んだら選択を取り直す (一括 DROP の対象が
// 画面外のデータベースへ広がる事故を避ける)。ビューは対象外 (DDL の kind・DROP 文が異なるため)。

/** テーブルの選択状態。`keys` は `tableKey(db, tbl)`、`anchor` は Shift 範囲選択の起点。 */
export interface TableSelection {
  /** 選択が属するデータベース。`keys` が空で起点だけのときも、その起点のデータベース。 */
  db: string | null;
  keys: ReadonlySet<string>;
  /** Shift クリック / Shift+矢印の起点となる `tableKey`。無ければ null。 */
  anchor: string | null;
}

export const EMPTY_TABLE_SELECTION: TableSelection = { db: null, keys: new Set(), anchor: null };

/** 選択できる行 (ビューを除くテーブル行)。 */
export function isSelectableTableRow(
  row: ExplorerRow,
): row is Extract<ExplorerRow, { kind: "table" }> & { view: null } {
  return row.kind === "table" && row.view === null;
}

export function isTableSelected(sel: TableSelection, db: string, tbl: string): boolean {
  return sel.db === db && sel.keys.has(tableKey(db, tbl));
}

/** 選択中のテーブル数。 */
export function selectedTableCount(sel: TableSelection): number {
  return sel.keys.size;
}

/** 通常クリック: 選択を解除し、そのテーブルを Shift 範囲選択の起点にする。 */
export function anchorTableSelection(sel: TableSelection, db: string, tbl: string): TableSelection {
  const key = tableKey(db, tbl);
  if (sel.keys.size === 0 && sel.db === db && sel.anchor === key) return sel;
  return { db, keys: new Set(), anchor: key };
}

/**
 * Ctrl(Cmd) クリック: そのテーブルを選択に出し入れする。別のデータベースのテーブルなら
 * 選択を取り直してそのテーブルだけにする。
 */
export function toggleTableSelection(sel: TableSelection, db: string, tbl: string): TableSelection {
  const key = tableKey(db, tbl);
  if (sel.db !== db) return { db, keys: new Set([key]), anchor: key };
  const keys = new Set(sel.keys);
  if (keys.has(key)) keys.delete(key);
  else keys.add(key);
  return { db, keys, anchor: key };
}

/**
 * Shift クリック: 起点から `tbl` までの、見えているテーブル行を選ぶ。起点が無い / 別のデータベース /
 * 画面に無いときは `tbl` だけを選んで起点にする。`additive` (Ctrl+Shift) なら既存の選択に足す。
 * 起点は動かさない (続けて Shift クリックすると同じ起点から範囲が伸び縮みする)。
 */
export function rangeTableSelection(
  sel: TableSelection,
  rows: readonly ExplorerRow[],
  db: string,
  tbl: string,
  additive = false,
): TableSelection {
  const key = tableKey(db, tbl);
  const selectable = rows.filter(isSelectableTableRow).filter((r) => r.db === db);
  const to = selectable.findIndex((r) => r.tbl === tbl);
  const anchorKey = sel.db === db ? sel.anchor : null;
  const from = anchorKey === null ? -1 : selectable.findIndex((r) => tableKey(r.db, r.tbl) === anchorKey);
  if (to === -1 || from === -1) {
    return { db, keys: new Set(sel.db === db && additive ? [...sel.keys, key] : [key]), anchor: key };
  }
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  const keys = new Set<string>(sel.db === db && additive ? sel.keys : []);
  for (let i = lo; i <= hi; i++) {
    const r = selectable[i];
    if (r) keys.add(tableKey(r.db, r.tbl));
  }
  return { db, keys, anchor: anchorKey };
}

/**
 * Shift+↑/↓: 現在の行から隣のテーブル行へ範囲を伸ばす。隣がテーブル行でない (別の見出し・
 * ビュー・列など) ときは null (呼び出し側は通常のフォーカス移動に任せる)。起点が無ければ
 * 現在の行を起点にする。戻り値の `focusKey` は次にフォーカスする行の `data-tree-key`。
 */
export function extendTableSelection(
  sel: TableSelection,
  rows: readonly ExplorerRow[],
  db: string,
  tbl: string,
  direction: 1 | -1,
): { selection: TableSelection; focusKey: string } | null {
  const here = rows.findIndex((r) => r.kind === "table" && r.db === db && r.tbl === tbl);
  if (here === -1) return null;
  let next = here + direction;
  while (next >= 0 && next < rows.length) {
    const r = rows[next];
    if (r && isFocusableExplorerRow(r)) break;
    next += direction;
  }
  const target = rows[next];
  if (!target || !isSelectableTableRow(target) || target.db !== db) return null;
  const base =
    sel.db === db && sel.anchor !== null ? sel : { db, keys: new Set([tableKey(db, tbl)]), anchor: tableKey(db, tbl) };
  return {
    selection: rangeTableSelection(base, rows, db, target.tbl),
    focusKey: target.key,
  };
}

/** 一覧から消えたテーブルを選択から外す。変化が無ければ同じ参照を返す。 */
export function pruneTableSelection(
  sel: TableSelection,
  tables: Readonly<Record<string, readonly string[] | undefined>>,
): TableSelection {
  if (sel.db === null) return sel;
  const live = tables[sel.db];
  if (live === undefined) return EMPTY_TABLE_SELECTION;
  const present = new Set(live.map((t) => tableKey(sel.db as string, t)));
  const keys = [...sel.keys].filter((k) => present.has(k));
  const anchor = sel.anchor !== null && present.has(sel.anchor) ? sel.anchor : null;
  if (keys.length === sel.keys.size && anchor === sel.anchor) return sel;
  return keys.length === 0 && anchor === null ? EMPTY_TABLE_SELECTION : { db: sel.db, keys: new Set(keys), anchor };
}

/** 選択中のテーブル名を、データベース内の並び (`dbTables`) の順で返す。 */
export function orderedSelectedTables(sel: TableSelection, dbTables: readonly string[]): string[] {
  if (sel.db === null) return [];
  const db = sel.db;
  return dbTables.filter((t) => sel.keys.has(tableKey(db, t)));
}
