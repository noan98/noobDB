import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Box, chakra, type SystemStyleObject } from "@chakra-ui/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { sql as sqlLang } from "@codemirror/lang-sql";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { api, type TableColumnInfo } from "../api/tauri";
import { useT, type I18nKey } from "../i18n";
import { codeMirrorSqlDialectFor, isSystemDatabase, quoteIdentFor } from "./sqlDialect";
import { copyToClipboard } from "./clipboard";
import { classifyEditType, quoteString, type EditTypeKind } from "./cellEdit";
import { resolveDynamicValue, type QuickSetDynamic } from "./quickSetValues";
import { Icon, ICON_SIZES } from "./Icon";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, Checkbox, Select } from "./ui";
import { useToast } from "./Toast";
import { Tooltip } from "./Tooltip";

/**
 * Query Builder のフォーム部のスタイル。各要素へ直接 `css` を適用する。
 * SQL プレビューの CodeMirror 周りのレイアウト
 * (`.cm-*`) だけは CodeMirror が生成する DOM を対象にするため、`previewCss` 内で
 * タグ/要素スコープのセレクタとして残す (CodeMirror 本体のテーマは対象外)。
 */
const errorCss: SystemStyleObject = {
  py: "2",
  px: "2.5",
  border: "1px solid var(--border)",
  background: "var(--bg-error)",
  color: "var(--text-error)",
  borderRadius: "var(--radius-md)",
  fontSize: "var(--text-sm)",
  marginBottom: "2.5",
};
const sectionCss: SystemStyleObject = {
  display: "flex",
  flexDirection: "column",
  gap: "1.5",
  marginBottom: "2.5",
};
// タイポグラフィは `textStyles.overline` (#817) に一本化。以前は生の CSS 変数
// (`var(--text-xs)` / `var(--text-muted)`) を直書きしており、他ファイルの
// トークン参照 (`fontSize="2xs"` 等) や字間の値ともズレていた。
const sectionTitleCss: SystemStyleObject = {
  textStyle: "overline",
};
const sectionRowCss: SystemStyleObject = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "2",
};
const grid2SectionCss: SystemStyleObject = {
  marginBottom: "2.5",
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "3",
};
const grid2ChildCss: SystemStyleObject = {
  display: "flex",
  flexDirection: "column",
  gap: "1",
};
const pillListCss: SystemStyleObject = { display: "flex", flexWrap: "wrap", gap: "1" };
/** クエリ種別ピル。選択中はアクセント色。 */
function pillCss(active: boolean): SystemStyleObject {
  const base: SystemStyleObject = {
    py: "1",
    px: "2.5",
    border: "1px solid var(--border-strong)",
    background: "var(--bg-elevated)",
    color: "var(--text)",
    borderRadius: "var(--radius-pill)",
    fontSize: "var(--text-sm)",
    cursor: "pointer",
    transition: "background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease)",
    _hover: { background: "var(--bg-hover)" },
  };
  if (active) {
    return { ...base, background: "var(--accent)", color: "var(--accent-text)", borderColor: "var(--accent)" };
  }
  return base;
}
const checkboxLabelCss: SystemStyleObject = {
  display: "inline-flex",
  alignItems: "center",
  gap: "1.5",
  fontSize: "var(--text-md)",
  fontWeight: 500,
  color: "var(--text)",
  margin: 0,
};
const rowCss: SystemStyleObject = { display: "flex", gap: "1.5", alignItems: "center" };
// 行内の入力は伸縮させる。
const rowInputCss: SystemStyleObject = { flex: 1, minWidth: 0 };
const opCss: SystemStyleObject = { width: "110px", flexShrink: 0 };
const eqCss: SystemStyleObject = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--text-muted)",
  fontWeight: 600,
  minWidth: "16px",
};
const iconBtnCss: SystemStyleObject = {
  py: "0.5",
  px: "2",
  fontSize: "var(--text-sm)",
  border: "1px solid var(--border-strong)",
  background: "var(--bg-elevated)",
  color: "var(--text-muted)",
  borderRadius: "var(--radius-sm)",
  cursor: "pointer",
  flexShrink: 0,
  "&:hover:not(:disabled)": {
    color: "var(--text-error)",
    borderColor: "var(--text-error)",
  },
};
const selectedColsWrapCss: SystemStyleObject = {
  overflowX: "auto",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-md)",
  background: "var(--bg-muted)",
};
// 属性テーブルのみ `td` をタグセレクタで括る (className ではなく要素スコープ)。
const selectedColsCss: SystemStyleObject = {
  borderCollapse: "collapse",
  width: "max-content",
  minWidth: "100%",
  "& td": {
    padding: "4px 6px 4px 10px",
    borderRight: "1px solid var(--border)",
    fontSize: "var(--text-sm)",
    color: "var(--text)",
    whiteSpace: "nowrap",
    verticalAlign: "middle",
  },
  "& td:last-child": { borderRight: "none" },
};
const selectedColNameCss: SystemStyleObject = { marginRight: "1.5" };
const chipRemoveCss: SystemStyleObject = {
  padding: "0 6px",
  fontSize: "var(--text-xs)",
  lineHeight: 1.4,
  border: "1px solid transparent",
  background: "transparent",
  color: "var(--text-muted)",
  borderRadius: "var(--radius-sm)",
  cursor: "pointer",
  _hover: { color: "var(--text-error)", borderColor: "var(--text-error)" },
};
const smallBtnCss: SystemStyleObject = {
  padding: "3px 10px",
  fontSize: "var(--text-xs)",
  borderRadius: "var(--radius-sm)",
};
const limitSectionCss: SystemStyleObject = {
  marginBottom: "2.5",
  display: "grid",
  gridTemplateColumns: "80px 1fr",
  alignItems: "center",
  gap: "3",
};
const limitInputCss: SystemStyleObject = { maxWidth: "120px" };
// WHERE / SET / INSERT の 1 行 (カラム・演算子・値・削除ボタン) + その下に出る
// 任意の 1 行 (NOT NULL 警告) をまとめる縦並びラッパー。行そのもの (`rowCss`) の
// 高さ・整列は変えず、警告テキストだけを別行として追加できるようにする。
const stackedRowCss: SystemStyleObject = { display: "flex", flexDirection: "column", gap: "1" };
// 日時型カラムの「現在日時」ボタンなど、値入力とアイコンボタンを 1 行にまとめる
// ラッパー (行全体の `rowInputCss` と同じ伸縮幅を持つ)。
const valueWithButtonCss: SystemStyleObject = {
  display: "flex",
  gap: "1",
  alignItems: "center",
  flex: 1,
  minWidth: 0,
};
// NOT NULL カラムへの NULL 入力・LIMIT の非数値入力など、実行はブロックしない
// ベストエフォートの注意書き。既存の警告色トークン (`--warning-*`、
// DangerousQueryDialog の `semanticColorToken("warning", ...)` と同じ意味色) を使う。
const inlineWarningCss: SystemStyleObject = {
  fontSize: "var(--text-xs)",
  color: "var(--warning-text)",
};
// WHERE 句なしの UPDATE/DELETE (= 全行が対象) を SQL プレビュー直上で警告する
// バンド。危険度が高いため `errorCss` と同じ色トークン (`--error-*` = 意味役割
// "danger") を再利用し、太字にして目立たせる。
const noWhereBandCss: SystemStyleObject = {
  py: "2",
  px: "2.5",
  border: "1px solid var(--error-border)",
  background: "var(--bg-error)",
  color: "var(--text-error)",
  borderRadius: "var(--radius-md)",
  fontSize: "var(--text-sm)",
  fontWeight: 600,
  marginBottom: "2.5",
};
const previewWrapCss: SystemStyleObject = { position: "relative" };
const previewCopyCss: SystemStyleObject = {
  position: "absolute",
  top: "6px",
  right: "6px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "26px",
  height: "26px",
  padding: 0,
  border: "1px solid var(--border-strong)",
  background: "var(--bg-elevated)",
  color: "var(--text-muted)",
  borderRadius: "var(--radius-sm)",
  cursor: "pointer",
  zIndex: 1,
  transition:
    "color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease)",
  _hover: { color: "var(--text)", background: "var(--bg-hover)" },
  _focusVisible: {
    outline: "none",
    borderColor: "var(--accent)",
    boxShadow: "var(--focus-ring)",
  },
};
const previewCss: SystemStyleObject = {
  margin: 0,
  background: "var(--bg-muted)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-md)",
  overflow: "hidden",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
  color: "var(--text)",
  lineHeight: 1.5,
  "& .cm-editor": {
    background: "transparent",
    fontFamily: "inherit",
    fontSize: "inherit",
    color: "inherit",
    lineHeight: "inherit",
  },
  "& .cm-editor.cm-focused": { outline: "none" },
  "& .cm-scroller": { fontFamily: "inherit", overflow: "auto" },
  "& .cm-content": { padding: "10px 40px 10px 12px" },
  "& .cm-line": { padding: 0 },
};

const qbHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--syntax-keyword)", fontWeight: "bold" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--syntax-string)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--syntax-number)" },
  {
    tag: [tags.lineComment, tags.blockComment, tags.docComment],
    color: "var(--syntax-comment)",
    fontStyle: "italic",
  },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: "var(--syntax-function)",
  },
  { tag: tags.operator, color: "var(--syntax-operator)" },
]);

export type QueryKind = "SELECT" | "INSERT" | "UPDATE" | "DELETE";

const WHERE_OPERATORS = ["=", "!=", "<", "<=", ">", ">=", "LIKE", "IN", "IS NULL", "IS NOT NULL"] as const;

export interface WhereCondition {
  column: string;
  operator: string;
  value: string;
}

function normalizeOperator(op: string): string {
  return op.trim().toUpperCase();
}

function isNullOperator(op: string): boolean {
  const n = normalizeOperator(op);
  return n === "IS NULL" || n === "IS NOT NULL";
}

export interface ColumnValuePair {
  column: string;
  value: string;
}

/**
 * Full snapshot of the builder's inputs. Lifted into the owning tab's state so
 * the most recent Run / Dry Run can be restored when the builder is reopened
 * in the same tab. Held in memory only — never persisted to disk.
 */
export interface QueryBuilderSnapshot {
  kind: QueryKind;
  database: string;
  table: string;
  selectAll: boolean;
  selectColumns: string[];
  whereEnabled: boolean;
  whereConditions: WhereCondition[];
  limitEnabled: boolean;
  limit: string;
  setPairs: ColumnValuePair[];
  insertPairs: ColumnValuePair[];
}

interface Props {
  sessionId: string;
  driver: string;
  defaultDatabase?: string | null;
  defaultTable?: string | null;
  initialSnapshot?: QueryBuilderSnapshot | null;
  /**
   * When true the session rejects writes, so Run is disabled for write query
   * kinds (INSERT/UPDATE/DELETE). The kind pills and Dry Run stay enabled — the
   * user can still build/copy a statement or preview it (a dry run rolls back).
   */
  readOnly?: boolean;
  onExecute: (sql: string) => void;
  onPreview?: (sql: string) => void;
  onPersist?: (snapshot: QueryBuilderSnapshot) => void;
  onClose: () => void;
}

function pickDefaultDatabase(driver: string, list: string[]): string | null {
  const user = list.find((d) => !isSystemDatabase(driver, d));
  return user ?? list[0] ?? null;
}

// テスト (QueryBuilder.test.ts) からバックスラッシュ/クオート処理を直接検証
// できるよう export する (他の生成ロジックと違い、この関数はコンポーネント外に
// 切り出されておらずここが唯一のテスト経路)。
export function quoteValue(driver: string, raw: string): string {
  const v = raw.trim();
  if (v === "") return "''";
  if (/^null$/i.test(v)) return "NULL";
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  if (/^(true|false)$/i.test(v)) {
    // SQLite/MSSQL have no native boolean literal — emit 1/0 instead of
    // TRUE/FALSE (T-SQL `BIT` columns take 0/1; see `cellEdit.ts`'s
    // `literalFromCellValue`).
    if (driver === "sqlite" || driver === "mssql") return v.toLowerCase() === "true" ? "1" : "0";
    return v.toUpperCase();
  }
  // バックスラッシュの二重化は MySQL のみ必要。PostgreSQL (既定の
  // standard_conforming_strings = on)・SQLite・MSSQL ではバックスラッシュは
  // ただの文字なので、二重化すると値が変わってしまい (例: C:\temp が
  // C:\\temp として保存され)、WHERE 句が既存行に一致しなくなる。
  // cellEdit.ts の quoteString / db/data_diff.rs の quote_string と方針を揃える。
  const escaped =
    driver === "mysql" ? v.replace(/\\/g, "\\\\").replace(/'/g, "''") : v.replace(/'/g, "''");
  return (driver === "mssql" ? "N" : "") + "'" + escaped + "'";
}

