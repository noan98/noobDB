import { describe, expect, it } from "vitest";
import { buildCteRun } from "../cteRun";
import { collectCteRuns, cteBadge, sameCteRuns, type CteRunTabLike } from "../cteRunBadge";

const tab = (over: Partial<CteRunTabLike> = {}): CteRunTabLike => ({
  kind: "query",
  title: "CTE: a",
  lastExecutedSql: "WITH a AS (SELECT 1)\nSELECT * FROM a",
  streaming: false,
  queryError: null,
  result: { rows: [[1], [2], [3]] },
  ...over,
});

describe("collectCteRuns (#2450)", () => {
  it("CTE 単体実行の完了済みタブだけを名前・SQL・行数で集める", () => {
    expect(collectCteRuns([tab()])).toEqual([
      { name: "a", sql: "WITH a AS (SELECT 1)\nSELECT * FROM a", rows: 3 },
    ]);
  });

  it("実行中・エラー・結果なし・別種のタブ・WITH でない SQL は除く", () => {
    expect(
      collectCteRuns([
        tab({ streaming: true }),
        tab({ queryError: "boom" }),
        tab({ result: null }),
        tab({ kind: "table" }),
        tab({ title: "Query 1" }),
        tab({ lastExecutedSql: "SELECT 1" }),
        tab({ lastExecutedSql: null }),
        tab({ title: "CTE: " }),
      ]),
    ).toEqual([]);
  });

  it("sameCteRuns は中身が同じなら true", () => {
    const a = collectCteRuns([tab()]);
    expect(sameCteRuns(a, collectCteRuns([tab()]))).toBe(true);
    expect(sameCteRuns(a, collectCteRuns([tab({ result: { rows: [] } })]))).toBe(false);
  });
});

describe("cteBadge (#2450)", () => {
  const runs = [
    { name: "a", sql: "SQL-1", rows: 5 },
    { name: "A", sql: "SQL-2", rows: 9 },
    { name: "b", sql: "SQL-B", rows: 0 },
  ];

  it("一度も実行していなければ null", () => {
    expect(cteBadge(runs, "c", "x")).toBeNull();
    expect(cteBadge([], "a", "x")).toBeNull();
  });

  it("実行した SQL と一致すれば最新 (行数 0 も表示対象)", () => {
    expect(cteBadge(runs, "b", "SQL-B")).toEqual({ rows: 0, stale: false });
  });

  it("同名 (大文字小文字違い含む) は最後の実行を採る", () => {
    expect(cteBadge(runs, "a", "SQL-2")).toEqual({ rows: 9, stale: false });
    expect(cteBadge(runs, "a", "SQL-1")).toEqual({ rows: 9, stale: true });
  });

  it("SQL が変わった (編集された) か、いま組み立てられない (null) なら stale", () => {
    expect(cteBadge(runs, "b", "SQL-B edited")).toEqual({ rows: 0, stale: true });
    expect(cteBadge(runs, "b", null)).toEqual({ rows: 0, stale: true });
  });

  it("実際の buildCteRun の SQL で、CTE の本文を編集すると stale、空白だけの末尾編集では最新のまま", () => {
    const base = "WITH a AS (SELECT 1 AS n) SELECT * FROM a";
    const plan = (text: string, offset: number) => {
      const p = buildCteRun({ text, offset, driver: "postgres" });
      return p.ok ? p.sql : null;
    };
    const ran = [{ name: "a", sql: plan(base, 16) as string, rows: 1 }];
    expect(cteBadge(ran, "a", plan(base, 16))).toEqual({ rows: 1, stale: false });
    // 本文外 (最終 SELECT) の編集は CTE の SQL に影響しない。
    const outer = `${base} WHERE n > 0`;
    expect(cteBadge(ran, "a", plan(outer, 16))).toEqual({ rows: 1, stale: false });
    // CTE の本文を編集すると食い違う。
    const edited = "WITH a AS (SELECT 2 AS n) SELECT * FROM a";
    expect(cteBadge(ran, "a", plan(edited, 16))).toEqual({ rows: 1, stale: true });
  });
});
