// スキーマ / データ比較の同期 SQL に対する AI リスク要約 (#697) の純ロジック:
// 送信コンテキストの組み立て・プロンプト・応答パース・破壊的文の補完。
// 副作用 (IPC・状態管理) は `components/AiSyncRisk.tsx` が持つ。
//
// 送信する情報の方針:
// - スキーマ比較: 差分のあるテーブル / カラムの定義 (型・NULL 可・デフォルトの有無) と
//   同期 SQL (`sqlForAi` でリテラルをマスク)。デフォルト値そのものは送らない。
// - データ比較: 挿入 / 更新 / 削除の**行数などのメタ情報のみ**。セル値は一切送らず、
//   行 DML の SQL 本文 (値を含む) も送らない。文の種別・テーブル・破壊的かどうかだけを送る。

import { z } from "zod";
import type { DriverKind, SchemaDiff, SyncStatement, TableColumnInfo } from "../api/tauri";
import { dialectLabel, sqlForAi } from "./errorExplain";

/** プロンプトに載せる同期文の上限 (巨大プランでプロンプトが膨らむのを防ぐ)。 */
export const SYNC_RISK_MAX_STATEMENTS = 200;
/** 1 文あたりの SQL の最大文字数。 */
export const SYNC_RISK_MAX_SQL_CHARS = 2000;
/** 差分要約に載せるテーブル数の上限。 */
export const SYNC_RISK_MAX_TABLES = 100;

export type SyncRiskSeverity = "high" | "medium" | "low";

/** 構造化出力で受け取る応答の形 (`run_ai_request` の `format` にそのまま渡す)。 */
export const SYNC_RISK_FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      summary: { type: "string" },
      risk_items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            statement_index: { type: "integer" },
            risk: { type: "string" },
            severity: { type: "string", enum: ["high", "medium", "low"] },
          },
          required: ["statement_index", "risk", "severity"],
          additionalProperties: false,
        },
      },
      recommendation: { type: "string" },
    },
    required: ["summary", "risk_items", "recommendation"],
    additionalProperties: false,
  },
} as const;

const responseSchema = z.object({
  summary: z.string(),
  risk_items: z.array(
    z.object({
      statement_index: z.number().int(),
      risk: z.string(),
      severity: z.enum(["high", "medium", "low"]),
    }),
  ),
  recommendation: z.string(),
});
export type SyncRiskResponse = z.infer<typeof responseSchema>;
export type SyncRiskItem = SyncRiskResponse["risk_items"][number];

export type ParsedSyncRisk = { ok: true; value: SyncRiskResponse } | { ok: false; raw: string };

