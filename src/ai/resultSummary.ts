// 結果グリッドの「AI で要約」(#1476) の純ロジック: 送信内容の組み立て・応答パース。
// 副作用 (IPC・状態管理) は `components/AiResultSummaryPanel.tsx` が持つ。
//
// ## 何を送るか (`allowRowData` で厳密に分ける)
//
// - オフ (既定): 列名・型と、**値そのものを含まない**列統計 (件数・NULL 数・NULL 率・
//   異なり数・文字列長の範囲) と SQL だけ。セルの値は 1 つも載せない。最小 / 最大・最頻値・
//   合計・平均も値 (または 1 行だけの結果では値そのもの) になりうるので、オフのときは
//   数値列でも送らない。
// - オン: 上記に加えて min / max / 最頻値 / 合計 / 平均と、先頭 N 行 (セルは長さを切り詰める)。

import { z } from "zod";
import type { CellValue, Column } from "../api/tauri";
import { classifyTypeName, type CellKind } from "../components/cellTypeMeta";
import { columnStats, nullRatePercentOf, type ColumnStats } from "../components/gridStats";
import { isReadOnlySql } from "../dangerousSql";
import { dialectLabel, sqlForAi } from "./errorExplain";

/** `allowRowData` オン時に送る先頭行数。 */
export const RESULT_SUMMARY_MAX_ROWS = 20;
/** 1 セルあたりの最大文字数 (超えた分は `…` で切る)。 */
export const RESULT_SUMMARY_CELL_MAX_CHARS = 80;
/** 送る列数の上限 (列が極端に多い結果でプロンプトが膨らむのを防ぐ)。 */
export const RESULT_SUMMARY_MAX_COLUMNS = 60;
/** 統計の計算に使う行数の上限 (取得済みの行がこれを超えるときは先頭から)。 */
export const RESULT_SUMMARY_STATS_MAX_ROWS = 50_000;
/** 追加 SQL 案の上限件数。 */
export const RESULT_SUMMARY_MAX_QUERIES = 5;

/** 構造化出力で受け取る応答の形 (`run_ai_request` の `format` にそのまま渡す)。 */
export const RESULT_SUMMARY_FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      summary: { type: "string" },
      trends: { type: "array", items: { type: "string" } },
      anomalies: { type: "array", items: { type: "string" } },
      next_queries: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            sql: { type: "string" },
            reason: { type: "string" },
          },
          required: ["title", "sql", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["summary", "trends", "anomalies", "next_queries"],
    additionalProperties: false,
  },
} as const;

const responseSchema = z.object({
  summary: z.string(),
  trends: z.array(z.string()),
  anomalies: z.array(z.string()),
  next_queries: z.array(z.object({ title: z.string(), sql: z.string(), reason: z.string() })),
});
export type ResultSummaryResponse = z.infer<typeof responseSchema>;

export type ParsedResultSummary =
  | { ok: true; value: ResultSummaryResponse }
  | { ok: false; raw: string };

/**
 * ストリームで結合した本文を JSON として解釈する。失敗時は本文をそのまま返す。
 * 追加 SQL 案は空のもの・読み取り専用でないもの (結果の「次の切り口」は参照のみ) を落とし、
 * 上限件数に切り詰める。
 */
export function parseResultSummaryResponse(text: string, driver?: string): ParsedResultSummary {
  let body = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(body);
  if (fenced) body = fenced[1];
  try {
    const parsed = responseSchema.safeParse(JSON.parse(body));
    if (parsed.success) {
      const next_queries = parsed.data.next_queries
        .filter((q) => q.sql.trim() !== "" && isReadOnlySql(q.sql, driver))
        .slice(0, RESULT_SUMMARY_MAX_QUERIES);
      return { ok: true, value: { ...parsed.data, next_queries } };
    }
  } catch {
    /* JSON でない */
  }
  return { ok: false, raw: text };
}

/** セルを 1 行ぶんの文字列にする。長いものは切り詰め、改行は空白に潰す。 */
export function truncateCell(v: CellValue, max = RESULT_SUMMARY_CELL_MAX_CHARS): string {
  if (v === null || v === undefined) return "NULL";
  const s = String(v).replace(/\s+/g, " ");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export interface ResultSummaryInput {
  /** `mysql` / `postgres` / `sqlite`。 */
  driver: string;
  /** 実行した SQL (マスク前)。 */
  sql: string;
  columns: Column[];
  /** グリッドに取得済みの行。 */
  rows: CellValue[][];
  /** 設定 `ai.allowRowData`。 */
  allowRowData: boolean;
  /** 設定 `ai.maskLiterals`。 */
  maskLiterals: boolean;
}

/** 列ごとの統計 (送信用)。`ColumnStats` から値を含むものを落とした形か、含めた形。 */
export interface SummaryColumn {
  name: string;
  typeName: string;
  kind: CellKind;
  stats: ColumnStats;
}

export function summarizeColumns(
  columns: Column[],
  rows: CellValue[][],
): { columns: SummaryColumn[]; omittedColumns: number; statsRows: number } {
  const used = rows.length > RESULT_SUMMARY_STATS_MAX_ROWS ? rows.slice(0, RESULT_SUMMARY_STATS_MAX_ROWS) : rows;
  const shown = columns.slice(0, RESULT_SUMMARY_MAX_COLUMNS);
  return {
    columns: shown.map((c, i) => {
      const kind = classifyTypeName(c.type_name);
      return {
        name: c.name,
        typeName: c.type_name,
        kind,
        stats: columnStats(
          used.map((r) => r[i] ?? null),
          kind,
        ),
      };
    }),
    omittedColumns: columns.length - shown.length,
    statsRows: used.length,
  };
}

const fmtNum = (n: number): string => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4))));

