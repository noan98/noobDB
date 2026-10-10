import type { Completion } from "@codemirror/autocomplete";
import type { SQLNamespace } from "@codemirror/lang-sql";
import type { ForeignKey, TableColumnInfo } from "../api/tauri";

/**
 * スキーマ補完 (#1413) の名前空間と情報パネルの内容を作る純ロジック。CodeMirror の
 * DOM には依存せず、`QueryEditor.tsx` が `sql({ schema })` に渡し、DOM への描画は
 * `completionInfoPanel.ts` が担う。
 *
 * 種別 (`Completion.type`) は次の語彙で、`completionIcons.ts` がアイコンに対応づける:
 * `table` (テーブル) / `database` (DB 名前空間) / `column` (列) / `fk` (外部キー列) /
 * `function` (関数) / `keyword` / `datatype` (データ型名)。主キーは補完時点では見分けず、
 * 情報パネルに出す。
 */

/** (テーブル名, 列名) から、その列候補の `info` を返す。 */
export type ColumnInfoLoader = (table: string, column: string) => Completion["info"];

export interface SchemaNamespaceOptions {
  /** テーブル名 → 列名。 */
  tables: Record<string, string[]>;
  /** DB 名で名前空間を切る (`db.table.column`)。SQLite などは null。 */
  namespaceDb: string | null;
  /** 識別子のクォート文字 (lang-sql の方言設定と同じもの)。 */
  idQuote: string;
  /** 識別子の大文字小文字を区別しない方言か (クォート要否の判定に使う)。 */
  idCaseInsensitive: boolean;
  /** 外部キー一覧。列の種別 (`key`) と `→ 参照先` の補足に使う。 */
  fks: ForeignKey[];
  /** 列候補の `info` を作る関数。未指定なら情報パネルなし。 */
  columnInfo?: ColumnInfoLoader;
}

/** `Completion.apply` が必要か (単純な識別子でなければクォートして挿入する)。 */
function needsQuote(label: string, caseInsensitive: boolean): boolean {
  return !new RegExp("^[a-z_][a-z_\\d]*$", caseInsensitive ? "i" : "").test(label);
}

function closingQuote(open: string): string {
  return open === "[" ? "]" : open;
}

function nameOption(
  label: string,
  type: string,
  o: Pick<SchemaNamespaceOptions, "idQuote" | "idCaseInsensitive">,
): Completion {
  return needsQuote(label, o.idCaseInsensitive)
    ? { label, type, apply: o.idQuote + label + closingQuote(o.idQuote) }
    : { label, type };
}

/** `table\0column` (小文字) → `参照テーブル.参照列`。 */
function fkTargets(fks: ForeignKey[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const fk of fks) {
    const key = `${fk.table.toLowerCase()}\u0000${fk.column.toLowerCase()}`;
    if (m.has(key)) continue; // 複合 FK は先頭だけ見せる
    m.set(
      key,
      fk.referenced_column ? `${fk.referenced_table}.${fk.referenced_column}` : fk.referenced_table,
    );
  }
  return m;
}

/**
 * `sql({ schema })` に渡す名前空間を作る。lang-sql 既定の名前空間 (テーブル = `type`、
 * 列 = `property`) の代わりに、テーブル = `table`、列 = `column`、外部キー列 = `fk`
 * を付け、列には `info` と FK 参照先の補足 (`detail`) を足す。
 * クォート規則は lang-sql の `nameCompletion` と同じ。
 */
export function buildSchemaNamespace(o: SchemaNamespaceOptions): SQLNamespace {
  const targets = fkTargets(o.fks);
  const bare: Record<string, SQLNamespace> = {};
  for (const [table, columns] of Object.entries(o.tables)) {
    const children: Completion[] = columns.map((col) => {
      const ref = targets.get(`${table.toLowerCase()}\u0000${col.toLowerCase()}`);
      const base = nameOption(col, ref ? "fk" : "column", o);
      const info = o.columnInfo?.(table, col);
      return {
        ...base,
        ...(ref ? { detail: `→ ${ref}` } : {}),
        ...(info ? { info } : {}),
      };
    });
    bare[table] = { self: nameOption(table, "table", o), children };
  }
  if (!o.namespaceDb) return bare;
  return {
    ...bare,
    [o.namespaceDb]: { self: nameOption(o.namespaceDb, "database", o), children: { ...bare } },
  };
}

/**
 * 3 方言で共通して使う代表的な関数名 (集約・文字列・数値・日付・NULL 処理)。lang-sql の
 * 辞書は関数を種別で区別しない (`COUNT` や `COALESCE` も `keyword`) ので、ラベルで見分ける。
 * 辞書に無い名前は候補に出ないだけで害はない。
 */
