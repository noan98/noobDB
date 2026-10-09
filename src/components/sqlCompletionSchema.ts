import { snippetCompletion, type Completion } from "@codemirror/autocomplete";
import type { SQLNamespace } from "@codemirror/lang-sql";
import type { ForeignKey, TableColumnInfo } from "../api/tauri";
import type { IconName } from "./Icon";
import { codeMirrorSqlDialectFor, quoteIdentFor } from "./sqlDialect";

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
    case "namespace":
      return null; // DB 名はアイコンを出さない
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
  postgres: ["NOW", "CONCAT", "SUBSTRING", "TO_CHAR", "DATE_TRUNC", "STRING_AGG"],
  sqlite: ["IFNULL", "SUBSTR", "DATE", "DATETIME", "STRFTIME", "GROUP_CONCAT", "TYPEOF"],
};

/** 方言ごとの主要な組み込み関数名 (大文字)。括弧なしで書く関数 (CURRENT_DATE 等) は含めない。 */
function functionNames(driver: string): Set<string> {
  const specific =
    driver === "postgres" ? DRIVER_FUNCTIONS.postgres : driver === "sqlite" ? DRIVER_FUNCTIONS.sqlite : DRIVER_FUNCTIONS.mysql;
  return new Set([...COMMON_FUNCTIONS, ...specific]);
}

/**
 * 方言のキーワード語彙 (小文字名 → 種別)。lang-sql は型定義に出していないが、
 * `keywordCompletionSource` が実行時に `dialect.dialect.words` を読むのと同じ参照。
 */
export function dialectWords(driver: string): Record<string, unknown> {
  const d = codeMirrorSqlDialectFor(driver) as unknown as { dialect?: { words?: Record<string, unknown> } };
  return d.dialect?.words ?? {};
}

function functionCompletion(name: string): Completion {
  // 括弧の中にカーソルを置く。
  return snippetCompletion(`${name}(\${})`, { label: name, type: "function", boost: -1 });
}

/**
 * 関数としても構文キーワード / 型名としても使う語。`DROP TABLE IF EXISTS` /
 * `CREATE OR REPLACE VIEW` / `REPLACE INTO` / `col DATE` で `IF()` 等が挿入されないよう、
 * キーワード一覧に載っている場合は関数スニペットへ変換せずキーワードのまま残す。
 */
const KEYWORD_FIRST = new Set(["IF", "REPLACE", "DATE"]);

/**
 * lang-sql の `SQLConfig.keywordCompletion` に渡すビルダー。キーワード一覧に含まれる
 * 関数名 (COUNT 等) を `function` 型の補完へ変換し、キーワード行と関数行の二重表示を防ぐ。
 */
export function keywordCompletionBuilder(driver: string): (label: string, type: string) => Completion {
  const names = functionNames(driver);
  return (label, type) => {
    const upper = label.toUpperCase();
    return names.has(upper) && !KEYWORD_FIRST.has(upper) ? functionCompletion(upper) : { label, type, boost: -1 };
  };
}

/**
 * 方言のキーワード一覧に無い組み込み関数 (NOW / IFNULL / TO_CHAR / STRFTIME 等) の補完。
 * `isKeyword` は小文字名がキーワード一覧にあるかの判定で、ある名前は
 * `keywordCompletionBuilder` 側が出すので重複させない。
 */
export function functionCompletions(driver: string, isKeyword: (lower: string) => boolean): Completion[] {
  return [...functionNames(driver)].filter((n) => !isKeyword(n.toLowerCase())).map(functionCompletion);
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
    namespaceDb && driver !== "sqlite"
      ? { ...tables, [namespaceDb]: { self: { label: namespaceDb, type: "namespace" }, children: { ...tables } } }
      : { ...tables };
  return { schema, defaultTable: activeTable?.name, defaultSchema: namespaceDb };
}
