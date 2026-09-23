/**
 * Database Explorer (サイドバーのスキーマツリー) の階層整理 (#1112 / Epic #1110
 * Phase 2) の純ロジック。副作用なし (DOM / Tauri に触れない) なので Vitest で
 * 単体テストできる。
 *
 * ## 階層
 *
 * ```
 * Connection
 * └ Database (PostgreSQL / DuckDB ではスキーマ)
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
 * ツリーの「データベース」階層が実際に何を表すか。PostgreSQL / DuckDB は接続が
 * 1 つの実データベースに固定され、この階層にはスキーマ (名前空間) が並ぶ
 * (バックエンドの `databases()` の実装に対応)。ツールチップと読み上げで取り違え
 * ないよう、ドライバごとに呼び分ける。
 */
export function explorerContainerKind(driver: string): "database" | "schema" {
  return driver === "postgres" || driver === "duckdb" ? "schema" : "database";
}