/**
 * Column-type aware literal builder (改善 1). `quoteValue` above guesses a
 * value's shape from the text itself, which is wrong whenever the shape lies:
 * typing the digits `123` into a VARCHAR column must stay the string `'123'`,
 * not become a bare numeral. When the column's actual `TableColumnInfo` is
 * known, this trusts the declared type instead of the input text.
 *
 * Reuses `cellEdit.ts`'s type classification (`classifyEditType`) and string
 * quoting (`quoteString`) rather than re-deriving them, so the Query Builder's
 * "type → SQL literal" decision cannot drift from the inline cell editor's
 * (`literalFromInput`, not exported — this mirrors its NULL / numeric /
 * boolean rules). Callers fall back to `quoteValue` when no column metadata
 * resolved (e.g. a free-typed column name absent from `describeTable`).
 */
export function quoteValueForColumn(driver: string, raw: string, info: TableColumnInfo): string {
  const trimmed = raw.trim();
  if (/^null$/i.test(trimmed)) return "NULL";
  const kind: EditTypeKind = classifyEditType(info.data_type);
  if (kind === "number" && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(trimmed)) {
    return trimmed;
  }
  if (kind === "boolean") {
    const lc = trimmed.toLowerCase();
    if (lc === "true" || lc === "1") {
      // SQLite/MSSQL have no native boolean literal — 1/0 instead, same
      // convention as `quoteValue` above.
      return driver === "sqlite" || driver === "mssql" ? "1" : "TRUE";
    }
    if (lc === "false" || lc === "0") {
      return driver === "sqlite" || driver === "mssql" ? "0" : "FALSE";
    }
  }
  // Everything else — string-like columns, and a numeric/boolean-looking
  // value that didn't match the column's actual type above — is a quoted
  // string literal. This is the correctness fix: a VARCHAR column never
  // silently turns "123" or "true" into an unquoted literal.
  return quoteString(driver, raw);
}

/** Looks up a table's column metadata by name; `undefined` for a free-typed
 *  column absent from the `describeTable` result (callers fall back to the
 *  type-agnostic `quoteValue`). */
function resolveColumnInfo(
  columns: TableColumnInfo[],
  name: string,
): TableColumnInfo | undefined {
  return columns.find((c) => c.name === name);
}

/**
 * Whether a NOT NULL column's edit box currently holds the literal `NULL`
 * keyword (case-insensitive) — this will fail at Apply, so the row shows an
 * inline warning (改善 1-4). Never blocks Run/Dry Run; `computeBuilderBlockedReason`
 * is the only thing that does that (改善 2).
 */
export function isNullValueOnNotNullColumn(
  raw: string,
  info: TableColumnInfo | undefined | null,
): boolean {
  if (!info || info.nullable) return false;
  return /^null$/i.test(raw.trim());
}

function tableRef(driver: string, database: string, table: string): string {
  const tbl = table ? quoteIdentFor(driver, table) : "<table>";
  // SQLite has a single namespace per connection — no database qualifier.
  if (driver === "sqlite") return tbl;
  if (database) {
    // MSSQL (#729): introspection is scoped to the `dbo` schema (see
    // `db/mssql.rs`), so the 3-part `database.dbo.table` form is needed —
    // a bare `database.table` is invalid/ambiguous T-SQL.
    if (driver === "mssql") return `${quoteIdentFor(driver, database)}.[dbo].${tbl}`;
    return `${quoteIdentFor(driver, database)}.${tbl}`;
  }
  return tbl;
}

function renderWhereClause(
  driver: string,
  columns: TableColumnInfo[],
  conditions: WhereCondition[],
): string {
  const rendered = conditions
    .filter((c) => c.column)
    .map((c) => {
      const col = quoteIdentFor(driver, c.column);
      const info = resolveColumnInfo(columns, c.column);
      const literal = (raw: string) =>
        info ? quoteValueForColumn(driver, raw, info) : quoteValue(driver, raw);
      const opNorm = normalizeOperator(c.operator);
      if (opNorm === "IS NULL" || opNorm === "IS NOT NULL") {
        return `${col} ${opNorm}`;
      }
      if (opNorm === "IN") {
        const items = c.value
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .map(literal);
        const inner = items.length > 0 ? items.join(", ") : "<values>";
        return `${col} IN (${inner})`;
      }
      const opOut = c.operator.trim() || "=";
      return `${col} ${opOut} ${literal(c.value)}`;
    });
  if (rendered.length === 0) return " WHERE <column> = <value>";
  return " WHERE " + rendered.join(" AND ");
}

