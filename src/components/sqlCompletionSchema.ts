import type { Completion } from "@codemirror/autocomplete";
import type { SQLNamespace } from "@codemirror/lang-sql";
import type { ForeignKey, TableColumnInfo } from "../api/tauri";
import type { IconName } from "./Icon";

/**
 * SQL 補完 (#1413) の名前空間と情報パネルのモデルを作る純ロジック。
 * CodeMirror の `Completion` 型には依存するが DOM / React には依存しない
 * (DOM の組み立ては `sqlCompletionInfo.ts`)。
 */

/** 補完候補の種別 (アイコン・色の単位)。 */
export type CompletionKind = "table" | "column" | "keyword" | "function";

/**
 * CodeMirror の `Completion.type` → 種別。lang-sql はテーブルに `type`、列に
 * `property`、キーワードに `keyword`、関数に `function` を付ける。未知の型は null
 * (アイコンを出さない)。
 */
export function completionKind(type: string | undefined): CompletionKind | null {
  switch (type) {
    case "type":
    case "table":
      return "table";
    case "property":
    case "column":
      return "column";
    case "keyword":
      return "keyword";
    case "function":
    case "method":
      return "function";
    default:
      return null;
  }
}

const KIND_ICON: Record<CompletionKind, IconName> = {
  table: "table",
  column: "columns",
  keyword: "key",
  function: "routine",
};

/** 種別に対応するアイコン名 (`Icon.tsx` の語彙)。 */
export function completionIconName(kind: CompletionKind): IconName {
  return KIND_ICON[kind];
}

/** 列情報パネルの表示モデル。 */
export interface ColumnInfoView {
  /** データ型。メタ未取得なら null。 */
  dataType: string | null;
  /** NULL 可否。メタ未取得なら null。 */
  nullable: boolean | null;
  primaryKey: boolean;
  /** FK 参照先 (`table.column` / 参照列不明なら `table`)。FK でなければ null。 */
  references: string | null;
}

/**
 * 列メタ (`describe_table`) と FK 一覧から情報パネルのモデルを作る。メタも FK も
 * 無い (= 出せる情報が無い) 場合は null。メタ未取得でも FK だけは縮退表示できる。
 */
export function describeColumn(
  meta: TableColumnInfo | undefined,
  fk: ForeignKey | undefined,
): ColumnInfoView | null {
  if (!meta && !fk) return null;
  const refTable = fk?.referenced_table ?? meta?.referenced_table ?? null;
  const refColumn = fk ? fk.referenced_column : (meta?.referenced_column ?? null);
  const references = refTable ? (refColumn ? `${refTable}.${refColumn}` : refTable) : null;
  return {
    dataType: meta?.data_type ?? null,
    nullable: meta ? meta.nullable : null,
    primaryKey: meta?.key === "PRI",
    references,
  };
}

/** `table.column` に一致する FK を探す。 */
export function findForeignKey(
  fks: readonly ForeignKey[],
  table: string,
  column: string,
): ForeignKey | undefined {
  return fks.find((f) => f.table === table && f.column === column);
}

export interface CompletionNamespaceInput {
  driver: string;
  /** テーブル名 → 列名。 */
  tableColumns: Record<string, string[]>;
  /** アクティブなテーブル (未修飾の列補完に使う)。 */
  activeTable?: { database: string; name: string } | null;
  defaultDatabase?: string | null;
  /** 列候補の情報パネル。未指定なら列は名前だけ。 */
  columnInfo?: (table: string, column: string) => Completion["info"];
}

export interface CompletionNamespace {
  schema: SQLNamespace;
  defaultTable?: string;
  defaultSchema?: string;
}

/**
 * lang-sql の `schema` を組み立てる。テーブルは裸 (`table.column`) と DB 修飾
 * (`db.table.column`) の両方で公開し、列候補には `columnInfo` による情報パネルを付ける。
 * SQLite には DB 修飾子が無いので裸のみ。テーブルが 1 つも無ければ null。
 */
export function buildCompletionNamespace(input: CompletionNamespaceInput): CompletionNamespace | null {
  const { driver, tableColumns, activeTable, defaultDatabase, columnInfo } = input;
  const names = Object.keys(tableColumns);
  if (names.length === 0) return null;

  const tables: Record<string, SQLNamespace> = {};
  for (const table of names) {
    const columns: Completion[] = tableColumns[table].map((column) => ({
      label: column,
      type: "property",
      ...(columnInfo ? { info: columnInfo(table, column) } : {}),
    }));
    tables[table] = columns;
  }
  const namespaceDb = activeTable?.database ?? defaultDatabase ?? undefined;
  const schema: SQLNamespace =
    namespaceDb && driver !== "sqlite" ? { ...tables, [namespaceDb]: { ...tables } } : { ...tables };
  return { schema, defaultTable: activeTable?.name, defaultSchema: namespaceDb };
}