const FUNCTION_NAMES: ReadonlySet<string> = new Set([
  "COUNT", "SUM", "AVG", "MIN", "MAX",
  "COALESCE", "NULLIF", "IFNULL", "NVL", "IIF",
  "CONCAT", "LENGTH", "LOWER", "UPPER", "TRIM", "LTRIM", "RTRIM", "SUBSTRING", "SUBSTR", "INSTR",
  "ROUND", "ABS", "CEIL", "CEILING", "FLOOR", "MOD", "POWER", "SQRT",
  "NOW", "CURRENT_DATE", "CURRENT_TIME", "CURRENT_TIMESTAMP", "DATE_TRUNC", "DATE_FORMAT",
  "STRFTIME", "EXTRACT", "CAST", "GREATEST", "LEAST", "GROUP_CONCAT", "STRING_AGG",
  "ROW_NUMBER", "RANK", "DENSE_RANK", "LEAD", "LAG",
]);

/**
 * lang-sql 標準のキーワード候補 (`keyword` / `type` / `variable`) を私たちの種別へ寄せる。
 * 既定の `defaultKeyword` と同じく `boost: -1` を付け、テーブル・列より下位に並べる。
 * `type` はデータ型、代表的な関数名は `function`、それ以外 (`TRUE` / `NULL` や、方言の
 * クライアントコマンドを指す `variable` を含む) は `keyword`。
 */
export function keywordCompletionOption(label: string, type: string): Completion {
  if (type === "type") return { label, type: "datatype", boost: -1 };
  if (FUNCTION_NAMES.has(label.toUpperCase())) return { label, type: "function", boost: -1 };
  return { label, type: "keyword", boost: -1 };
}

/** 情報パネルの 1 行 (見出しと値)。 */
export interface ColumnInfoRow {
  label: string;
  value: string;
}

export interface ColumnInfoLabels {
  type: string;
  nullable: string;
  nullAllowed: string;
  notNull: string;
  primaryKey: string;
  references: string;
  defaultValue: string;
}

export interface ColumnInfoContent {
  /** 列名 (パネルの見出し)。 */
  title: string;
  rows: ColumnInfoRow[];
  /** 列コメント。無ければ省略。 */
  comment?: string;
}

/** `TableColumnInfo` を情報パネルの内容に整形する。値の無い項目は行ごと省く。 */
export function describeColumn(meta: TableColumnInfo, labels: ColumnInfoLabels): ColumnInfoContent {
  const rows: ColumnInfoRow[] = [{ label: labels.type, value: meta.data_type }];
  rows.push({ label: labels.nullable, value: meta.nullable ? labels.nullAllowed : labels.notNull });
  if (meta.key.toUpperCase() === "PRI") {
    rows.push({ label: labels.primaryKey, value: "PRIMARY KEY" });
  }
  if (meta.referenced_table) {
    const target = meta.referenced_column
      ? `${meta.referenced_table}.${meta.referenced_column}`
      : meta.referenced_table;
    rows.push({ label: labels.references, value: target });
  }
  if (meta.default !== null && meta.default !== "") {
    rows.push({ label: labels.defaultValue, value: meta.default });
  }
  const comment = meta.comment?.trim();
  return { title: meta.name, rows, ...(comment ? { comment } : {}) };
}

/** 列名の大小文字を無視して列メタを探す。 */
export function findColumnInfo(
  columns: TableColumnInfo[],
  name: string,
): TableColumnInfo | undefined {
  const lower = name.toLowerCase();
  return columns.find((c) => c.name.toLowerCase() === lower);
}

/** `Completion.type` → `Icon` の語彙。対応が無い種別は null (アイコンなし)。 */
export type CompletionIconName =
  | "table"
  | "database"
  | "columns"
  | "routine"
  | "braces"
  | "hash"
  | "link";

const ICON_BY_TYPE: Record<string, CompletionIconName> = {
  table: "table",
  database: "database",
  column: "columns",
  // 外部キー列は エクスプローラ / ER 図と同じ link アイコン (鍵は主キー専用)。
  fk: "link",
  function: "routine",
  keyword: "braces",
  datatype: "hash",
  // 他の補完ソースが付ける lang-sql 由来の種別。JOIN / CTE・派生表・別名は
  // sqlDerivedCompletion.ts が `class` (CTE・派生表) / `property` (その列) / `variable`
  // (SELECT 別名) を付け、lang-sql 自動生成の名前空間階層は `type` を付ける。
  class: "table",
  property: "columns",
  variable: "columns",
  type: "database",
  constant: "link",
};

/** 補完候補の種別文字列 (空白区切りで複数可) から、先頭の既知種別のアイコン名を返す。 */
export function completionIconName(type: string | undefined): CompletionIconName | null {
  if (!type) return null;
  for (const t of type.split(/\s+/)) {
    const icon = ICON_BY_TYPE[t];
    if (icon) return icon;
  }
  return null;
}