function buildSql(
  driver: string,
  columns: TableColumnInfo[],
  kind: QueryKind,
  database: string,
  table: string,
  selectColumns: string[],
  selectAll: boolean,
  whereEnabled: boolean,
  whereConditions: WhereCondition[],
  limitEnabled: boolean,
  limit: string,
  setPairs: ColumnValuePair[],
  insertPairs: ColumnValuePair[],
): string {
  const ref = tableRef(driver, database, table);
  const where = whereEnabled ? renderWhereClause(driver, columns, whereConditions) : "";
  // 型が分かるカラムは quoteValueForColumn (改善 1) で、フォームの自由入力欄
  // (describeTable に無い列名) は従来の quoteValue へフォールバックする。
  const literalFor = (colName: string, raw: string): string => {
    const info = resolveColumnInfo(columns, colName);
    return info ? quoteValueForColumn(driver, raw, info) : quoteValue(driver, raw);
  };
  switch (kind) {
    case "SELECT": {
      const cols = selectAll || selectColumns.length === 0
        ? "*"
        : selectColumns.map((c) => quoteIdentFor(driver, c)).join(", ");
      const trimmedLimit = limit.trim();
      const hasLimit = limitEnabled && trimmedLimit && /^\d+$/.test(trimmedLimit);
      // MSSQL (#729) has no `LIMIT` keyword; the equivalent, `TOP (n)`, goes
      // right after `SELECT` instead of trailing the statement (mirrors
      // `apply_auto_limit_mssql` on the backend).
      if (driver === "mssql") {
        const topClause = hasLimit ? `TOP (${trimmedLimit}) ` : "";
        return `SELECT ${topClause}${cols} FROM ${ref}${where};`;
      }
      const limitClause = hasLimit ? ` LIMIT ${trimmedLimit}` : "";
      return `SELECT ${cols} FROM ${ref}${where}${limitClause};`;
    }
    case "UPDATE": {
      const set = setPairs
        .filter((p) => p.column)
        .map((p) => `${quoteIdentFor(driver, p.column)} = ${literalFor(p.column, p.value)}`)
        .join(", ");
      const setClause = set || "<column> = <value>";
      return `UPDATE ${ref} SET ${setClause}${where};`;
    }
    case "DELETE": {
      return `DELETE FROM ${ref}${where};`;
    }
    case "INSERT": {
      const active = insertPairs.filter((p) => p.column);
      const cols = active.length > 0
        ? active.map((p) => quoteIdentFor(driver, p.column)).join(", ")
        : "<column>";
      const vals = active.length > 0
        ? active.map((p) => literalFor(p.column, p.value)).join(", ")
        : "<value>";
      return `INSERT INTO ${ref} (${cols}) VALUES (${vals});`;
    }
  }
}

/** Input to {@link computeBuilderBlockedReason} — the subset of builder state
 *  that decides whether the generated SQL still contains an unfilled
 *  placeholder (`<table>` / `<column>` / `<value>` / `<values>`, see
 *  `buildSql`/`renderWhereClause` above). */
export interface BuilderValidationInput {
  kind: QueryKind;
  table: string;
  whereEnabled: boolean;
  whereConditions: WhereCondition[];
  setPairs: ColumnValuePair[];
  insertPairs: ColumnValuePair[];
}

/**
 * 改善 2-1: Run / Dry Run を無効化すべきかどうかの純粋判定。生成 SQL が
 * プレースホルダ (`<table>` 等) を含む状態を、`buildSql` と同じ条件で先回りして
 * 検出する — 文字列として `<table>` 等を SQL から探すのではなく、`buildSql` が
 * それらを埋め込む条件 (テーブル未選択 / 有効なペア 0 件 / WHERE 有効なのに
 * 条件が 1 つも無い) をそのまま判定する。理由ごとに異なる i18n キーを返すため、
 * Run ボタンの Tooltip にそのまま出せる。問題なければ `null`。
 */
export function computeBuilderBlockedReason(input: BuilderValidationInput): I18nKey | null {
  const { kind, table, whereEnabled, whereConditions, setPairs, insertPairs } = input;
  if (!table.trim()) return "qbValidationNoTable";
  if (kind === "INSERT" && insertPairs.filter((p) => p.column).length === 0) {
    return "qbValidationNoInsertValues";
  }
  if (kind === "UPDATE" && setPairs.filter((p) => p.column).length === 0) {
    return "qbValidationNoSetValues";
  }
  const whereIsEmpty = whereEnabled && whereConditions.filter((c) => c.column).length === 0;
  if ((kind === "SELECT" || kind === "UPDATE" || kind === "DELETE") && whereIsEmpty) {
    return "qbValidationNoWhereConditions";
  }
  return null;
}

/** 改善 2-2: LIMIT が有効なのに数値でない (空欄は除く — 単に未入力なだけ)。
 *  ブロックはしない、インライン警告用の純粋判定。 */
export function isLimitInvalid(limitEnabled: boolean, limit: string): boolean {
  const trimmed = limit.trim();
  return limitEnabled && trimmed !== "" && !/^\d+$/.test(trimmed);
}

/**
 * 改善 3: WHERE 句なしの UPDATE/DELETE (= テーブル全行が対象) を示す警告バンドを
 * 出すべきかどうか。WHERE が有効だが条件が空のケース (プレースホルダ WHERE) は
 * `computeBuilderBlockedReason` が Run 自体をブロックするのでここでは対象外 —
 * この関数は「WHERE 自体を無効化した」場合だけを見る。
 */
export function showsNoWhereBand(kind: QueryKind, whereEnabled: boolean): boolean {
  return (kind === "UPDATE" || kind === "DELETE") && !whereEnabled;
}