/** 1 列ぶんの統計行。`allowRowData` オフでは値を含む項目 (min/max/最頻値/合計/平均) を出さない。 */
export function columnStatsLine(col: SummaryColumn, allowRowData: boolean): string {
  const s = col.stats;
  const parts = [
    `rows=${s.count}`,
    `nulls=${s.nullCount} (${fmtNum(nullRatePercentOf(s))}%)`,
    `distinct=${s.distinctCount}`,
  ];
  if (s.minLen !== null && s.maxLen !== null) parts.push(`length=${s.minLen}..${s.maxLen}`);
  if (allowRowData) {
    if (s.numericCount > 0 && s.min !== null && s.max !== null) {
      parts.push(`min=${fmtNum(s.min)}`, `max=${fmtNum(s.max)}`);
      if (s.avg !== null) parts.push(`avg=${fmtNum(s.avg)}`);
      if (s.sum !== null) parts.push(`sum=${fmtNum(s.sum)}`);
    }
    if (s.mode) parts.push(`mode=${truncateCell(s.mode.value)} (x${s.mode.count})`);
  }
  return `- ${col.name} ${col.typeName} [${col.kind}]: ${parts.join(", ")}`;
}

export function buildResultSummarySystem(locale: "ja" | "en", allowRowData: boolean): string {
  const lang = locale === "ja" ? "Japanese" : "English";
  const lines = [
    "You are a data analyst helping a developer read the result of a SQL query.",
    `Write all text fields in ${lang}.`,
    "Answer only with the JSON object described by the schema.",
    "summary: one or two sentences on what the result is.",
    "trends: notable patterns or distributions visible in the data you were given.",
    "anomalies: outliers, suspicious values, heavy NULL columns, unexpected duplicates or anything else worth checking.",
    "next_queries: up to 5 follow-up READ-ONLY queries (SELECT / WITH ... SELECT) that dig into the findings. Each has a short title, the complete SQL for the given dialect, and the reason. Use only table and column names that appear in the query or the result columns; never invent names.",
    "Literal values in the SQL may be blanked out for privacy; use placeholders rather than guessing values.",
    "The result may be only the rows fetched so far, not the whole table. Do not claim facts about data you were not given.",
  ];
  lines.push(
    allowRowData
      ? "You are given column statistics and a small sample of the first rows. A sample is not the whole result; say so when a conclusion depends on it."
      : "You are given column names, types and value-free statistics only. No cell values were provided: do not state or guess any concrete value, and base trends and anomalies on counts, NULL rates and distinct counts.",
  );
  return lines.join("\n");
}

/** ユーザプロンプト全体。`allowRowData` オフのときセルの値は 1 つも含まない。 */
export function buildResultSummaryPrompt(input: ResultSummaryInput): string {
  const { columns, omittedColumns, statsRows } = summarizeColumns(input.columns, input.rows);
  const lines: string[] = [];
  lines.push(`Dialect: ${dialectLabel(input.driver)}`);
  lines.push("SQL:");
  lines.push(sqlForAi(input.sql, input.driver, input.maskLiterals));
  lines.push("");
  lines.push(
    `Result: ${input.rows.length} row(s) fetched, ${input.columns.length} column(s)` +
      (statsRows < input.rows.length ? `; statistics computed over the first ${statsRows} rows` : ""),
  );
  lines.push("Columns (name type [kind]: statistics):");
  for (const c of columns) lines.push(columnStatsLine(c, input.allowRowData));
  if (omittedColumns > 0) lines.push(`(${omittedColumns} more column(s) omitted)`);
  if (input.allowRowData && input.rows.length > 0) {
    const sample = input.rows.slice(0, RESULT_SUMMARY_MAX_ROWS);
    lines.push("");
    lines.push(
      `Sample rows (first ${sample.length} of ${input.rows.length}; cells longer than ${RESULT_SUMMARY_CELL_MAX_CHARS} chars are cut; JSON arrays in column order${omittedColumns > 0 ? ", omitted columns left out" : ""}):`,
    );
    for (const r of sample) {
      lines.push(JSON.stringify(columns.map((_, i) => truncateCell(r[i] ?? null))));
    }
  }
  return lines.join("\n");
}
