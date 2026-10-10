// 自然言語 → SQL 生成 (NL2SQL, #691) の純ロジック: スキーマのテキスト化・プロンプト組み立て・応答パース。
// 副作用 (IPC・状態管理) は `components/AiQueryModal.tsx` が持つ。
// 送るのはテーブル名・列名・外部キーと依頼文だけ。行データ・サンプル値・既存の SQL 本文は送らない。

import { z } from "zod";
import { dialectLabel } from "./errorExplain";

/** この件数を超えるスキーマは、送信前にテーブル数と送信サイズの目安をモーダルに出す。 */
export const NL2SQL_LARGE_SCHEMA_TABLES = 300;

/** 構造化出力で受け取る応答の形 (`run_ai_request` の `format` にそのまま渡す)。 */
export const NL2SQL_FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      sql: { type: "string" },
      explanation: { type: "string" },
      warnings: { type: "array", items: { type: "string" } },
      tables_used: { type: "array", items: { type: "string" } },
    },
    required: ["sql", "explanation", "warnings", "tables_used"],
    additionalProperties: false,
  },
} as const;

const responseSchema = z.object({
  sql: z.string(),
  explanation: z.string(),
  warnings: z.array(z.string()),
  tables_used: z.array(z.string()),
});
export type Nl2SqlResponse = z.infer<typeof responseSchema>;

export type ParsedNl2Sql = { ok: true; value: Nl2SqlResponse } | { ok: false; raw: string };

/** ストリームで結合した本文を JSON として解釈する。失敗時・SQL が空のときは本文をそのまま返す。 */
export function parseNl2SqlResponse(text: string): ParsedNl2Sql {
  let body = text.trim();
  // 念のためコードフェンスで囲まれていても受け付ける。
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(body);
  if (fenced) body = fenced[1];
  try {
    const parsed = responseSchema.safeParse(JSON.parse(body));
    if (parsed.success) {
      const sql = parsed.data.sql.trim();
      if (sql !== "") return { ok: true, value: { ...parsed.data, sql } };
    }
  } catch {
    /* JSON でない */
  }
  return { ok: false, raw: text };
}

export interface Nl2SqlTable {
  name: string;
  columns: string[];
}

export interface Nl2SqlForeignKey {
  table: string;
  column: string;
  referenced_table: string;
  referenced_column: string | null;
}

/** 方言ごとの識別子クオート規則 (プロンプトに明記する)。 */
const QUOTE_RULES: Record<string, string> = {
  mysql:
    "Quote identifiers with backticks (`name`). String literals use single quotes. Use LIMIT for row limits and CURDATE()/DATE_SUB() style date functions.",
  postgres:
    'Quote identifiers with double quotes ("name") only when needed (mixed case or reserved words). String literals use single quotes. Use LIMIT/OFFSET and date_trunc()/INTERVAL style date functions.',
  sqlite:
    'Quote identifiers with double quotes ("name") (backticks and [brackets] are also accepted but prefer double quotes). String literals use single quotes. Use LIMIT for row limits and date()/strftime() for dates; there is no schema prefix other than "main".',
};

/** 方言名に続けて渡す識別子クオート規則。未知のドライバは二重引用符規則に倒す。 */
export function identifierQuoteRule(driver: string): string {
  return QUOTE_RULES[driver] ?? QUOTE_RULES.sqlite;
}

export interface Nl2SqlSystemInput {
  /** `mysql` / `postgres` / `sqlite`。 */
  driver: string;
  /** 接続先のデータベース (スキーマ)。 */
  database: string | null;
  locale: "ja" | "en";
  /** 読み取り専用セッションなら true。SELECT 系のみ生成させる。 */
  readOnly: boolean;
  tables: Nl2SqlTable[];
  foreignKeys: Nl2SqlForeignKey[];
}

/** スキーマ部分のテキスト。テーブルごとに 1 行 + 外部キー一覧。行データは含まない。 */
export function buildSchemaText(tables: Nl2SqlTable[], foreignKeys: Nl2SqlForeignKey[]): string {
  const lines: string[] = [];
  for (const t of tables) {
    lines.push(`- ${t.name}(${t.columns.join(", ")})`);
  }
  if (foreignKeys.length > 0) {
    lines.push("");
    lines.push("Foreign keys:");
    for (const fk of foreignKeys) {
      lines.push(`- ${fk.table}.${fk.column} -> ${fk.referenced_table}.${fk.referenced_column ?? "?"}`);
    }
  }
  return lines.join("\n");
}