export function QueryBuilder({ sessionId, driver, defaultDatabase, defaultTable, initialSnapshot, readOnly, onExecute, onPreview, onPersist, onClose }: Props) {
  const t = useT();
  const toast = useToast();

  const [kind, setKind] = useState<QueryKind>(initialSnapshot?.kind ?? "SELECT");
  const [databases, setDatabases] = useState<string[]>([]);
  const [database, setDatabase] = useState<string>(initialSnapshot?.database ?? defaultDatabase ?? "");
  const [tables, setTables] = useState<string[]>([]);
  const [table, setTable] = useState<string>(initialSnapshot?.table ?? defaultTable ?? "");
  // 改善 1: カラム名だけでなく型メタデータ (data_type/nullable) を丸ごと保持し、
  // WHERE/SET/INSERT の値入力を型対応にする (下記 `ValueControl` / `resolveColumnInfo`)。
  const [tableColumns, setTableColumns] = useState<TableColumnInfo[]>([]);
  const [loadingTables, setLoadingTables] = useState(false);
  const [loadingColumns, setLoadingColumns] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectAll, setSelectAll] = useState(initialSnapshot?.selectAll ?? true);
  const [selectColumns, setSelectColumns] = useState<string[]>(initialSnapshot?.selectColumns ?? []);
  const [newSelectCol, setNewSelectCol] = useState("");
  const [whereEnabled, setWhereEnabled] = useState(initialSnapshot?.whereEnabled ?? true);
  const [whereConditions, setWhereConditions] = useState<WhereCondition[]>(
    initialSnapshot?.whereConditions ?? [{ column: "", operator: "=", value: "" }],
  );
  const [limitEnabled, setLimitEnabled] = useState(initialSnapshot?.limitEnabled ?? true);
  const [limit, setLimit] = useState(initialSnapshot?.limit ?? "100");
  const [setPairs, setSetPairs] = useState<ColumnValuePair[]>(
    initialSnapshot?.setPairs ?? [{ column: "", value: "" }],
  );
  const [insertPairs, setInsertPairs] = useState<ColumnValuePair[]>(
    initialSnapshot?.insertPairs ?? [{ column: "", value: "" }],
  );

  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.listDatabases(sessionId)
      .then((list) => {
        if (cancelled) return;
        setDatabases(list);
        if (!database) {
          const pick = pickDefaultDatabase(driver, list);
          if (pick) setDatabase(pick);
        }
      })
      .catch((e) => { if (!cancelled) setLoadError(String(e)); });
    return () => { cancelled = true; };
  }, [sessionId]);

  useEffect(() => {
    if (!database) {
      setTables([]);
      return;
    }
    let cancelled = false;
    setLoadingTables(true);
    api.listTables(sessionId, database)
      .then((list) => {
        if (cancelled) return;
        setTables(list);
        if (!table && list.length > 0) setTable(list[0]);
      })
      .catch((e) => { if (!cancelled) setLoadError(String(e)); })
      .finally(() => { if (!cancelled) setLoadingTables(false); });
    return () => { cancelled = true; };
  }, [sessionId, database]);

  useEffect(() => {
    if (!database || !table) {
      setTableColumns([]);
      return;
    }
    let cancelled = false;
    setLoadingColumns(true);
    api.describeTable(sessionId, database, table)
      .then((cols) => { if (!cancelled) setTableColumns(cols); })
      .catch((e) => { if (!cancelled) setLoadError(String(e)); })
      .finally(() => { if (!cancelled) setLoadingColumns(false); });
    return () => { cancelled = true; };
  }, [sessionId, database, table]);

  const sql = useMemo(
    () => buildSql(driver, tableColumns, kind, database, table, selectColumns, selectAll, whereEnabled, whereConditions, limitEnabled, limit, setPairs, insertPairs),
    [driver, tableColumns, kind, database, table, selectColumns, selectAll, whereEnabled, whereConditions, limitEnabled, limit, setPairs, insertPairs],
  );

  // 改善 2-1: Run / Dry Run のブロック理由 (プレースホルダが残る = 未完成の SQL)。
  const blockedReason = useMemo(
    () => computeBuilderBlockedReason({ kind, table, whereEnabled, whereConditions, setPairs, insertPairs }),
    [kind, table, whereEnabled, whereConditions, setPairs, insertPairs],
  );
  // 改善 2-2: LIMIT が有効なのに数値でない (ブロックはしない、インライン警告のみ)。
  const limitInvalid = isLimitInvalid(limitEnabled, limit);
  // 改善 3: WHERE 句を無効化した UPDATE/DELETE (= 全行が対象)。
  const noWhereBand = showsNoWhereBand(kind, whereEnabled);

  const handleCopy = useCallback(async () => {
    const ok = await copyToClipboard(sql);
    if (!ok) {
      toast.error(t("clipboardCopyFailed"));
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [sql, toast, t]);

  const captureSnapshot = useCallback((): QueryBuilderSnapshot => ({
    kind,
    database,
    table,
    selectAll,
    selectColumns: [...selectColumns],
    whereEnabled,
    whereConditions: whereConditions.map((c) => ({ ...c })),
    limitEnabled,
    limit,
    setPairs: setPairs.map((p) => ({ ...p })),
    insertPairs: insertPairs.map((p) => ({ ...p })),
  }), [kind, database, table, selectAll, selectColumns, whereEnabled, whereConditions, limitEnabled, limit, setPairs, insertPairs]);

  const handleExecute = useCallback(() => {
    // 防御的ガード: 通常はボタンの disabled が押下自体を防ぐ (改善 2-1)。
    if (blockedReason || (!!readOnly && kind !== "SELECT")) return;
    onPersist?.(captureSnapshot());
    onExecute(sql);
    onClose();
  }, [sql, onExecute, onClose, onPersist, captureSnapshot, blockedReason, readOnly, kind]);

  const handlePreview = useCallback(() => {
    if (!onPreview || blockedReason) return;
    onPersist?.(captureSnapshot());
    onPreview(sql);
    onClose();
  }, [sql, onPreview, onClose, onPersist, captureSnapshot, blockedReason]);

  const addSelectColumn = (col: string) => {
    const v = col.trim();
    if (!v) return;
    setSelectColumns((prev) => (prev.includes(v) ? prev : [...prev, v]));
    setNewSelectCol("");
  };
  const removeSelectColumn = (col: string) => {
    setSelectColumns((prev) => prev.filter((c) => c !== col));
  };

  const updateCondition = (idx: number, patch: Partial<WhereCondition>) => {
    setWhereConditions((prev) => prev.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  };
  const addCondition = () =>
    setWhereConditions((prev) => [...prev, { column: "", operator: "=", value: "" }]);
  const removeCondition = (idx: number) =>
    setWhereConditions((prev) => prev.filter((_, i) => i !== idx));

  const updatePair = (which: "set" | "insert", idx: number, patch: Partial<ColumnValuePair>) => {
    const apply = (prev: ColumnValuePair[]) => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p));
    if (which === "set") setSetPairs(apply);
    else setInsertPairs(apply);
  };
  const addPair = (which: "set" | "insert") => {
    if (which === "set") setSetPairs((p) => [...p, { column: "", value: "" }]);
    else setInsertPairs((p) => [...p, { column: "", value: "" }]);
  };
  const removePair = (which: "set" | "insert", idx: number) => {
    if (which === "set") setSetPairs((p) => p.filter((_, i) => i !== idx));
    else setInsertPairs((p) => p.filter((_, i) => i !== idx));
  };

  // A read-only session rejects writes, so Run is disabled for write kinds.
  // SELECT still runs, and Dry Run stays available (it rolls back).
  const runBlockedByReadOnly = !!readOnly && kind !== "SELECT";
  // 改善 2-1: プレースホルダが残る未完成の SQL は、読み取り専用かどうかに
  // 関わらず Run/Dry Run 双方をブロックする。
  const runDisabled = runBlockedByReadOnly || !!blockedReason;
  const dryRunDisabled = !!blockedReason;

  const showWhere = kind === "SELECT" || kind === "UPDATE" || kind === "DELETE";
  const showSelectColumns = kind === "SELECT";
  const showLimit = kind === "SELECT";
  const showSet = kind === "UPDATE";
  const showInsertValues = kind === "INSERT";

  const columnOptions = tableColumns.map((c) => c.name);

  return (
    <Modal onClose={onClose}>
      <ModalHeader onClose={onClose} closeLabel={t("qbClose")}>
        {t("qbTitle")}
      </ModalHeader>
      <ModalBody>
        <Box display="flex" flexDirection="column" gap="1.5">
          {loadError && <Box css={errorCss}>{loadError}</Box>}

          <chakra.section css={sectionCss}>
            <Box css={sectionTitleCss}>{t("qbQueryType")}</Box>
            <Box css={pillListCss}>
              {(["SELECT", "INSERT", "UPDATE", "DELETE"] as QueryKind[]).map((k) => (
                <chakra.button
                  key={k}
                  type="button"
                  css={pillCss(kind === k)}
                  onClick={() => setKind(k)}
                >
                  {k}
                </chakra.button>
              ))}
            </Box>
          </chakra.section>

          <chakra.section css={grid2SectionCss}>
            <Box css={grid2ChildCss}>
              <chakra.label htmlFor="qb-db">{t("qbDatabase")}</chakra.label>
              <Select
                id="qb-db"
                value={database}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v !== database) setTable("");
                  setDatabase(v);
                }}
              >
                <option value="">—</option>
                {databases.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </Select>
            </Box>
            <Box css={grid2ChildCss}>
              <chakra.label htmlFor="qb-tbl">{t("qbTable")}</chakra.label>
              <Select
                id="qb-tbl"
                value={table}
                disabled={!database || loadingTables}
                onChange={(e) => setTable(e.target.value)}
              >
                <option value="">{loadingTables ? t("qbLoading") : "—"}</option>
                {tables.map((tname) => (
                  <option key={tname} value={tname}>{tname}</option>
                ))}
              </Select>
            </Box>
          </chakra.section>

          {showSelectColumns && (
            <chakra.section css={sectionCss}>
              <Box css={sectionTitleCss}>{t("qbColumns")}</Box>
              <chakra.label css={checkboxLabelCss}>
                <Checkbox
                  checked={selectAll}
                  w="auto"
                  m={0}
                  onChange={(e) => setSelectAll(e.target.checked)}
                />
                <chakra.span>{t("qbAllColumns")}</chakra.span>
              </chakra.label>
              {!selectAll && (
                <>
                  <Box css={rowCss}>
                    <ComboBox
                      css={rowInputCss}
                      value={newSelectCol}
                      options={columnOptions.filter((c) => !selectColumns.includes(c))}
                      placeholder={loadingColumns ? t("qbLoading") : t("qbColumn")}
                      onChange={setNewSelectCol}
                      onEnter={() => addSelectColumn(newSelectCol)}
                    />
                    <chakra.button
                      type="button"
                      css={smallBtnCss}
                      onClick={() => addSelectColumn(newSelectCol)}
                      disabled={!newSelectCol.trim()}
                    >
                      + {t("qbAddColumn")}
                    </chakra.button>
                  </Box>
                  {selectColumns.length > 0 ? (
                    <Box css={selectedColsWrapCss}>
                      <chakra.table css={selectedColsCss}>
                        <tbody>
                          <tr>
                            {selectColumns.map((c) => (
                              <chakra.td key={c}>
                                <chakra.span css={selectedColNameCss}>{c}</chakra.span>
                                <Tooltip label={t("qbRemove")}>
                                  <chakra.button
                                    type="button"
                                    css={chipRemoveCss}
                                    onClick={() => removeSelectColumn(c)}
                                    aria-label={t("qbRemove")}
                                  >
                                    <Icon name="close" size={ICON_SIZES.sm} />
                                  </chakra.button>
                                </Tooltip>
                              </chakra.td>
                            ))}
                          </tr>
                        </tbody>
                      </chakra.table>
                    </Box>
                  ) : (
                    <chakra.span color="app.textMuted" fontSize="12px">
                      {columnOptions.length === 0 && !loadingColumns
                        ? t("qbPickTableFirst")
                        : t("qbNoSelectedColumns")}
                    </chakra.span>
                  )}
                </>
              )}
            </chakra.section>
          )}

          {showSet && (
            <chakra.section css={sectionCss}>
              <Box css={sectionRowCss}>
                <Box css={sectionTitleCss}>{t("qbSet")}</Box>
                <chakra.button type="button" css={smallBtnCss} onClick={() => addPair("set")}>
                  + {t("qbAddSet")}
                </chakra.button>
              </Box>
              {setPairs.map((p, i) => {
                const info = resolveColumnInfo(tableColumns, p.column);
                const notNullWarning = isNullValueOnNotNullColumn(p.value, info);
                return (
                  <Box css={stackedRowCss} key={`set-${i}`}>
                    <Box css={rowCss}>
                      <ColumnPicker
                        value={p.column}
                        options={columnOptions}
                        onChange={(v) => updatePair("set", i, { column: v })}
                        placeholder={t("qbColumn")}
                      />
                      <chakra.span css={eqCss}>=</chakra.span>
                      <ValueControl
                        value={p.value}
                        onChange={(v) => updatePair("set", i, { value: v })}
                        columnInfo={info}
                        placeholder={t("qbValue")}
                        t={t}
                      />
                      <Tooltip label={t("qbRemove")} focusableWrapper={setPairs.length <= 1}>
                        <chakra.button
                          type="button"
                          css={iconBtnCss}
                          onClick={() => removePair("set", i)}
                          aria-label={t("qbRemove")}
                          disabled={setPairs.length <= 1}
                        >
                          <Icon name="close" size={ICON_SIZES.sm} />
                        </chakra.button>
                      </Tooltip>
                    </Box>
                    {notNullWarning && (
                      <chakra.span css={inlineWarningCss}>{t("qbNotNullWarning")}</chakra.span>
                    )}
                  </Box>
                );
              })}
            </chakra.section>
          )}

          {showInsertValues && (
            <chakra.section css={sectionCss}>
              <Box css={sectionRowCss}>
                <Box css={sectionTitleCss}>{t("qbInsertValues")}</Box>
                <chakra.button type="button" css={smallBtnCss} onClick={() => addPair("insert")}>
                  + {t("qbAddValue")}
                </chakra.button>
              </Box>
              {insertPairs.map((p, i) => {
                const info = resolveColumnInfo(tableColumns, p.column);
                const notNullWarning = isNullValueOnNotNullColumn(p.value, info);
                return (
                  <Box css={stackedRowCss} key={`ins-${i}`}>
                    <Box css={rowCss}>
                      <ColumnPicker
                        value={p.column}
                        options={columnOptions}
                        onChange={(v) => updatePair("insert", i, { column: v })}
                        placeholder={t("qbColumn")}
                      />
                      <chakra.span css={eqCss}>=</chakra.span>
                      <ValueControl
                        value={p.value}
                        onChange={(v) => updatePair("insert", i, { value: v })}
                        columnInfo={info}
                        placeholder={t("qbValue")}
                        t={t}
                      />
                      <Tooltip label={t("qbRemove")} focusableWrapper={insertPairs.length <= 1}>
                        <chakra.button
                          type="button"
                          css={iconBtnCss}
                          onClick={() => removePair("insert", i)}
                          aria-label={t("qbRemove")}
                          disabled={insertPairs.length <= 1}
                        >
                          <Icon name="close" size={ICON_SIZES.sm} />
                        </chakra.button>
                      </Tooltip>
                    </Box>
                    {notNullWarning && (
                      <chakra.span css={inlineWarningCss}>{t("qbNotNullWarning")}</chakra.span>
                    )}
                  </Box>
                );
              })}
            </chakra.section>
          )}

          {showWhere && (
            <chakra.section css={sectionCss}>
              <Box css={sectionRowCss}>
                <chakra.label css={{ ...checkboxLabelCss, ...sectionTitleCss }}>
                  <Checkbox
                    checked={whereEnabled}
                    w="auto"
                    m={0}
                    onChange={(e) => setWhereEnabled(e.target.checked)}
                    aria-label={t("qbWhereToggle")}
                  />
                  <chakra.span>{t("qbWhere")}</chakra.span>
                </chakra.label>
                {whereEnabled && (
                  <chakra.button type="button" css={smallBtnCss} onClick={addCondition}>
                    + {t("qbAddCondition")}
                  </chakra.button>
                )}
              </Box>
              {whereEnabled && whereConditions.map((c, i) => {
                const info = resolveColumnInfo(tableColumns, c.column);
                const nullOp = isNullOperator(c.operator);
                // IN takes a comma-separated list, which the boolean Select /
                // date "now" button can't represent, so it keeps the plain
                // free-text box regardless of the column's type. The two
                // "IS [NOT] NULL" operators need no value at all.
                const isIn = normalizeOperator(c.operator) === "IN";
                const notNullWarning = !nullOp && isNullValueOnNotNullColumn(c.value, info);
                return (
                  <Box css={stackedRowCss} key={`w-${i}`}>
                    <Box css={rowCss}>
                      <ColumnPicker
                        value={c.column}
                        options={columnOptions}
                        onChange={(v) => updateCondition(i, { column: v })}
                        placeholder={t("qbColumn")}
                      />
                      <ComboBox
                        css={opCss}
                        value={c.operator}
                        options={[...WHERE_OPERATORS]}
                        onChange={(v) => updateCondition(i, { operator: v })}
                      />
                      {nullOp || isIn ? (
                        <chakra.input
                          css={rowInputCss}
                          value={c.value}
                          placeholder={nullOp ? "—" : t("qbValuesPlaceholder")}
                          disabled={nullOp}
                          onChange={(e) => updateCondition(i, { value: e.target.value })}
                        />
                      ) : (
                        <ValueControl
                          value={c.value}
                          onChange={(v) => updateCondition(i, { value: v })}
                          columnInfo={info}
                          placeholder={t("qbValue")}
                          t={t}
                        />
                      )}
                      <Tooltip label={t("qbRemove")} focusableWrapper={whereConditions.length <= 1}>
                        <chakra.button
                          type="button"
                          css={iconBtnCss}
                          onClick={() => removeCondition(i)}
                          aria-label={t("qbRemove")}
                          disabled={whereConditions.length <= 1}
                        >
                          <Icon name="close" size={ICON_SIZES.sm} />
                        </chakra.button>
                      </Tooltip>
                    </Box>
                    {notNullWarning && (
                      <chakra.span css={inlineWarningCss}>{t("qbNotNullWarning")}</chakra.span>
                    )}
                  </Box>
                );
              })}
            </chakra.section>
          )}

          {showLimit && (
            <chakra.section css={limitSectionCss}>
              <chakra.label css={{ ...checkboxLabelCss, m: 0 }}>
                <Checkbox
                  checked={limitEnabled}
                  w="auto"
                  m={0}
                  onChange={(e) => setLimitEnabled(e.target.checked)}
                  aria-label={t("qbLimitToggle")}
                />
                <chakra.span>{t("qbLimit")}</chakra.span>
              </chakra.label>
              <Box css={stackedRowCss}>
                <chakra.input
                  id="qb-limit"
                  css={limitInputCss}
                  value={limit}
                  placeholder="100"
                  disabled={!limitEnabled}
                  onChange={(e) => setLimit(e.target.value)}
                  inputMode="numeric"
                />
                {limitInvalid && (
                  <chakra.span css={inlineWarningCss}>{t("qbLimitInvalid")}</chakra.span>
                )}
              </Box>
            </chakra.section>
          )}

          {noWhereBand && <Box css={noWhereBandCss}>{t("qbNoWhereBand")}</Box>}

          <chakra.section css={sectionCss}>
            <Box css={sectionTitleCss}>{t("qbPreview")}</Box>
            <Box css={previewWrapCss}>
              <Tooltip label={copied ? t("qbCopied") : t("qbCopy")}>
                <chakra.button
                  type="button"
                  css={previewCopyCss}
                  onClick={handleCopy}
                  aria-label={copied ? t("qbCopied") : t("qbCopy")}
                >
                {copied ? (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M3 8.5l3 3 7-7" />
                  </svg>
                ) : (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <rect x="5" y="5" width="9" height="9" rx="1.5" />
                    <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-5A1.5 1.5 0 0 0 3 3.5v5A1.5 1.5 0 0 0 4.5 10H6" />
                  </svg>
                )}
                </chakra.button>
              </Tooltip>
              <SqlPreview sql={sql} driver={driver} />
            </Box>
          </chakra.section>
        </Box>
      </ModalBody>

      <ModalFooter>
        <Box flex={1} />
        {onPreview && kind !== "SELECT" && (
          // 改善 2-1: プレースホルダが残る未完成の SQL は Dry Run も無効化する
          // (`runBlockedByReadOnly` 節と同じ「無効ボタン + focusableWrapper」パターン)。
          <Tooltip
            label={blockedReason ? t(blockedReason) : t("editorPreviewTitle")}
            focusableWrapper={dryRunDisabled}
          >
            <Button variant="warning" onClick={handlePreview} disabled={dryRunDisabled}>
              <chakra.span display="inline-flex" flexShrink={0} aria-hidden>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1.5 8s2.5-5 6.5-5 6.5 5 6.5 5-2.5 5-6.5 5S1.5 8 1.5 8z" />
                  <circle cx="8" cy="8" r="2" />
                </svg>
              </chakra.span>
              {t("qbPreviewRun")}
            </Button>
          </Tooltip>
        )}
        {/* 実行はエディタの Run / 他モーダルの Execute と同じ「主要アクション =
            primary (アクセント色)」に統一する。success はセル編集 Apply などの
            DB 書き込み確定に限定する (theme.ts の variant 規約)。 */}
        <Tooltip
          label={
            runBlockedByReadOnly
              ? t("qbExecuteReadOnlyTitle")
              : blockedReason
                ? t(blockedReason)
                : undefined
          }
          focusableWrapper={runDisabled}
        >
          <Button variant="primary" onClick={handleExecute} disabled={runDisabled}>
            <chakra.span display="inline-flex" flexShrink={0} aria-hidden>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M4 3.5v9a.5.5 0 0 0 .77.42l7-4.5a.5.5 0 0 0 0-.84l-7-4.5A.5.5 0 0 0 4 3.5z" />
              </svg>
            </chakra.span>
            {t("qbExecute")}
          </Button>
        </Tooltip>
      </ModalFooter>
    </Modal>
  );
}

