// データ品質アサーション候補の AI 提案 (#1477) の純ロジック: スキーマのテキスト化・プロンプト組み立て・
// 応答パース・読み取り専用判定・登録用ドラフトへの変換。副作用 (IPC・状態管理) は
// `components/AssertionSuggestModal.tsx` が持つ。
// 送るのはテーブルの列定義 (型・NULL 可・キー・既定値・コメント) と外部キーだけ。行データは扱わない。

import { z } from "zod";
import { isReadOnlySql } from "../dangerousSql";
import { emptyAssertionDraft, type AssertionDraft } from "../components/assertions";
import { dialectLabel } from "./errorExplain";
import { identifierQuoteRule } from "./nl2sql";

/** 1 回に受け取る候補の上限 (プロンプトで依頼し、パース時にも切る)。 */
export const ASSERTION_SUGGEST_MAX = 8;

/** 関連外部キーとしてプロンプトに載せる上限。 */
const MAX_FOREIGN_KEYS = 40;

/** 構造化出力で受け取る応答の形 (`run_ai_request` の `format` にそのまま渡す)。 */
export const ASSERTION_SUGGEST_FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      suggestions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            sql: { type: "string" },
          },
          required: ["name", "description", "sql"],
          additionalProperties: false,
        },
      },
    },
    required: ["suggestions"],
    additionalProperties: false,
  },
} as const;

const suggestionSchema = z.object({
  name: z.string(),
  description: z.string(),
  sql: z.string(),
});
const responseSchema = z.object({ suggestions: z.array(suggestionSchema) });

export type AssertionSuggestion = z.infer<typeof suggestionSchema>;

export type ParsedAssertionSuggest =
  | { ok: true; suggestions: AssertionSuggestion[] }
  | { ok: false; raw: string };

/**
 * ストリームで結合した本文を JSON として解釈する。失敗時は本文をそのまま返す。
 * SQL が空の候補は捨て、上限 (`ASSERTION_SUGGEST_MAX`) で切る。名前が空なら `check_N` を補う。
 */
export function parseAssertionSuggestResponse(text: string): ParsedAssertionSuggest {
  let body = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(body);
  if (fenced) body = fenced[1];
  try {
    const parsed = responseSchema.safeParse(JSON.parse(body));
    if (parsed.success) {
      const suggestions = parsed.data.suggestions
        .map((s) => ({ ...s, name: s.name.trim(), description: s.description.trim(), sql: s.sql.trim() }))
        .filter((s) => s.sql !== "")
        .slice(0, ASSERTION_SUGGEST_MAX)
        .map((s, i) => (s.name === "" ? { ...s, name: `check_${i + 1}` } : s));
      return { ok: true, suggestions };
    }
  } catch {
    /* JSON でない */
  }
  return { ok: false, raw: text };
}

/**
 * 登録してよい SQL か。フロント側の読み取り専用判定 (`isReadOnlySql`、Rust の
 * `is_read_only_sql_for` と共有ゴールデンベクタで揃えた二重実装) を通ること。
 * 空文は不可。バックエンドも保存時と SQL 生成時に同じ検査をする (多層防御)。
 */