/** system プロンプトを「同じ DB なら毎回同じ固定部分」と「毎回変わりうる部分」に分けたもの (#1473)。 */
export interface Nl2SqlSystemParts {
  /** 方言・規則・スキーマ。プロンプトキャッシュの対象にする (`systemCached`)。 */
  cached: string;
  /** 固定部分の後ろに足す可変部分 (今は無く、空文字)。 */
  variable: string;
}

/**
 * system プロンプトの固定部分と可変部分。スキーマは大きく同じ DB で何度も送られるので
 * 固定部分に置く。キャッシュは先頭からの一致なので、変わりうるものは `variable` に出す。
 */
export function buildNl2SqlSystemParts(input: Nl2SqlSystemInput): Nl2SqlSystemParts {
  const lang = input.locale === "ja" ? "Japanese" : "English";
  const dialect = dialectLabel(input.driver);
  const lines = [
    `You are a ${dialect} expert who writes SQL from natural-language requests.`,
    `Target dialect: ${dialect}. Generate exactly one SQL statement valid for ${dialect}.`,
    `Identifier rules: ${identifierQuoteRule(input.driver)}`,
    `Write the explanation and warnings in ${lang}.`,
    "Answer only with the JSON object described by the schema.",
    "sql: the complete statement without markdown. explanation: what the statement does, briefly.",
    "warnings: caveats (ambiguous request, assumptions, heavy scans, data-changing effects); an empty array when none.",
    "tables_used: the table names the statement reads or changes.",
    "Use only tables and columns listed below; never invent names. If the request cannot be answered with them, return the closest valid SELECT in sql and explain the gap in warnings.",
    "You are given only the schema. Never assume row contents or literal values; use placeholders or ask for them in warnings.",
  ];
  if (input.readOnly) {
    lines.push(
      "This connection is READ-ONLY. Generate only a read-only query (SELECT / WITH ... SELECT / EXPLAIN). Never generate INSERT, UPDATE, DELETE, DDL or any statement that changes data or schema; if the request asks for a change, return a SELECT that previews the affected rows and say so in warnings.",
    );
  }
  lines.push("");
  lines.push(input.database ? `Database: ${input.database}` : "Database: (default)");
  lines.push("Tables (name(columns)):");
  lines.push(buildSchemaText(input.tables, input.foreignKeys));
  return { cached: lines.join("\n"), variable: "" };
}

/** system プロンプト全体 (固定部分 + 可変部分)。分けて送れない呼び出し側向け。 */
export function buildNl2SqlSystem(input: Nl2SqlSystemInput): string {
  const { cached, variable } = buildNl2SqlSystemParts(input);
  return variable ? `${cached}\n\n${variable}` : cached;
}

/** ユーザプロンプト = 依頼文そのもの (SQL 本文・行データは含めない)。 */
export function buildNl2SqlPrompt(request: string): string {
  return request.trim();
}

export interface SchemaSendSummary {
  tableCount: number;
  columnCount: number;
  /** 送信する system プロンプトの概算サイズ (文字数)。 */
  approxChars: number;
  /** 大きいスキーマとして送信前に件数を見せるか。 */
  large: boolean;
}

/** 送信前にモーダルへ見せる、スキーマの件数と送信サイズの目安。 */
export function summarizeSchemaSend(
  tables: Nl2SqlTable[],
  foreignKeys: Nl2SqlForeignKey[],
): SchemaSendSummary {
  return {
    tableCount: tables.length,
    columnCount: tables.reduce((n, t) => n + t.columns.length, 0),
    approxChars: buildSchemaText(tables, foreignKeys).length,
    large: tables.length > NL2SQL_LARGE_SCHEMA_TABLES,
  };
}

/** 文字数を「約 N KB」表示用の数値 (切り上げ、最小 1) にする。 */
export function approxKb(chars: number): number {
  return Math.max(1, Math.ceil(chars / 1024));
}

/** 生成を依頼するデータベース名。SQLite で未指定なら `main`、それ以外で無ければ null。 */
export function resolveNl2SqlDatabase(database: string | null | undefined, driver: string): string | null {
  return database || (driver === "sqlite" ? "main" : null);
}
