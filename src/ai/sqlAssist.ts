// SQL の AI 解説 / 最適化リライト (#695) の純ロジック: スキーマ形式・プロンプト組み立て・応答パース・
// 行単位 diff・適用範囲の決定。副作用 (IPC・状態管理) は `components/AiSqlPanel.tsx` が持つ。
// 表名抽出・リテラルマスク・送信範囲の判定は #692 (`errorExplain.ts`) の実装を共有する。

import { z } from "zod";
import {
  dialectLabel,
  findSqlRange,
  sqlForAi,
  type ExplainTable,
} from "./errorExplain";

export type SqlAssistKind = "explain" | "rewrite";

/** エディタ (右クリック / パレット) からの起動依頼。選択範囲が無ければ `range` は null で全文が対象。 */
export interface AiSqlEditorAction {
  kind: SqlAssistKind;
  sql: string;
  range: { from: number; to: number } | null;
  tabId: string;
}

/** `aiModels.ts` の `AI_TASK_KINDS` に登録済みのタスク。モデル ID は直接渡さない。 */
export const SQL_ASSIST_TASK = { explain: "sqlExplain", rewrite: "sqlRewrite" } as const;

/** 構造化出力: 解説 (`run_ai_request` の `format` にそのまま渡す)。 */
export const SQL_EXPLAIN_FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      overview: { type: "string" },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: { title: { type: "string" }, detail: { type: "string" } },
          required: ["title", "detail"],
          additionalProperties: false,
        },
      },
      caveats: { type: "array", items: { type: "string" } },
    },
    required: ["overview", "steps", "caveats"],
    additionalProperties: false,
  },
} as const;

/** 構造化出力: 最適化リライト。 */
export const SQL_REWRITE_FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      rewritten_sql: { type: "string" },
      changes: {
        type: "array",
        items: {
          type: "object",
          properties: { what: { type: "string" }, why: { type: "string" } },
          required: ["what", "why"],
          additionalProperties: false,
        },
      },
      equivalence_notes: { type: "array", items: { type: "string" } },
      caveats: { type: "array", items: { type: "string" } },
    },
    required: ["rewritten_sql", "changes", "equivalence_notes", "caveats"],
    additionalProperties: false,
  },
} as const;

export function sqlAssistFormat(kind: SqlAssistKind) {
  return kind === "explain" ? SQL_EXPLAIN_FORMAT : SQL_REWRITE_FORMAT;
}

const explainSchema = z.object({
  overview: z.string(),
  steps: z.array(z.object({ title: z.string(), detail: z.string() })),
  caveats: z.array(z.string()),
});
export type SqlExplainResponse = z.infer<typeof explainSchema>;

const rewriteSchema = z.object({
  rewritten_sql: z.string(),
  changes: z.array(z.object({ what: z.string(), why: z.string() })),
  equivalence_notes: z.array(z.string()),
  caveats: z.array(z.string()),
});
export type SqlRewriteResponse = z.infer<typeof rewriteSchema>;

export type ParsedSqlAssist<T> = { ok: true; value: T } | { ok: false; raw: string };

function parseJson<T>(schema: z.ZodType<T>, text: string): ParsedSqlAssist<T> {
  let body = text.trim();
  // 念のためコードフェンスで囲まれていても受け付ける。
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(body);
  if (fenced) body = fenced[1];
  try {
    const parsed = schema.safeParse(JSON.parse(body));
    if (parsed.success) return { ok: true, value: parsed.data };
  } catch {
    /* JSON でない */
  }
  return { ok: false, raw: text };
}

/** ストリームで結合した本文を解説の JSON として解釈する。失敗時は本文をそのまま返す。 */
export function parseSqlExplainResponse(text: string): ParsedSqlAssist<SqlExplainResponse> {
  return parseJson(explainSchema, text);
}

/** リライトの JSON として解釈する。`rewritten_sql` が空なら失敗扱い (適用できないため)。 */
export function parseSqlRewriteResponse(text: string): ParsedSqlAssist<SqlRewriteResponse> {
  const r = parseJson(rewriteSchema, text);
  if (r.ok && r.value.rewritten_sql.trim() === "") return { ok: false, raw: text };
  return r;
}

export function buildSqlAssistSystem(kind: SqlAssistKind, locale: "ja" | "en"): string {
  const lang = locale === "ja" ? "Japanese" : "English";
  const common = [
    `Write all text fields in ${lang}.`,
    "Answer only with the JSON object described by the schema.",
    "Literal values in the SQL may be blanked out for privacy; keep that in mind and never invent data values.",
    "Only table definitions are provided, never row data.",
  ];
  if (kind === "explain") {
    return [
      "You are a database expert explaining an existing SQL statement to a developer.",
      "overview: one short paragraph on what the statement returns or changes.",
      "steps: walk through the processing in execution order, step by step. Cover CTEs, subqueries, joins, window functions and dialect-specific syntax; one step per logical stage with a short title and a detail.",
      "caveats: performance pitfalls or surprising behaviour worth knowing; an empty array when none.",
      ...common,
    ].join("\n");
  }
  return [
    "You are a database performance expert proposing an optimized rewrite of a SQL statement.",
    "rewritten_sql: one complete statement for the given dialect that returns exactly the same result as the original. Preserve column names, order of output columns and semantics (NULL handling, duplicates, ordering).",
    "If no safe improvement exists, return the original statement unchanged and say so in caveats.",
    "changes: each change with what was changed and why it helps.",
    "equivalence_notes: reasoning why the rewrite is equivalent, including any assumptions (e.g. unique or NOT NULL columns).",
    "caveats: conditions under which results could differ, and indexes that would be needed; an empty array when none.",
    "Never change a read statement into a write statement or the other way around.",
    ...common,
  ].join("\n");
}