interface ValueControlProps {
  value: string;
  onChange: (v: string) => void;
  /** The resolved column metadata, or `undefined` for a free-typed column
   *  name absent from `describeTable` (falls back to a plain text input). */
  columnInfo: TableColumnInfo | undefined;
  disabled?: boolean;
  placeholder?: string;
  t: ReturnType<typeof useT>;
}

/**
 * 改善 1 の型対応の値入力。カラムの型 (`classifyEditType`) に応じて:
 *   - boolean → true/false/NULL を選ぶ `Select` (自由入力を廃し誤入力を防ぐ)
 *   - date/time/datetime → テキスト入力 + 「現在日時」ボタン
 *     (`quickSetValues.ts` の "now" ショートカットと同じ思想 — クリック時点の
 *     時計で値を埋める。フォーマットも同モジュールの `resolveDynamicValue` を
 *     再利用するので型ごとに正しい桁数になる)
 *   - それ以外 (number/string/other、カラム情報が無い自由入力欄含む) →
 *     従来どおりのプレーンなテキスト入力
 *
 * NOT NULL 警告は呼び出し側 (WHERE/SET/INSERT の各行) が
 * `isNullValueOnNotNullColumn` で判定し、この行の外側に表示する — 複数の
 * 呼び出し元で同じ位置に出したいのと、値そのものの入力 UI とは関心事が
 * 別なため。
 */
