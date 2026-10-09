// EXPLAIN 実行計画の AI 解釈 (#693) の純ロジック: プロンプト組み立て・応答パース。
// 副作用 (IPC・状態管理) は `components/AiExplainInterpret.tsx` が持つ。
// テーブル名抽出・リテラルマスク・送信範囲の判定は #692 (`errorExplain.ts`) を流用する。

import { z } from "zod";
import { dialectLabel, sqlForAi } from "./errorExplain";

/** プロンプトに含める実行計画本文の上限 (巨大な JSON でトークンが膨らむのを防ぐ)。 */
export const EXPLAIN_INTERPRET_MAX_PLAN_CHARS = 24000;

/** 提案 1 件あたりの SQL 種別。 */
export const SUGGESTION_KINDS = ["ddl", "rewrite"] as const;

/** 構造化出力で受け取る応答の形 (`run_ai_request` の `format` にそのまま渡す)。 */
export const EXPLAIN_INTERPRET_FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      summary: { type: "string" },
      bottlenecks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            node: { type: "string" },
            reason: { type: "string" },
            severity: { type: "string", enum: ["high", "medium", "low"] },
          },
          required: ["node", "reason", "severity"],
          additionalProperties: false,
        },
      },
      suggestions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["ddl", "rewrite"] },
            sql: { type: "string" },
            rationale: { type: "string" },
          },
          required: ["kind", "sql", "rationale"],
          additionalProperties: false,
        },
      },
    },
    required: ["summary", "bottlenecks", "suggestions"],
    additionalProperties: false,
  },
} as const;

const responseSchema = z.object({
  summary: z.string(),
  bottlenecks: z.array(
    z.object({
      node: z.string(),
      reason: z.string(),
      severity: z.enum(["high", "medium", "low"]),
    }),
  ),
  suggestions: z.array(
    z.object({
      kind: z.enum(SUGGESTION_KINDS),
      sql: z.string(),
      rationale: z.string(),
    }),
  ),
});
export type ExplainInterpretResponse = z.infer<typeof responseSchema>;

export type ParsedExplainInterpret =
  | { ok: true; value: ExplainInterpretResponse }
  | { ok: false; raw: string };

/** ストリームで結合した本文を JSON として解釈する。失敗時は本文をそのまま返す。 */
export function parseExplainInterpretResponse(text: string): ParsedExplainInterpret {
  let body = text.trim();
  // 念のためコードフェンスで囲まれていても受け付ける。
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(body);
  if (fenced) body = fenced[1];
  try {
    const parsed = responseSchema.safeParse(JSON.parse(body));
    if (parsed.success) {
      // 空の SQL 提案は挿入できないので落とす。
      const suggestions = parsed.data.suggestions
        .map((s) => ({ ...s, sql: s.sql.trim() }))
        .filter((s) => s.sql !== "");
      return { ok: true, value: { ...parsed.data, suggestions } };
    }
  } catch {
    /* JSON でない */
  }
  return { ok: false, raw: text };
}

/**
 * 実行計画の生テキストからリテラルを伏せる。MySQL の `attached_condition` や
 * PostgreSQL の `Filter` / `Index Cond` には WHERE 句の値 (`'alice'`) がそのまま入るため、
 * 元 SQL と同じく `ai.maskLiterals` が有効なら単引用符リテラルの中身を空にして送る。
 */
export function maskPlanLiterals(plan: string): string {
  // JSON の計画 (MySQL 非実測 / PostgreSQL) はデコードした文字列値ごとにマスクする。
  // 生テキストのまま正規表現を当てると、MySQL が `\'` と出力する値 (JSON 上は `\\'`) の
  // エスケープ解釈がずれ、後ろの値が残ってしまう。
  try {
    return JSON.stringify(maskJsonStrings(JSON.parse(plan)));
  } catch {
    /* JSON でない (テキストツリー・切り詰め後) */
  }
  return maskLiteralsInText(plan);
}

function maskLiteralsInText(text: string): string {
  return text.replace(/'(?:[^'\\]|\\.|'')*'/g, "''");
}

function maskJsonStrings(v: unknown): unknown {
  if (typeof v === "string") return maskLiteralsInText(v);
  if (Array.isArray(v)) return v.map(maskJsonStrings);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskJsonStrings(x)]));
  }
  return v;
}