export function isRegistrableSuggestionSql(sql: string, driver: string): boolean {
  // SHOW / EXPLAIN / TABLE などはサブクエリに包めないので、先頭は SELECT / WITH に限る (Rust と同じ)。
  return /^[\s(]*(select|with)\b/i.test(sql) && isReadOnlySql(sql, driver);
}

export interface AssertionSuggestColumn {
  name: string;
  data_type: string;
  nullable: boolean;
  key: string;
  default?: string | null;
  extra?: string;
  referenced_table: string | null;
  referenced_column: string | null;
  comment?: string | null;
}

export interface AssertionSuggestForeignKey {
  table: string;
  column: string;
  referenced_table: string;
  referenced_column: string | null;
}

export interface AssertionSuggestInput {
  /** `mysql` / `postgres` / `sqlite`。 */
  driver: string;
  /** スキーマを読んだデータベース。 */
  database: string | null;
  table: string;
  columns: AssertionSuggestColumn[];
  foreignKeys: AssertionSuggestForeignKey[];
  locale: "ja" | "en";
}

/** 対象テーブルが参照する / 参照される外部キーだけに絞る (大文字小文字は無視)。 */
export function selectTableForeignKeys<T extends AssertionSuggestForeignKey>(
  fks: readonly T[],
  table: string,
): T[] {
  const name = table.toLowerCase();
  return fks
    .filter((fk) => fk.table.toLowerCase() === name || fk.referenced_table.toLowerCase() === name)
    .slice(0, MAX_FOREIGN_KEYS);
}

function columnLine(c: AssertionSuggestColumn): string {
  const parts = [`${c.name} ${c.data_type}`, c.nullable ? "NULL" : "NOT NULL"];
  if (c.key) parts.push(`key=${c.key}`);
  if (c.default != null && c.default !== "") parts.push(`default=${c.default}`);
  if (c.extra) parts.push(c.extra);
  if (c.referenced_table) parts.push(`FK->${c.referenced_table}.${c.referenced_column ?? "?"}`);
  if (c.comment) parts.push(`comment: ${c.comment.replace(/\s+/g, " ").trim()}`);
  return `- ${parts.join(" | ")}`;
}

/** 対象テーブルのスキーマ文面。列ごとに 1 行 + 外部キー一覧。行データは含まない。 */
export function buildAssertionSuggestSchemaText(input: AssertionSuggestInput): string {
  const lines = [`Table: ${input.table}`, "Columns:", ...input.columns.map(columnLine)];
  if (input.foreignKeys.length > 0) {
    lines.push("", "Foreign keys (this table and related tables):");
    for (const fk of input.foreignKeys) {
      lines.push(`- ${fk.table}.${fk.column} -> ${fk.referenced_table}.${fk.referenced_column ?? "?"}`);
    }
  }
  return lines.join("\n");
}

/** system プロンプトを「同じテーブルなら毎回同じ固定部分」と「毎回変わりうる部分」に分ける (#1473)。 */
export function buildAssertionSuggestSystemParts(input: AssertionSuggestInput): {
  cached: string;
  variable: string;
} {
  const lang = input.locale === "ja" ? "Japanese" : "English";
  const cached = [
    "You are a data quality engineer proposing data quality assertions for one database table.",
    `Target dialect: ${dialectLabel(input.driver)}. ${identifierQuoteRule(input.driver)}`,
    "",
    "How an assertion works in this app:",
    "- Each assertion is ONE read-only SELECT statement that returns the VIOLATING rows.",
    "- The assertion passes when the statement returns 0 rows, and fails when it returns any row.",
    "- Example: 'amount must not be negative' is `SELECT * FROM orders WHERE amount < 0`.",
    "",
    "Hard rules for every sql field:",
    "- A single SELECT (or WITH ... SELECT) statement. No INSERT/UPDATE/DELETE/DDL, no locking clauses, no multiple statements, no trailing semicolon.",
    "- Use only tables and columns that appear in the schema below. Never invent names.",
    "- Do not use bind parameters or placeholders; write concrete SQL. Do not add LIMIT or ORDER BY.",
    "- Use syntax valid for the target dialect only.",
    "- The statement is wrapped as a subquery, so every returned column name must be unique. When joining tables, never use SELECT *; return only o.* (the checked table's alias) or its primary key columns. Example: `SELECT o.* FROM orders o LEFT JOIN users u ON u.id = o.user_id WHERE o.user_id IS NOT NULL AND u.id IS NULL`.",
    ...(input.driver === "sqlite"
      ? ["- SQLite has no REGEXP operator here; use LIKE or GLOB for pattern checks."]
      : []),
    "",
    "What to look for (propose only checks that make sense for the columns given):",
    "- Email-like columns whose values do not look like an email address.",
    "- Date/time pairs where the end is earlier than the start.",
    "- Amount, price, quantity, count columns that should not be negative.",
    "- Orphan rows: a foreign key (or a *_id column) whose target row does not exist.",
    "- NOT NULL expectations on columns that are nullable but look mandatory, duplicates on columns that look like natural keys, and status/enum columns with unexpected values.",
    "",
    `Return at most ${ASSERTION_SUGGEST_MAX} suggestions, most valuable first. Do not repeat what a constraint already guarantees (a declared NOT NULL column needs no NOT NULL check).`,
    `name: a short label. description: one or two sentences on what is checked and why. Write name and description in ${lang}; keep sql in plain SQL.`,
    "Answer only with the JSON object described by the schema.",
    "",
    "Schema (column definitions only; no row data is available):",
    buildAssertionSuggestSchemaText(input),
  ].join("\n");
  const variable = input.database ? `Database: ${input.database}` : "";
  return { cached, variable };
}

export function buildAssertionSuggestPrompt(table: string): string {
  return `Suggest data quality assertions for the table "${table}".`;
}

/**
 * 候補を保存用のドラフトに変換する。対象テーブルは候補生成時に選んだもの。
 * `draftToRequest` に渡せば既存のアサーションと同じ保存リクエストになる。
 */
export function suggestionToDraft(
  s: Pick<AssertionSuggestion, "name" | "sql">,
  table: string,
  schema: string | null,
): AssertionDraft {
  return {
    ...emptyAssertionDraft({ schema, table }),
    name: s.name,
    kind: "custom_sql",
    sql: s.sql,
  };
}