function ValueControl({ value, onChange, columnInfo, disabled, placeholder, t }: ValueControlProps) {
  const kind: EditTypeKind = columnInfo ? classifyEditType(columnInfo.data_type) : "other";

  if (kind === "boolean") {
    return (
      <Select
        css={rowInputCss}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{placeholder ?? t("qbValue")}</option>
        <option value="true">{t("qbBoolTrue")}</option>
        <option value="false">{t("qbBoolFalse")}</option>
        <option value="NULL">{t("qbBoolNull")}</option>
      </Select>
    );
  }

  const dynamic: QuickSetDynamic | null =
    kind === "date" || kind === "time" || kind === "datetime" ? kind : null;

  if (!dynamic) {
    return (
      <chakra.input
        css={rowInputCss}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  return (
    <Box css={valueWithButtonCss}>
      <chakra.input
        css={rowInputCss}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      <Tooltip label={t("qbSetNow")}>
        <chakra.button
          type="button"
          css={iconBtnCss}
          disabled={disabled}
          onClick={() => onChange(resolveDynamicValue(dynamic, new Date()))}
          aria-label={t("qbSetNow")}
        >
          <Icon name="clock" size={ICON_SIZES.sm} />
        </chakra.button>
      </Tooltip>
    </Box>
  );
}

interface ColumnPickerProps {
  value: string;
  options: string[];
  onChange: (v: string) => void;
  placeholder?: string;
}

function ColumnPicker({ value, options, onChange, placeholder }: ColumnPickerProps) {
  return (
    <ComboBox
      css={rowInputCss}
      value={value}
      options={options}
      placeholder={placeholder}
      onChange={onChange}
    />
  );
}

interface ComboBoxProps {
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
  placeholder?: string;
  css?: SystemStyleObject;
  disabled?: boolean;
  id?: string;
  onEnter?: () => void;
}

function ComboBox({
  value,
  options,
  onChange,
  placeholder,
  css,
  disabled,
  id,
  onEnter,
}: ComboBoxProps) {
  const listId = useId();
  return (
    <>
      <chakra.input
        id={id}
        css={css}
        list={listId}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && onEnter) {
            e.preventDefault();
            onEnter();
          }
        }}
      />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </>
  );
}

interface SqlPreviewProps {
  sql: string;
  driver: string;
}

function SqlPreview({ sql, driver }: SqlPreviewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: sql,
        extensions: [
          EditorView.editable.of(false),
          EditorState.readOnly.of(true),
          syntaxHighlighting(qbHighlightStyle, { fallback: true }),
          sqlLang({ dialect: codeMirrorSqlDialectFor(driver), upperCaseKeywords: true }),
          EditorView.lineWrapping,
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [driver]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === sql) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: sql } });
  }, [sql]);

  return <Box css={previewCss} ref={hostRef} />;
}
