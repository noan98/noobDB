// スキーマ健全性アドバイザの指摘を AI に解説させる (#1468) 純ロジック:
// 関連テーブルの決定・プロンプト組み立て・応答パース。副作用 (IPC・状態管理) は
// `components/AiAdvisorExplain.tsx` が持つ。送るのは指摘の内容と関係テーブルの
// スキーマ定義 (列・インデックス) だけで、行データは一切扱わない。

import { z } from "zod";
import type { HealthFinding } from "../api/tauri";
import type { SemanticRole } from "../semanticColors";
import { dialectLabel, ERROR_EXPLAIN_MAX_TABLES, sqlForAi, type ExplainColumn } from "./errorExplain";

/** 修正 SQL を実行してよいかの判定。`no_fix` は修正 SQL が無い指摘 (設計判断が要るもの)。 */
export const ADVISOR_VERDICTS = ["safe", "caution", "avoid", "no_fix"] as const;
export type AdvisorVerdict = (typeof ADVISOR_VERDICTS)[number];

/** 構造化出力で受け取る応答の形 (`run_ai_request` の `format` にそのまま渡す)。 */
export const ADVISOR_EXPLAIN_FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      why: { type: "string" },
      consequence: { type: "string" },
      fix_verdict: { type: "string", enum: [...ADVISOR_VERDICTS] },
      fix_advice: { type: "string" },
      cautions: { type: "array", items: { type: "string" } },
    },
    required: ["why", "consequence", "fix_verdict", "fix_advice", "cautions"],
    additionalProperties: false,
  },
} as const;

const responseSchema = z.object({
  why: z.string(),
  consequence: z.string(),
  fix_verdict: z.enum(ADVISOR_VERDICTS),
  fix_advice: z.string(),
  cautions: z.array(z.string()),
});
export type AdvisorExplainResponse = z.infer<typeof responseSchema>;

export type ParsedAdvisorExplain =
  | { ok: true; value: AdvisorExplainResponse }
  | { ok: false; raw: string };

/** ストリームで結合した本文を JSON として解釈する。失敗時は本文をそのまま返す。 */
export function parseAdvisorExplainResponse(text: string): ParsedAdvisorExplain {
  let body = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(body);
  if (fenced) body = fenced[1];
  try {
    const parsed = responseSchema.safeParse(JSON.parse(body));
    if (parsed.success) return { ok: true, value: parsed.data };
  } catch {
    /* JSON でない */
  }
  return { ok: false, raw: text };
}

/** 判定 → 意味色の役割 (`semanticColors.ts`)。修正 SQL が無いときは中立色。 */
export function verdictTone(verdict: AdvisorVerdict): SemanticRole {
  switch (verdict) {
    case "safe":
      return "success";
    case "caution":
      return "warning";
    case "avoid":
      return "danger";
    default:
      return "info";
  }
}

/**
 * 解説に添えるテーブル名。指摘の対象テーブルを先頭に、参照先テーブル
 * (`fk_missing_index` は `context[0]`、`fk_type_mismatch` は `context[1]` の `table.列`)
 * を重複なしで足す。上限は `ERROR_EXPLAIN_MAX_TABLES`。
 */
export function advisorRelatedTables(finding: HealthFinding): string[] {
  const out: string[] = [finding.table];
  let ref: string | undefined;
  if (finding.rule === "fk_missing_index") ref = finding.context[0];
  else if (finding.rule === "fk_type_mismatch") ref = finding.context[1]?.slice(0, Math.max(0, finding.context[1].lastIndexOf(".")));
  if (ref && !out.some((n) => n.toLowerCase() === ref.toLowerCase())) out.push(ref);
  return out.slice(0, ERROR_EXPLAIN_MAX_TABLES);
}

export interface AdvisorExplainIndex {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

export interface AdvisorExplainTable {
  name: string;
  columns: ExplainColumn[];
  indexes: AdvisorExplainIndex[];
}

export interface AdvisorExplainInput {
  /** `mysql` / `postgres` / `sqlite`。 */
  driver: string;
  finding: HealthFinding;
  tables: AdvisorExplainTable[];
  /** 設定 `ai.maskLiterals`。修正 DDL のリテラルを潰して送る。 */
  maskLiterals: boolean;
}

export function buildAdvisorExplainSystem(locale: "ja" | "en"): string {
  const lang = locale === "ja" ? "Japanese" : "English";
  return [
    "You are a database expert explaining a finding from a rule-based schema health advisor.",
    `Write all text fields in ${lang}.`,
    "Answer only with the JSON object described by the schema.",
    "why: why this is a problem in the given schema, in plain words.",
    "consequence: what happens if it is left alone (performance, write cost, integrity, storage).",
    "fix_verdict: whether running the proposed fix SQL is advisable. safe = low risk; caution = depends on conditions to verify first; avoid = should not be run as is; no_fix = no fix SQL is proposed (a design decision is needed).",
    "fix_advice: reasoning for the verdict and what to check or do first (when no fix SQL exists, suggest how to approach the change).",
    "cautions: short caveats such as locking, replicas, workloads not visible from the schema, or the dependence of statistics-based findings on the observation window; an empty array when none.",
    "Findings marked as statistics-based (e.g. unused indexes) can be wrong: the statistics reset on restart and may not cover rare jobs such as month-end batches, so never call dropping such an index safe without verification.",
    "Use only the schema information provided; never invent tables, columns or data values. The fix SQL is only explained, never executed by anyone but the user.",
  ].join("\n");
}

/** ユーザプロンプトを組み立てる。行データは含めない (指摘とスキーマ定義のみ)。 */
export function buildAdvisorExplainPrompt(input: AdvisorExplainInput): string {
  const f = input.finding;
  const lines: string[] = [];
  lines.push(`Dialect: ${dialectLabel(input.driver)}`);
  lines.push("Finding:");
  lines.push(`- rule: ${f.rule}`);
  lines.push(`- severity: ${f.severity}`);
  lines.push(`- table: ${f.table}`);
  if (f.columns.length > 0) lines.push(`- columns: ${f.columns.join(", ")}`);
  if (f.context.length > 0) lines.push(`- details: ${f.context.join(" | ")}`);
  lines.push(`- statistics-based: ${f.statistical ? "yes" : "no"}`);
  lines.push("");
  if (f.fix_ddl) {
    lines.push(input.maskLiterals ? "Proposed fix SQL (literals are blanked):" : "Proposed fix SQL:");
    lines.push(sqlForAi(f.fix_ddl, input.driver, input.maskLiterals));
  } else {
    lines.push("Proposed fix SQL: none (a design decision is needed)");
  }
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
      for (const ix of t.indexes) {
        const flags = [ix.primary ? "primary" : "", ix.unique ? "unique" : ""].filter(Boolean);
        lines.push(`    index ${ix.name} (${ix.columns.join(", ")})${flags.length ? ` [${flags.join(", ")}]` : ""}`);
      }
    }
  }
  return lines.join("\n");
}
