// 危険クエリ実行前の AI 影響分析 (#694) の純ロジック: 対象テーブルの決定・関連 FK の絞り込み・
// プロンプト組み立て・応答パース。副作用 (IPC・状態管理) は `components/AiImpactAnalysis.tsx` が持つ。
// 行データ・セル値は一切扱わない (入力型がスキーマ情報と件数のメタ情報しか持たない)。

import { z } from "zod";
import type { DangerFinding, DangerKind } from "../dangerousSql";
import type { SemanticRole } from "../semanticColors";
import {
  dialectLabel,
  ERROR_EXPLAIN_MAX_TABLES,
  extractTableRefs,
  sqlForAi,
  type ExplainColumn,
  type TableRef,
} from "./errorExplain";

/** 関連 FK としてプロンプトに載せる上限 (巨大スキーマでプロンプトが膨らむのを防ぐ)。 */
export const IMPACT_MAX_FOREIGN_KEYS = 40;

export const IMPACT_RISKS = ["high", "medium", "low"] as const;
export type ImpactRisk = (typeof IMPACT_RISKS)[number];

/** 構造化出力で受け取る応答の形 (`run_ai_request` の `format` にそのまま渡す)。 */
export const IMPACT_ANALYSIS_FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      summary: { type: "string" },
      affected_tables: {
        type: "array",
        items: {
          type: "object",
          properties: {
            table: { type: "string" },
            estimated_rows: { type: "string" },
            reason: { type: "string" },
          },
          required: ["table", "estimated_rows", "reason"],
          additionalProperties: false,
        },
      },
      cascades: {
        type: "array",
        items: {
          type: "object",
          properties: {
            from: { type: "string" },
            to: { type: "string" },
            via: { type: "string" },
          },
          required: ["from", "to", "via"],
          additionalProperties: false,
        },
      },
      risk: { type: "string", enum: [...IMPACT_RISKS] },
      recommendations: { type: "array", items: { type: "string" } },
    },
    required: ["summary", "affected_tables", "cascades", "risk", "recommendations"],
    additionalProperties: false,
  },
} as const;

const responseSchema = z.object({
  summary: z.string(),
  affected_tables: z.array(
    z.object({ table: z.string(), estimated_rows: z.string(), reason: z.string() }),
  ),
  cascades: z.array(z.object({ from: z.string(), to: z.string(), via: z.string() })),
  risk: z.enum(IMPACT_RISKS),
  recommendations: z.array(z.string()),
});
export type ImpactAnalysisResponse = z.infer<typeof responseSchema>;

export type ParsedImpactAnalysis =
  | { ok: true; value: ImpactAnalysisResponse }
  | { ok: false; raw: string };

