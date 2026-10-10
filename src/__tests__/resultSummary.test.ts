import { describe, expect, it } from "vitest";
import type { CellValue, Column } from "../api/tauri";
import {
  buildResultSummaryPrompt,
  buildResultSummarySystem,
  parseResultSummaryResponse,
  RESULT_SUMMARY_CELL_MAX_CHARS,
  RESULT_SUMMARY_MAX_COLUMNS,
  RESULT_SUMMARY_MAX_QUERIES,
  RESULT_SUMMARY_MAX_ROWS,
  truncateCell,
} from "../ai/resultSummary";

const columns: Column[] = [
  { name: "email", type_name: "VARCHAR" },
  { name: "amount", type_name: "INT" },
  { name: "note", type_name: "TEXT" },
];
const SECRETS = ["alice@secret.example", "bob@secret.example", "TOP-SECRET-NOTE", "987654321", "123456789"];
const rows: CellValue[][] = [
  ["alice@secret.example", 987654321, "TOP-SECRET-NOTE"],
  ["bob@secret.example", 123456789, null],
  ["alice@secret.example", 5, null],
];

const base = { driver: "mysql", sql: "SELECT email, amount, note FROM t", columns, rows, maskLiterals: true };

describe("buildResultSummaryPrompt (#1476)", () => {
  it("allowRowData オフ: セルの値も値由来の統計 (min/max/最頻値/合計/平均) も含まない", () => {
    const prompt = buildResultSummaryPrompt({ ...base, allowRowData: false });
    for (const s of SECRETS) expect(prompt).not.toContain(s);
    for (const key of ["min=", "max=", "avg=", "sum=", "mode=", "Sample rows"]) {
      expect(prompt).not.toContain(key);
    }
    // 列名・型・値を含まない統計は送る
    expect(prompt).toContain("- email VARCHAR [string]");
    expect(prompt).toContain("nulls=2 (66.6667%)");
    expect(prompt).toContain("distinct=2");
    expect(prompt).toContain("Dialect: MySQL");
    expect(prompt).toContain("SELECT email, amount, note FROM t");
  });

  it("allowRowData オフ: 1 行だけの結果でも値が漏れない", () => {
    const prompt = buildResultSummaryPrompt({ ...base, rows: [rows[0]], allowRowData: false });
    for (const s of SECRETS) expect(prompt).not.toContain(s);
  });

  it("allowRowData オフ: SQL のリテラルはマスク設定に従う", () => {
    const sql = "SELECT * FROM t WHERE email = 'alice@secret.example'";
    expect(buildResultSummaryPrompt({ ...base, sql, allowRowData: false })).not.toContain("alice@secret.example");
    expect(buildResultSummaryPrompt({ ...base, sql, allowRowData: false, maskLiterals: false })).toContain(
      "alice@secret.example",
    );
  });

  it("allowRowData オン: min/max などの統計と先頭行を含む", () => {
    const prompt = buildResultSummaryPrompt({ ...base, allowRowData: true });
    expect(prompt).toContain("max=987654321");
    expect(prompt).toContain("min=5");
    expect(prompt).toContain("Sample rows (first 3 of 3");
    expect(prompt).toContain('["alice@secret.example","987654321","TOP-SECRET-NOTE"]');
    expect(prompt).toContain('["bob@secret.example","123456789","NULL"]');
  });

  it("allowRowData オン: 行数は上限で切り、セルは長さを切り詰める", () => {
    const many: CellValue[][] = Array.from({ length: RESULT_SUMMARY_MAX_ROWS + 10 }, (_, i) => [
      `row${i}`,
      i,
      "x".repeat(RESULT_SUMMARY_CELL_MAX_CHARS + 50),
    ]);
    const prompt = buildResultSummaryPrompt({ ...base, rows: many, allowRowData: true });
    expect(prompt).toContain(`first ${RESULT_SUMMARY_MAX_ROWS} of ${many.length}`);
    expect(prompt).toContain(`row${RESULT_SUMMARY_MAX_ROWS - 1}"`);
    expect(prompt).not.toContain(`row${RESULT_SUMMARY_MAX_ROWS}"`);
    expect(prompt).not.toContain("x".repeat(RESULT_SUMMARY_CELL_MAX_CHARS + 1));
    expect(prompt).toContain(`${"x".repeat(RESULT_SUMMARY_CELL_MAX_CHARS)}…`);
  });

  it("列が多すぎるときは上限で切って省略を明記する (オンでも切った列の値は送らない)", () => {
    const wide: Column[] = Array.from({ length: RESULT_SUMMARY_MAX_COLUMNS + 3 }, (_, i) => ({
      name: `c${i}`,
      type_name: "INT",
    }));
    const wideRows: CellValue[][] = [wide.map((_, i) => (i >= RESULT_SUMMARY_MAX_COLUMNS ? 424242 : i))];
    const prompt = buildResultSummaryPrompt({ ...base, columns: wide, rows: wideRows, allowRowData: true });
    expect(prompt).toContain("(3 more column(s) omitted)");
    expect(prompt).not.toContain("424242");
    expect(prompt).not.toContain("c60 ");
  });

  it("0 行でも組み立てられる", () => {
    const prompt = buildResultSummaryPrompt({ ...base, rows: [], allowRowData: true });
    expect(prompt).toContain("Result: 0 row(s) fetched");
    expect(prompt).not.toContain("Sample rows");
  });

  it("system プロンプトは allowRowData で値を出さない指示が変わる", () => {
    expect(buildResultSummarySystem("en", false)).toContain("No cell values were provided");
    expect(buildResultSummarySystem("en", true)).toContain("small sample");
    expect(buildResultSummarySystem("ja", true)).toContain("Japanese");
  });
});

describe("truncateCell", () => {
  it("NULL・改行・長さ", () => {
    expect(truncateCell(null)).toBe("NULL");
    expect(truncateCell("a\nb  c")).toBe("a b c");
    expect(truncateCell("abcdef", 3)).toBe("abc…");
    expect(truncateCell(12)).toBe("12");
  });
});

describe("parseResultSummaryResponse", () => {
  const ok = {
    summary: "S",
    trends: ["T"],
    anomalies: ["A"],
    next_queries: [
      { title: "q1", sql: "SELECT 1", reason: "r" },
      { title: "empty", sql: "  ", reason: "r" },
      { title: "write", sql: "DELETE FROM t", reason: "r" },
    ],
  };

  it("JSON を解釈し、空 SQL と書き込み系の SQL 案を落とす", () => {
    const r = parseResultSummaryResponse(JSON.stringify(ok), "mysql");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.next_queries.map((q) => q.title)).toEqual(["q1"]);
  });

  it("コードフェンスで囲まれていても受け付ける", () => {
    expect(parseResultSummaryResponse("```json\n" + JSON.stringify(ok) + "\n```", "mysql").ok).toBe(true);
  });

  it("SQL 案は上限件数に切り詰める", () => {
    const many = {
      ...ok,
      next_queries: Array.from({ length: RESULT_SUMMARY_MAX_QUERIES + 3 }, (_, i) => ({
        title: `q${i}`,
        sql: "SELECT 1",
        reason: "r",
      })),
    };
    const r = parseResultSummaryResponse(JSON.stringify(many), "postgres");
    if (r.ok) expect(r.value.next_queries).toHaveLength(RESULT_SUMMARY_MAX_QUERIES);
  });

  it("壊れた JSON / 形の違う JSON は本文をそのまま返す", () => {
    expect(parseResultSummaryResponse("nope")).toEqual({ ok: false, raw: "nope" });
    expect(parseResultSummaryResponse('{"summary":1}').ok).toBe(false);
  });
});