/** 実行計画を送信用に整える (リテラルのマスクと長さ制限)。 */
export function planForAi(plan: string, mask: boolean): string {
  const body = mask ? maskPlanLiterals(plan) : plan;
  if (body.length <= EXPLAIN_INTERPRET_MAX_PLAN_CHARS) return body;
  return `${body.slice(0, EXPLAIN_INTERPRET_MAX_PLAN_CHARS)}\n... (truncated)`;
}

/** 方言ごとの EXPLAIN 出力形式の説明 (プロンプトに載せる)。 */
export function explainFormatLabel(driver: string, analyze: boolean): string {
  if (driver === "postgres") {
    return analyze
      ? "PostgreSQL EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) plan, with measured rows and timings"
      : "PostgreSQL EXPLAIN (FORMAT JSON) plan, estimates only";
  }
  if (driver === "sqlite") {
    return "SQLite EXPLAIN QUERY PLAN output, one plan step per line (detail column only)";
  }
  return analyze
    ? "MySQL EXPLAIN ANALYZE text tree, with measured rows and timings"
    : "MySQL EXPLAIN FORMAT=JSON plan, estimates only";
}

export interface ExplainIndex {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  method: string | null;
}

export interface ExplainInterpretTable {
  name: string;
  /** 統計ベースの行数推定。取得できない (SQLite・統計なし) ときは null。 */
  rowEstimate: number | null;
  indexes: ExplainIndex[];
}

export interface ExplainInterpretInput {
  /** `mysql` / `postgres` / `sqlite`。 */
  driver: string;
  /** EXPLAIN 出力の生テキスト (MySQL/PostgreSQL は JSON、SQLite は plan 行)。 */
  plan: string;
  /** 実測モード (EXPLAIN ANALYZE) の出力か。 */
  analyze: boolean;
  /** 元の SQL (EXPLAIN プレフィックスなし)。 */
  sql: string;
  tables: ExplainInterpretTable[];
  /** 設定 `ai.maskLiterals`。true なら SQL と計画内のリテラルを潰して送る。 */
  maskLiterals: boolean;
}

export function buildExplainInterpretSystem(locale: "ja" | "en", driver: string): string {
  const lang = locale === "ja" ? "Japanese" : "English";
  return [
    `You are a ${dialectLabel(driver)} performance expert interpreting a query execution plan.`,
    `Write all text fields in ${lang}.`,
    "Answer only with the JSON object described by the schema.",
    "summary: what the plan does and how heavy it is, in plain words.",
    "bottlenecks: the problematic plan nodes (full scans, large intermediate results, poor join order, filesort/temp tables). node names the plan step; severity is high, medium or low. An empty array when the plan is fine.",
    "suggestions: concrete improvements. kind \"ddl\" = a CREATE INDEX style statement, kind \"rewrite\" = a rewritten query. Each sql is a single complete statement valid for the given dialect; rationale explains the expected effect and any cost (write overhead, size).",
    "Take the existing indexes and row estimates into account and do not propose an index that already exists.",
    "Literal values in the SQL and plan may be blanked out for privacy; never invent data values.",
  ].join("\n");
}

/** ユーザプロンプトを組み立てる。行データは含めない (計画・SQL・スキーマ情報のみ)。 */
export function buildExplainInterpretPrompt(input: ExplainInterpretInput): string {
  const lines: string[] = [];
  lines.push(`Dialect: ${dialectLabel(input.driver)}`);
  lines.push(`Plan format: ${explainFormatLabel(input.driver, input.analyze)}`);
  lines.push("");
  lines.push(input.maskLiterals ? "SQL (string literals and comments are blanked):" : "SQL:");
  lines.push(sqlForAi(input.sql, input.driver, input.maskLiterals));
  lines.push("");
  lines.push(input.maskLiterals ? "Execution plan (string literals are blanked):" : "Execution plan:");
  lines.push(planForAi(input.plan, input.maskLiterals));
  if (input.tables.length > 0) {
    lines.push("");
    lines.push("Tables referenced by the SQL:");
    for (const t of input.tables) {
      lines.push(`- ${t.name} (estimated rows: ${t.rowEstimate === null ? "unknown" : t.rowEstimate})`);
      if (t.indexes.length === 0) {
        lines.push("    indexes: none");
        continue;
      }
      for (const ix of t.indexes) {
        const flags = [ix.primary ? "primary" : "", ix.unique ? "unique" : "", ix.method ?? ""].filter(Boolean);
        lines.push(`    index ${ix.name} (${ix.columns.join(", ")})${flags.length > 0 ? ` [${flags.join(", ")}]` : ""}`);
      }
    }
  }
  return lines.join("\n");
}
