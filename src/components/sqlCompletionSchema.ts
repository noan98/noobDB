import type { Completion } from "@codemirror/autocomplete";
import type { SQLNamespace } from "@codemirror/lang-sql";
import type { ForeignKey, TableColumnInfo } from "../api/tauri";
import type { IconName } from "./Icon";
import { quoteIdentFor } from "./sqlDialect";

/**
 * SQL 補完 (#1413) の名前空間と情報パネルのモデルを作る純ロジック。
 * CodeMirror の `Completion` 型には依存するが DOM / React には依存しない
 * (DOM の組み立ては `sqlCompletionInfo.ts`)。
 */

/** 補完候補の種別 (アイコン・色の単位)。 */
export type CompletionKind = "table" | "column" | "keyword" | "function";

/**
 * CodeMirror の `Completion.type` → 種別。lang-sql はテーブルを `type`、キーワードを
 * `keyword` / `type` (INT などのデータ型名) / `variable` (組み込み) で返し、関数は
 * 返さない。そのためテーブルは名前空間の self タグで `table` を明示し、`type` は
 * キーワード扱いにする。関数は本モジュールの `functionCompletions` が `function` を付ける。
 * 未知の型は null。
 */
export function completionKind(type: string | undefined): CompletionKind | null {
  switch (type) {
    case "table":
      return "table";
    case "property":
    case "column":
      return "column";
    case "keyword":
    case "type":
    case "variable":
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
  keyword: "text",
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

/**
 * lang-sql が文字列候補にだけ付ける識別子クォート規則 (`^[a-z_][a-z_\d]*$` に合わない
 * 名前は挿入時にクォートする) の再現。候補をオブジェクトにするとこの処理が外れるため、
 * 自前で `apply` を組み立てる。方言のクォート文字は `quoteIdentFor` に従う。
 */
export function identApply(driver: string, name: string): { apply?: string } {
  return /^[a-z_][a-z_\d]*$/.test(name) ? {} : { apply: quoteIdentFor(driver, name) };
}

const COMMON_FUNCTIONS = [
  "COUNT", "SUM", "AVG", "MIN", "MAX", "COALESCE", "NULLIF", "CAST",
  "LOWER", "UPPER", "LENGTH", "TRIM", "REPLACE", "ABS", "ROUND",
];
const DRIVER_FUNCTIONS: Record<"mysql" | "postgres" | "sqlite", string[]> = {
  mysql: ["NOW", "IFNULL", "CONCAT", "SUBSTRING", "DATE_FORMAT", "CURDATE", "GROUP_CONCAT", "IF"],
  postgres: ["NOW", "CONCAT", "SUBSTRING", "TO_CHAR", "DATE_TRUNC", "STRING_AGG", "CURRENT_DATE"],
  sqlite: ["IFNULL", "SUBSTR", "DATE", "DATETIME", "STRFTIME", "GROUP_CONCAT", "TYPEOF"],
};

/** 方言ごとの主要な組み込み関数の補完 (`type: "function"`)。lang-sql は関数を返さないため補う。 */
export function functionCompletions(driver: string): Completion[] {
  const specific =
    driver === "postgres" ? DRIVER_FUNCTIONS.postgres : driver === "sqlite" ? DRIVER_FUNCTIONS.sqlite : DRIVER_FUNCTIONS.mysql;
  return [...COMMON_FUNCTIONS, ...specific].map((name) => ({
    label: name,
    apply: `${name}(`,
    type: "function",
    boost: -1,
  }));
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
      ...identApply(driver, column),
      ...(columnInfo ? { info: columnInfo(table, column) } : {}),
    }));
    tables[table] = {
      self: { label: table, type: "table", ...identApply(driver, table) },
      children: columns,
    };
  }
  const namespaceDb = activeTable?.database ?? defaultDatabase ?? undefined;
  const schema: SQLNamespace =
    namespaceDb && driver !== "sqlite" ? { ...tables, [namespaceDb]: { ...tables } } : { ...tables };
  return { schema, defaultTable: activeTable?.name, defaultSchema: namespaceDb };
}
