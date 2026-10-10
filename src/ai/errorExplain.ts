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
  String.raw`\b(?:FROM|JOIN|UPDATE|(?:INSERT(?:\s+(?:LOW_PRIORITY|DELAYED|HIGH_PRIORITY|IGNORE|OR\s+\w+))*|REPLACE)\s+INTO|DELETE\s+FROM)\s+(${IDENT}(?:\s*\.\s*${IDENT})?)`,
  "gi",
);

/** FROM / UPDATE を含むが表名を取らない構文 (誤検出の元) を空白に潰す。 */
const NON_TABLE_PATTERNS: RegExp[] = [
  /\b(?:EXTRACT|TRIM|SUBSTRING|OVERLAY)\s*\([^()]*\)/gi,
  /\bDISTINCT\s+FROM\b/gi,
  /\bDUPLICATE\s+KEY\s+UPDATE\b/gi,
  /\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b/gi,
  /\bDO\s+UPDATE\b/gi,
];

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
  let masked = maskLiterals(sql, driver ?? undefined, { keepQuotedIdentifiers: true, cache: false });
  for (const re of NON_TABLE_PATTERNS) masked = masked.replace(re, (m) => " ".repeat(m.length));
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

/** テーブル定義を引くデータベース名。SQLite で未指定なら `main`。引けなければ null。 */
export function resolveTableDatabase(
  ref: TableRef,
  fallbackDatabase: string | null,
  driver: string,
): string | null {
  return ref.database ?? fallbackDatabase ?? (driver === "sqlite" ? "main" : null);
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

/** SQL 中の文字列リテラル (`'...'`) の中身を集める。 */
export function literalContents(sql: string): string[] {
  const out: string[] = [];
  for (const m of sql.matchAll(/'((?:[^'\\]|\\.|'')*)'/g)) {
    if (m[1].length >= 2) out.push(m[1].replace(/''/g, "'"));
  }
  return out;
}

/**
 * エラー文に含まれるセル値を伏せる。(a) 元 SQL の文字列リテラルの中身と一致する部分を
 * `'…'` に、(b) 既知パターン (Duplicate entry / Incorrect ... value / `(col)=(値)` /
 * Failing row contains) の値部分を `…` にする。`Unknown column 'nme'` のような識別子は残す。
 */
export function maskErrorMessage(message: string, sql: string): string {
  let out = message;
  const lits = [...new Set(literalContents(sql))].sort((a, b) => b.length - a.length);
  for (const lit of lits) {
    // 語の途中 (`user_id` の `user` など) には一致させない。
    const re = new RegExp(`(?<![\\w])${lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`, "g");
    out = out.replace(re, "…");
  }
  out = out.replace(/(Duplicate entry )'(?:[^']|'')*'/gi, "$1'…'");
  out = out.replace(/(Incorrect [\w ]+? value: )'(?:[^']|'')*'/gi, "$1'…'");
  out = out.replace(/\(([^()]*)\)=\(([^()]*)\)/g, "($1)=(…)");
  out = out.replace(/(for type \w+: )"(?:[^"]|"")*"/gi, '$1"…"');
  out = out.replace(/(Failing row contains )\([^)]*\)/gi, "$1(…)");
  return out;
}

/**
 * エディタ本文 `text` の中で、失敗した SQL `failed` が**ちょうど 1 箇所**見つかったときだけ
 * その範囲を返す。0 件・複数件は null (呼び出し側が全文置換を確認する)。
 * 末尾の空白と `;` は無視して探す。一致の直前は「文頭 / 空白 / `;`」、直後は
 * 「文末 / 空白 / `;`」のものだけを数える (`user` が `user_list` に一致しないように)。
 */
export function findSqlRange(text: string, failed: string): { from: number; to: number } | null {
  const needle = failed.trim().replace(/;+\s*$/, "").trim();
  if (needle === "") return null;
  const isBoundary = (ch: string | undefined) => ch === undefined || ch === ";" || /\s/.test(ch);
  let found: { from: number; to: number } | null = null;
  let from = text.indexOf(needle);
  while (from >= 0) {
    const to = from + needle.length;
    if (isBoundary(text[from - 1]) && isBoundary(text[to])) {
      if (found) return null;
      found = { from, to };
    }
    from = text.indexOf(needle, from + 1);
  }
  return found;
}

/** 範囲置換で挿入する SQL。元の文の後ろに `;` が残るので、末尾の `;` を落として `;;` を避ける。 */
export function sqlForRangeReplace(newSql: string): string {
  return newSql.trim().replace(/;+\s*$/, "");
}

/**
 * エディタの末尾へ文を 1 つ追記するための差分。`doc.slice(0, from) + text` が新しい本文になる。
 * 既存本文の最後の文 (コメント・空白を除いた末尾) が `;` で終わっていなければ、その直後に `;` を補う
 * (行コメントの後ろに足すと `;` ごとコメントになるため、コメントの手前に置く)。追記する SQL も `;` で終える。
 * `sqlScript.ts` は `;` だけで文を区切るので、これが無いと前の文とつながって 1 文になる。
 */
export function sqlForAppend(doc: string, newSql: string): { from: number; text: string } {
  const stmt = `${newSql.trim().replace(/;+\s*$/, "")};`;
  const masked = maskLiterals(doc);
  const lastIdx = masked.trimEnd().length - 1;
  if (lastIdx < 0) return { from: doc.length, text: doc.trim() === "" ? stmt : `\n\n${stmt}` };
  if (masked[lastIdx] === ";") return { from: doc.length, text: `\n\n${stmt}` };
  return { from: lastIdx + 1, text: `;${doc.slice(lastIdx + 1)}\n\n${stmt}` };
}

/** 送信範囲が「スキーマ情報のみ」のとき、SQL 本文を送る前に毎回確認が要る。 */
export function needsSendScopeConfirm(sendScope: string): boolean {
  return sendScope !== "schemaAndSql";
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
  lines.push(input.maskLiterals ? maskErrorMessage(input.message, input.sql) : input.message);
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