/** ストリームで結合した本文を JSON として解釈する。失敗時は本文をそのまま返す。 */
export function parseImpactAnalysisResponse(text: string): ParsedImpactAnalysis {
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

/** リスク → 意味色の役割 (`semanticColors.ts`)。 */
export function riskTone(risk: ImpactRisk): SemanticRole {
  return risk === "high" ? "danger" : risk === "medium" ? "warning" : "success";
}

function unquoteIdent(ident: string): string {
  const t = ident.trim();
  const first = t[0];
  if ((first === "`" || first === '"' || first === "[") && t.length >= 2) return t.slice(1, -1);
  return t;
}

/** 検出結果の対象 (`` `db`.`t` `` など) をテーブル参照に直す。解釈できなければ null。 */
export function findingTableRef(finding: DangerFinding): TableRef | null {
  if (!finding.target) return null;
  // `a.b` の区切り。クォート内のドットまでは扱わない (ベストエフォート)。
  const parts = finding.target.split(".").map(unquoteIdent).filter((p) => p !== "");
  if (parts.length === 0) return null;
  const table = parts[parts.length - 1];
  const database = parts.length > 1 ? parts[parts.length - 2] : null;
  return { database, table };
}

/**
 * 分析対象のテーブル参照。検出結果の対象 (DROP / TRUNCATE も拾える) を先頭に、
 * SQL から抽出したテーブルを重複なしで足す。上限は `ERROR_EXPLAIN_MAX_TABLES`。
 */
export function impactTableRefs(
  sql: string,
  findings: DangerFinding[],
  driver: string,
): TableRef[] {
  const seen = new Set<string>();
  const out: TableRef[] = [];
  const add = (ref: TableRef | null) => {
    if (!ref || out.length >= ERROR_EXPLAIN_MAX_TABLES) return;
    const key = `${ref.database ?? ""}.${ref.table}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(ref);
  };
  for (const f of findings) add(findingTableRef(f));
  for (const r of extractTableRefs(sql, driver)) add(r);
  return out;
}

export interface ImpactForeignKey {
  table: string;
  column: string;
  referenced_table: string;
  referenced_column: string | null;
  constraint_name: string | null;
}

/** 対象テーブルが参照する / 参照される FK だけに絞る (大文字小文字は無視)。 */
export function selectRelatedForeignKeys(
  fks: ImpactForeignKey[],
  tableNames: string[],
): ImpactForeignKey[] {
  const names = new Set(tableNames.map((n) => n.toLowerCase()));
  return fks
    .filter((fk) => names.has(fk.table.toLowerCase()) || names.has(fk.referenced_table.toLowerCase()))
    .slice(0, IMPACT_MAX_FOREIGN_KEYS);
}

export interface ImpactTable {
  name: string;
  columns: ExplainColumn[];
  /** エンジン統計の行数推定 (COUNT スキャンではない)。取れなければ null。 */
  estimatedRows: number | null;
}

/** ダイアログが持つ事前プレビューの件数メタ情報 (行データは含まない)。 */
export interface ImpactPreflight {
  verb: "update" | "delete";
  count: number | null;
  allRows: boolean;
}

export interface ImpactAnalysisInput {
  /** `mysql` / `postgres` / `sqlite`。 */
  driver: string;
  sql: string;
  findings: DangerFinding[];
  tables: ImpactTable[];
  foreignKeys: ImpactForeignKey[];
  preflight: ImpactPreflight | null;
  isProduction: boolean;
  /** 設定 `ai.maskLiterals`。true なら SQL 内のリテラルを潰して送る。 */
  maskLiterals: boolean;
  locale: "ja" | "en";
}

const KIND_DESCRIPTION: Record<DangerKind, string> = {
  deleteNoWhere: "DELETE without WHERE",
  updateNoWhere: "UPDATE without WHERE",
  drop: "DROP",
  truncate: "TRUNCATE",
};

export function buildImpactAnalysisSystem(locale: "ja" | "en"): string {
  const lang = locale === "ja" ? "Japanese" : "English";
  return [
    "You are a database expert assessing the impact of a SQL statement BEFORE it is executed.",
    `Write all text fields in ${lang}.`,
    "Answer only with the JSON object described by the schema.",
    "summary: what the statement will do and how far it reaches, in plain words.",
    "affected_tables: each table that is changed or lost; estimated_rows is a short human-readable estimate (e.g. \"all ~12,000 rows\", \"unknown\"); reason explains why.",
    "cascades: effects that may propagate through foreign keys (from -> to, via = constraint or column); use an empty array when none are indicated by the given schema.",
    "ON DELETE / ON UPDATE rules are NOT provided. Describe cascades only as possibilities that depend on the rule (CASCADE / SET NULL / RESTRICT), and recommend checking the rule.",
    "risk: high (data loss / whole table / irreversible), medium, or low.",
    "recommendations: concrete safeguards before running (backup, WHERE clause, transaction, dry run); an empty array when none.",
    "Use only the schema information provided; never invent data values or foreign keys that are not listed.",
    "Literal values in the SQL may be blanked out for privacy; keep that in mind.",
  ].join("\n");
}

/** ユーザプロンプトを組み立てる。行データ・セル値は含めない (スキーマと件数のメタ情報のみ)。 */
export function buildImpactAnalysisPrompt(input: ImpactAnalysisInput): string {
  const lines: string[] = [];
  lines.push(`Dialect: ${dialectLabel(input.driver)}`);
  lines.push(`Production connection: ${input.isProduction ? "yes" : "no"}`);
  if (input.findings.length > 0) {
    lines.push("Detected risks:");
    for (const f of input.findings) {
      lines.push(`- ${KIND_DESCRIPTION[f.kind]}${f.target ? ` on ${f.target}` : ""}`);
    }
  }
  if (input.preflight) {
    const p = input.preflight;
    const parts = [
      p.verb === "delete" ? "DELETE" : "UPDATE",
      p.count !== null ? `estimated affected rows: ${p.count}` : "affected row count: not available",
      p.allRows ? "no WHERE (every row in the table)" : "",
    ].filter(Boolean);
    lines.push(`Preflight: ${parts.join(", ")}`);
  }
  lines.push("");
  lines.push(
    input.maskLiterals ? "SQL (string literals and comments are blanked):" : "SQL:",
  );
  lines.push(sqlForAi(input.sql, input.driver, input.maskLiterals));
  if (input.tables.length > 0) {
    lines.push("");
    lines.push("Related tables:");
    for (const t of input.tables) {
      lines.push(`- ${t.name} (estimated rows: ${t.estimatedRows ?? "unknown"})`);
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
  if (input.foreignKeys.length > 0) {
    lines.push("");
    lines.push("Foreign keys touching these tables (child.column -> parent.column) (referential actions unknown):");
    for (const fk of input.foreignKeys) {
      lines.push(
        `- ${fk.table}.${fk.column} -> ${fk.referenced_table}.${fk.referenced_column ?? "?"}${
          fk.constraint_name ? ` [${fk.constraint_name}]` : ""
        }`,
      );
    }
  }
  return lines.join("\n");
}