export interface SqlAssistPromptInput {
  kind: SqlAssistKind;
  sql: string;
  /** `mysql` / `postgres` / `sqlite`。 */
  driver: string;
  tables: ExplainTable[];
  /** 設定 `ai.maskLiterals`。true なら SQL 内のリテラルとコメントを潰して送る。 */
  maskLiterals: boolean;
}

/** ユーザプロンプトを組み立てる。行データは含めない (スキーマ情報のみ)。 */
export function buildSqlAssistPrompt(input: SqlAssistPromptInput): string {
  const lines: string[] = [];
  lines.push(`Dialect: ${dialectLabel(input.driver)}`);
  lines.push(`Task: ${input.kind === "explain" ? "explain this SQL" : "propose an optimized, equivalent rewrite"}`);
  lines.push("");
  lines.push(input.maskLiterals ? "SQL (string literals and comments are blanked):" : "SQL:");
  lines.push(sqlForAi(input.sql, input.driver, input.maskLiterals));
  if (input.tables.length > 0) {
    lines.push("");
    lines.push("Referenced tables:");
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

export interface DiffLine {
  type: "same" | "add" | "del";
  text: string;
}

/**
 * 行単位の簡易 diff (LCS)。前後の共通行を先に切り落としてから中央部だけを DP する。
 * 末尾空白と改行コード (CRLF) の違いは無視して比較するが、表示は新側 / 旧側の行をそのまま返す。
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const split = (s: string) => (s === "" ? [] : s.replace(/\r\n/g, "\n").split("\n"));
  const a = split(before);
  const b = split(after);
  const norm = (s: string) => s.replace(/\s+$/, "");
  let head = 0;
  while (head < a.length && head < b.length && norm(a[head]) === norm(b[head])) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    norm(a[a.length - 1 - tail]) === norm(b[b.length - 1 - tail])
  ) {
    tail++;
  }
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  const n = am.length;
  const m = bm.length;
  // lcs[i][j] = am[i..] と bm[j..] の LCS 長。
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = norm(am[i]) === norm(bm[j]) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  for (let i = 0; i < head; i++) out.push({ type: "same", text: b[i] });
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (norm(am[i]) === norm(bm[j])) {
      out.push({ type: "same", text: bm[j] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: "del", text: am[i++] });
    } else {
      out.push({ type: "add", text: bm[j++] });
    }
  }
  while (i < n) out.push({ type: "del", text: am[i++] });
  while (j < m) out.push({ type: "add", text: bm[j++] });
  for (let k = b.length - tail; k < b.length; k++) out.push({ type: "same", text: b[k] });
  return out;
}

/** diff に差分が 1 行でもあるか。 */
export function hasDiffChanges(lines: readonly DiffLine[]): boolean {
  return lines.some((l) => l.type !== "same");
}

export interface ApplyTarget {
  from: number;
  to: number;
  /** 起動時の範囲に元の SQL がそのまま残っていた (確認なしで置換してよい)。 */
  exact: boolean;
}

/**
 * リライトを適用する範囲を決める。`range` は起動時の選択範囲 (全文なら null)。
 * - 起動時の範囲に元の SQL がそのまま残っていれば `exact: true` でその範囲。
 * - 変わっていれば、本文中でちょうど 1 箇所見つかった位置、無ければ全文 (どちらも `exact: false`
 *   = 呼び出し側が確認を取る)。
 */
export function locateApplyTarget(
  current: string,
  original: string,
  range: { from: number; to: number } | null,
): ApplyTarget {
  if (range) {
    if (range.to <= current.length && current.slice(range.from, range.to) === original) {
      return { from: range.from, to: range.to, exact: true };
    }
  } else if (current === original) {
    return { from: 0, to: current.length, exact: true };
  }
  const found = findSqlRange(current, original);
  if (found) return { ...found, exact: false };
  return { from: 0, to: current.length, exact: false };
}

/**
 * 適用する SQL。元の範囲の末尾に `;` が含まれていたときだけ提案の `;` を残し、そうでなければ
 * 落とす (範囲の外側に既にある `;` と重ならないように)。前後の空白は落とす。
 */
export function sqlForApply(newSql: string, target: ApplyTarget, current: string): string {
  const body = newSql.trim();
  const original = current.slice(target.from, target.to);
  const keep = target.exact && /;\s*$/.test(original);
  const bare = body.replace(/;+\s*$/, "");
  return keep ? `${bare};` : bare;
}