/** ストリームで結合した本文を JSON として解釈する。失敗時は本文をそのまま返す。 */
export function parseSyncRiskResponse(text: string): ParsedSyncRisk {
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

/** 破壊的な文か (DROP / DELETE / TRUNCATE)。バックエンドの `destructive` に加え種別と SQL 先頭でも判定する。 */
export function isDestructiveStatement(s: Pick<SyncStatement, "sql" | "kind" | "destructive">): boolean {
  if (s.destructive) return true;
  if (s.kind === "drop_column" || s.kind === "drop_table" || s.kind === "delete_row") return true;
  return /^\s*(?:DROP|DELETE|TRUNCATE)\b/i.test(s.sql);
}

/**
 * 応答の `risk_items` を整える。(a) 範囲外 / 非整数の `statement_index` を捨て、
 * (b) 破壊的な文に説明が 1 件も無ければ high のバッジを補い、(c) index 順に並べる。
 * `missingText` は補う項目の文言 (i18n 済み)。
 */
export function finalizeRiskItems(
  items: readonly SyncRiskItem[],
  statements: readonly Pick<SyncStatement, "sql" | "kind" | "destructive">[],
  missingText: string,
): SyncRiskItem[] {
  const valid = items.filter(
    (it) => Number.isInteger(it.statement_index) && it.statement_index >= 0 && it.statement_index < statements.length,
  );
  const covered = new Set(valid.map((it) => it.statement_index));
  const out = [...valid];
  statements.forEach((s, i) => {
    if (isDestructiveStatement(s) && !covered.has(i)) {
      out.push({ statement_index: i, risk: missingText, severity: "high" });
    }
  });
  // 安定ソート (同じ index では応答順を保つ)。
  return out
    .map((it, order) => ({ it, order }))
    .sort((a, b) => a.it.statement_index - b.it.statement_index || a.order - b.order)
    .map((x) => x.it);
}

/** index ごとにまとめる (行のバッジ描画用)。 */
export function groupRiskByIndex(items: readonly SyncRiskItem[]): Map<number, SyncRiskItem[]> {
  const m = new Map<number, SyncRiskItem[]>();
  for (const it of items) {
    const list = m.get(it.statement_index);
    if (list) list.push(it);
    else m.set(it.statement_index, [it]);
  }
  return m;
}

function columnLine(label: string, c: TableColumnInfo | null): string {
  if (!c) return `${label}: (absent)`;
  // デフォルト値そのものはリテラルを含み得るので有無だけ送る。
  const flags = [
    c.nullable ? "nullable" : "not null",
    c.default !== null ? "has default" : "no default",
    c.key ? `key=${c.key}` : "",
    c.referenced_table ? `-> ${c.referenced_table}.${c.referenced_column ?? "?"}` : "",
  ].filter(Boolean);
  return `${label}: ${c.data_type} (${flags.join(", ")})`;
}

/**
 * `SchemaDiff` の要約。差分のあるテーブル / カラムだけを列挙する。セル値・デフォルト値は含まない。
 * 差分が無ければ空配列。
 */
export function summarizeSchemaDiff(diff: SchemaDiff): string[] {
  const lines: string[] = [];
  const changed = diff.tables.filter((t) => t.status !== "same");
  for (const t of changed.slice(0, SYNC_RISK_MAX_TABLES)) {
    lines.push(`- table ${t.name}: ${t.status}`);
    for (const c of t.columns) {
      const fields = c.changed_fields.length > 0 ? ` changed=[${c.changed_fields.join(",")}]` : "";
      lines.push(`    column ${c.name}: ${c.status}${fields}`);
      if (c.status === "different") {
        lines.push(`        ${columnLine("source", c.source)}`);
        lines.push(`        ${columnLine("target", c.target)}`);
      } else {
        lines.push(`        ${columnLine(c.status === "target_only" ? "target" : "source", c.status === "target_only" ? c.target : c.source)}`);
      }
    }
  }
  if (changed.length > SYNC_RISK_MAX_TABLES) {
    lines.push(`- ... and ${changed.length - SYNC_RISK_MAX_TABLES} more tables with differences`);
  }
  return lines;
}

/** データ比較のメタ情報。件数は比較結果ではなく**実際に生成された DML** (`countDmlStatements`) を使う。 */
export interface DataSyncSummary {
  table: string;
  /** 行数上限で比較が打ち切られたか。 */
  truncated: boolean;
}

/** 生成された行 DML の件数 (`allow_delete` 無効・上限打ち切り・PK 欠落などで比較結果の行数とは一致しない)。 */
export function countDmlStatements(statements: readonly Pick<SyncStatement, "kind">[]): {
  inserts: number;
  updates: number;
  deletes: number;
} {
  const c = { inserts: 0, updates: 0, deletes: 0 };
  for (const s of statements) {
    if (s.kind === "insert_row") c.inserts += 1;
    else if (s.kind === "update_row") c.updates += 1;
    else if (s.kind === "delete_row") c.deletes += 1;
  }
  return c;
}

export interface SyncRiskInput {
  planKind: "schema" | "data";
  sourceDriver: DriverKind;
  targetDriver: DriverKind;
  statements: readonly SyncStatement[];
  warnings: readonly string[];
  /** **プラン生成時**に使ったフラグ (生成後にチェックを切り替えても変わらない)。 */
  allowDestructive: boolean;
  allowDelete: boolean;
  /** スキーマ比較の結果 (`planKind === "schema"` のとき)。 */
  diff: SchemaDiff | null;
  /** データ比較の件数 (`planKind === "data"` のとき)。 */
  dataSummary: DataSyncSummary | null;
  /** 設定 `ai.maskLiterals`。 */
  maskLiterals: boolean;
}

/** 送る同期文の選択。破壊的な文を優先して上限まで入れる (index は元のまま)。 */
export function selectStatementsForPrompt(
  statements: readonly SyncStatement[],
): { index: number; statement: SyncStatement }[] {
  const all = statements.map((statement, index) => ({ index, statement }));
  if (all.length <= SYNC_RISK_MAX_STATEMENTS) return all;
  const destructive = all.filter((x) => isDestructiveStatement(x.statement));
  const rest = all.filter((x) => !isDestructiveStatement(x.statement));
  return [...destructive, ...rest].slice(0, SYNC_RISK_MAX_STATEMENTS).sort((a, b) => a.index - b.index);
}

export function buildSyncRiskSystem(locale: "ja" | "en"): string {
  const lang = locale === "ja" ? "Japanese" : "English";
  return [
    "You are a database expert reviewing a schema/data synchronization plan that will be applied to a target database.",
    `Write all text fields in ${lang}. Be concise and use plain words that a non-expert can follow.`,
    "Answer only with the JSON object described by the schema.",
    "summary: what happens if the plan is applied (what is created, changed, dropped or deleted), including the impact of any destructive statements.",
    "risk_items: one entry per risky statement. statement_index is the 0-based index shown as `#N` in the prompt. Never invent indexes.",
    "severity: high = data loss or irreversible change (DROP, DELETE, TRUNCATE, narrowing a type, adding NOT NULL without default); medium = may fail or lock or change behavior; low = minor.",
    "Every destructive statement (DROP / DELETE / TRUNCATE) must have a risk_items entry explaining what is lost.",
    "recommendation: what to check or do before applying (backups, ordering, running in a transaction or on a copy first).",
    "If the target dialect is MySQL and the plan contains DDL, state in summary that DDL implicitly commits, so the apply is NOT all-or-nothing: statements are applied one by one on a best-effort basis and a failure part-way leaves earlier statements applied.",
    "Row-level data plans are described only by counts; cell values and SQL bodies are intentionally not provided. Do not ask for them or guess them.",
    "String literals in SQL may be blanked out for privacy. This is only a review aid: the user decides whether to apply.",
  ].join("\n");
}

/** ユーザプロンプトを組み立てる。データ比較ではセル値も行 DML の SQL 本文も含めない。 */
export function buildSyncRiskPrompt(input: SyncRiskInput): string {
  const lines: string[] = [];
  lines.push(`Source dialect: ${dialectLabel(input.sourceDriver)}`);
  lines.push(`Target dialect: ${dialectLabel(input.targetDriver)}`);
  lines.push(`Plan type: ${input.planKind === "schema" ? "schema (DDL)" : "row data (DML)"}`);
  lines.push(
    input.planKind === "schema"
      ? `Plan was generated with allow_destructive=${input.allowDestructive} (whether DROP TABLE / DROP COLUMN statements were allowed to be generated)`
      : `Plan was generated with allow_delete=${input.allowDelete} (whether DELETE statements were allowed to be generated)`,
  );
  if (input.targetDriver === "mysql" && input.planKind === "schema") {
    lines.push("Note: MySQL DDL implicitly commits; the apply is not atomic.");
  }
  if (input.planKind === "data" && input.dataSummary) {
    const d = input.dataSummary;
    const n = countDmlStatements(input.statements);
    lines.push("");
    lines.push(`Data comparison (table ${d.table}) — generated statement counts only, no cell values:`);
    lines.push(`- rows to insert: ${n.inserts}`);
    lines.push(`- rows to update: ${n.updates}`);
    lines.push(`- rows to delete: ${n.deletes}`);
    if (d.truncated) lines.push("- the comparison was capped by the row limit, so the result is partial");
  }
  if (input.planKind === "schema" && input.diff) {
    const summary = summarizeSchemaDiff(input.diff);
    if (summary.length > 0) {
      lines.push("");
      lines.push("Schema differences (source -> target):");
      lines.push(...summary);
    }
  }
  const picked = selectStatementsForPrompt(input.statements);
  lines.push("");
  lines.push(
    `Planned statements (${input.statements.length} total${picked.length < input.statements.length ? `, ${picked.length} shown` : ""}), applied to the target in this order:`,
  );
  for (const { index, statement } of picked) {
    const head = `#${index} [${statement.kind}] table=${statement.table}${isDestructiveStatement(statement) ? " DESTRUCTIVE" : ""}`;
    if (input.planKind === "data") {
      // 行 DML の SQL 本文には値が入るので送らない。
      lines.push(head);
    } else {
      const sql = sqlForAi(statement.sql, input.targetDriver, input.maskLiterals);
      lines.push(head);
      lines.push(sql.length > SYNC_RISK_MAX_SQL_CHARS ? `${sql.slice(0, SYNC_RISK_MAX_SQL_CHARS)} ...(truncated)` : sql);
    }
  }
  if (input.warnings.length > 0) {
    lines.push("");
    lines.push("Plan warnings (cases skipped by the generator):");
    for (const w of input.warnings) lines.push(`- ${w}`);
  }
  return lines.join("\n");
}
