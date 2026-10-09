// DB エラーの AI 解説 (#692) の純ロジック: テーブル名抽出・プロンプト組み立て・応答パース。
// 副作用 (IPC・状態管理) は `components/AiErrorExplain.tsx` が持つ。

import { z } from "zod";
import { maskLiterals } from "../dangerousSql";

/** 関連テーブルとして問い合わせる上限 (巨大な JOIN でプロンプトが膨らむのを防ぐ)。 */
export const ERROR_EXPLAIN_MAX_TABLES = 5;

/** 構造化出力で受け取る応答の形 (`run_ai_request` の `format` にそのまま渡す)。 */
export const ERROR_EXPLAIN_FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      explanation: { type: "string" },
      cause: { type: "string" },
      suggestedSql: { type: ["string", "null"] },
      notes: { type: "array", items: { type: "string" } },
    },
    required: ["explanation", "cause", "suggestedSql", "notes"],
    additionalProperties: false,
  },
} as const;

const responseSchema = z.object({
  explanation: z.string(),
  cause: z.string(),
  suggestedSql: z.string().nullable(),
  notes: z.array(z.string()),
});
export type ErrorExplainResponse = z.infer<typeof responseSchema>;

export type ParsedErrorExplain =
  | { ok: true; value: ErrorExplainResponse }
  | { ok: false; raw: string };

/** ストリームで結合した本文を JSON として解釈する。失敗時は本文をそのまま返す。 */
export function parseErrorExplainResponse(text: string): ParsedErrorExplain {
  let body = text.trim();
  // 念のためコードフェンスで囲まれていても受け付ける。
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(body);
  if (fenced) body = fenced[1];
  try {
    const parsed = responseSchema.safeParse(JSON.parse(body));
    if (parsed.success) {
      const sql = parsed.data.suggestedSql?.trim() ?? "";
      return { ok: true, value: { ...parsed.data, suggestedSql: sql === "" ? null : sql } };
    }
  } catch {
    /* JSON でない */
  }
  return { ok: false, raw: text };
}

export interface TableRef {
  database: string | null;
  table: string;
}

const IDENT = String.raw`(?:` + "`[^`]+`" + String.raw`|"[^"]+"|\[[^\]]+\]|[A-Za-z_][\w$]*)`;
const TABLE_RE = new RegExp(
  String.raw`\b(?:FROM|JOIN|UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+(${IDENT}(?:\s*\.\s*${IDENT})?)`,
  "gi",
);

function unquote(ident: string): string {
  const first = ident[0];
  if (first === "`" || first === '"') return ident.slice(1, -1);
  if (first === "[") return ident.slice(1, -1);
  return ident;
}

/**
 * SQL から関連テーブル名をベストエフォートで抽出する。コメント / リテラルは
 * `maskLiterals` で潰してから FROM / JOIN / UPDATE / INSERT INTO / DELETE FROM の
 * 直後の識別子 (`db.table` も可) を拾う。サブクエリ `(` や重複は除く。
 */
export function extractTableRefs(sql: string, driver?: string | null): TableRef[] {
  const masked = maskLiterals(sql, driver ?? undefined, { keepQuotedIdentifiers: true, cache: false });
  const seen = new Set<string>();
  const out: TableRef[] = [];
  for (const m of masked.matchAll(TABLE_RE)) {
    const parts = m[1].split(".").map((p) => unquote(p.trim()));
    const table = parts[parts.length - 1];
    const database = parts.length > 1 ? parts[parts.length - 2] : null;
    if (!table) continue;
    const key = `${database ?? ""}.${table}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ database, table });
    if (out.length >= ERROR_EXPLAIN_MAX_TABLES) break;
  }
  return out;
}

export interface ExplainColumn {
  name: string;
  data_type: string;
  nullable: boolean;
  key: string;
  referenced_table: string | null;
  referenced_column: string | null;
}

export interface ExplainTable {
  name: string;
  columns: ExplainColumn[];
}

export interface ErrorExplainInput {
  errorKind: string | null;
  message: string;
  sql: string;
  /** `mysql` / `postgres` / `sqlite`。 */
  driver: string;
  tables: ExplainTable[];
  /** 設定 `ai.maskLiterals`。true なら SQL 内のリテラルを潰して送る。 */
  maskLiterals: boolean;
  locale: "ja" | "en";
}

/** 送る SQL。マスク有効ならリテラルとコメントの中身を空白にする (識別子は残す)。 */
export function sqlForAi(sql: string, driver: string, mask: boolean): string {
  return mask ? maskLiterals(sql, driver, { keepQuotedIdentifiers: true, cache: false }) : sql;
}

const DIALECT_LABEL: Record<string, string> = {
  mysql: "MySQL",
  postgres: "PostgreSQL",
  sqlite: "SQLite",
};

export function dialectLabel(driver: string): string {
  return DIALECT_LABEL[driver] ?? driver;
}

export function buildErrorExplainSystem(locale: "ja" | "en"): string {
  const lang = locale === "ja" ? "Japanese" : "English";
  return [
    "You are a database expert helping a user understand and fix a SQL error.",
    `Write all text fields in ${lang}.`,
    "Answer only with the JSON object described by the schema.",
    "explanation: what the error means in plain words. cause: the most likely cause in the given SQL.",
    "suggestedSql: a corrected full SQL statement for the given dialect, or null when it cannot be determined.",
    "notes: short caveats (side effects, assumptions); an empty array when none.",
    "Literal values in the SQL may be blanked out for privacy; keep that in mind and never invent data values.",
  ].join("\n");
}

/** ユーザプロンプトを組み立てる。行データは含めない (スキーマ情報のみ)。 */
export function buildErrorExplainPrompt(input: ErrorExplainInput): string {
  const lines: string[] = [];
  lines.push(`Dialect: ${dialectLabel(input.driver)}`);
  lines.push(`Error kind: ${input.errorKind ?? "unknown"}`);
  lines.push("Error message:");
  lines.push(input.message);
  lines.push("");
  lines.push(
    input.maskLiterals
      ? "SQL (string literals and comments are blanked):"
      : "SQL:",
  );
  lines.push(sqlForAi(input.sql, input.driver, input.maskLiterals));
  if (input.tables.length > 0) {
    lines.push("");
    lines.push("Related tables:");
    for (const t of input.tables) {
      lines.push(`- ${t.name}`);
      for (const c of t.columns) {
        const flags = [
          c.key ? `key=${c.key}` : "",
          c.nullable ? "nullable" : "not null",
          c.referenced_table ? `-> ${c.referenced_table}.${c.referenced_column ?? "?"}` : "",
        ].filter(Boolean);
        lines.push(`    ${c.name} ${c.data_type} (${flags.join(", ")})`);
      }
    }
  }
  return lines.join("\n");
}
