import { describe, expect, it } from "vitest";
import {
  buildExplainAnalyzeSql,
  explainAnalyzePrefix,
  explainAnalyzeSupported,
} from "../components/explainAnalyze";
import { bundleExplainPrefix } from "../components/investigationBundle";
import {
  actualTotalMs,
  computeHints,
  formatDurationMs,
  hasActual,
  misestimateLevel,
  misestimateRatio,
  nodeMisestimate,
  parseExplainForDriver,
  parseMysqlAnalyzeText,
  parsePostgresPlan,
} from "../components/explainPlan";
import type { QueryResult } from "../api/tauri";

function cellResult(text: string): QueryResult {
  return { columns: [{ name: "EXPLAIN", type_name: "TEXT" }], rows: [[text]], rows_affected: 0, elapsed_ms: 0 } as unknown as QueryResult;
}

describe("実測モードのプレフィックスと対応ドライバ (#1164)", () => {
  it("PostgreSQL / MySQL だけが対応し、SQLite は非対応", () => {
    expect(explainAnalyzeSupported("postgres")).toBe(true);
    expect(explainAnalyzeSupported("mysql")).toBe(true);
    expect(explainAnalyzeSupported("sqlite")).toBe(false);
    expect(explainAnalyzeSupported(null)).toBe(false);
    expect(explainAnalyzeSupported(undefined)).toBe(false);
  });

  it("方言別のプレフィックス", () => {
    expect(explainAnalyzePrefix("postgres")).toBe("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ");
    expect(explainAnalyzePrefix("mysql")).toBe("EXPLAIN ANALYZE ");
    expect(explainAnalyzePrefix("sqlite")).toBeNull();
  });

  it("推定 EXPLAIN のプレフィックスは不変", () => {
    expect(bundleExplainPrefix("postgres")).toBe("EXPLAIN (FORMAT JSON) ");
    expect(bundleExplainPrefix("mysql")).toBe("EXPLAIN FORMAT=JSON ");
    expect(bundleExplainPrefix("sqlite")).toBe("EXPLAIN QUERY PLAN ");
  });
});

describe("buildExplainAnalyzeSql の安全網 (#1164)", () => {
  it("読み取り SQL はプレフィックスを付けて返す", () => {
    expect(buildExplainAnalyzeSql("postgres", "SELECT * FROM t")).toEqual({
      ok: true,
      sql: "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM t",
    });
    expect(buildExplainAnalyzeSql("mysql", "WITH c AS (SELECT 1) SELECT * FROM c")).toEqual({
      ok: true,
      sql: "EXPLAIN ANALYZE WITH c AS (SELECT 1) SELECT * FROM c",
    });
  });

  it.each([
    "DELETE FROM t",
    "UPDATE t SET a = 1",
    "INSERT INTO t VALUES (1)",
    "DROP TABLE t",
    "SELECT 1; DELETE FROM t",
    "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d",
    "SELECT * FROM t FOR UPDATE",
    "SELECT * INTO backup FROM t",
  ])("書き込み・危険 SQL は拒否する: %s", (sql) => {
    for (const driver of ["postgres", "mysql"]) {
      expect(buildExplainAnalyzeSql(driver, sql)).toEqual({ ok: false, reason: "notReadOnly" });
    }
  });

  it("SQLite は非対応、空 SQL は empty", () => {
    expect(buildExplainAnalyzeSql("sqlite", "SELECT 1")).toEqual({ ok: false, reason: "unsupported" });
    expect(buildExplainAnalyzeSql("mysql", "   ")).toEqual({ ok: false, reason: "empty" });
  });
});

describe("PostgreSQL EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) のパース", () => {
  const json = JSON.stringify([
    {
      Plan: {
        "Node Type": "Nested Loop",
        "Total Cost": 100,
        "Plan Rows": 10,
        "Actual Rows": 5000,
        "Actual Loops": 1,
        "Actual Startup Time": 0.1,
        "Actual Total Time": 12.5,
        "Shared Hit Blocks": 30,
        "Shared Read Blocks": 4,
        Plans: [
          {
            "Node Type": "Seq Scan",
            "Relation Name": "users",
            "Total Cost": 40,
            "Plan Rows": 100,
            "Actual Rows": 100,
            "Actual Loops": 1,
            "Actual Startup Time": 0.01,
            "Actual Total Time": 1.5,
          },
          {
            "Node Type": "Index Scan",
            "Index Name": "orders_pkey",
            "Total Cost": 0.5,
            "Plan Rows": 1,
            "Actual Rows": 50,
            "Actual Loops": 100,
            "Actual Startup Time": 0.002,
            "Actual Total Time": 0.05,
          },
        ],
      },
      "Execution Time": 13,
    },
  ]);

  it("推定行数・実測行数・ループ・時間・バッファを取り出す", () => {
    const { root, error } = parsePostgresPlan(json);
    expect(error).toBeNull();
    expect(root!.actual).toEqual({
      estRows: 10,
      rows: 5000,
      loops: 1,
      startupMs: 0.1,
      totalMs: 12.5,
      buffers: { sharedHit: 30, sharedRead: 4, sharedDirtied: null, sharedWritten: null },
    });
    expect(hasActual(root)).toBe(true);
    expect(root!.children[1].actual?.loops).toBe(100);
    // ノード全体の実時間 = 1 ループあたり × ループ回数。
    expect(actualTotalMs(root!.children[1])).toBeCloseTo(5);
  });

  it("乖離が大きいノードを warm / hot に分類し、ヒントを出す", () => {
    const { root } = parsePostgresPlan(json);
    // 10 → 5000 (500 倍): hot
    expect(nodeMisestimate(root!).level).toBe("hot");
    expect(computeHints(root!).some((h) => h.key === "explainHintMisestimate" && h.severity === "warning")).toBe(true);
    // 100 → 100: 乖離なし
    expect(nodeMisestimate(root!.children[0]).level).toBe("");
    // 1 → 50 (50 倍): warm
    expect(nodeMisestimate(root!.children[1]).level).toBe("warm");
    expect(computeHints(root!.children[1]).some((h) => h.key === "explainHintMisestimate" && h.severity === "caution")).toBe(true);
  });

  it("推定 EXPLAIN (Actual 無し) は actual を持たず、ヒントも変わらない", () => {
    const est = JSON.stringify([{ Plan: { "Node Type": "Seq Scan", "Total Cost": 10, "Plan Rows": 5 } }]);
    const { root } = parsePostgresPlan(est);
    expect(root!.actual).toBeUndefined();
    expect(hasActual(root)).toBe(false);
    expect(computeHints(root!).map((h) => h.key)).toEqual(["explainHintFullScan"]);
  });
});

describe("MySQL EXPLAIN ANALYZE (テキストツリー) のパース", () => {
  const text = [
    "-> Nested loop inner join  (cost=1.1 rows=2) (actual time=0.05..0.07 rows=2000 loops=1)",
    "    -> Table scan on a  (cost=0.35 rows=2) (actual time=0.02..0.03 rows=2 loops=1)",
    "    -> Single-row index lookup on b using PRIMARY (id=a.id)  (cost=0.25 rows=1) (actual time=0.01..0.01 rows=1 loops=2)",
    "        -> Filter: (b.x > 1)  (cost=0.1 rows=1) (never executed)",
    "",
  ].join("\n");

  it("インデントから木を組み、cost / rows / actual を取り出す", () => {
    const { root, error } = parseMysqlAnalyzeText(text);
    expect(error).toBeNull();
    expect(root!.id).toBe("plan");
    expect(root!.label).toBe("Nested loop inner join");
    expect(root!.cost).toBe(1.1);
    expect(root!.actual).toMatchObject({ estRows: 2, rows: 2000, loops: 1, startupMs: 0.05, totalMs: 0.07 });
    expect(root!.children.map((c) => c.label)).toEqual([
      "Table scan on a",
      "Single-row index lookup on b using PRIMARY (id=a.id)",
    ]);
    expect(root!.children[0].id).toBe("plan/0");
    expect(root!.children[1].actual?.loops).toBe(2);
    expect(root!.children[1].children).toHaveLength(1);
    expect(root!.children[1].children[0].id).toBe("plan/1/0");
  });

  it("never executed は loops 0 で実測行数なし", () => {
    const { root } = parseMysqlAnalyzeText(text);
    const never = root!.children[1].children[0];
    expect(never.actual).toMatchObject({ rows: null, loops: 0 });
    expect(nodeMisestimate(never).level).toBe("");
  });

  it("乖離ノードとフルスキャンのヒント", () => {
    const { root } = parseMysqlAnalyzeText(text);
    expect(nodeMisestimate(root!).level).toBe("hot"); // 2 → 2000
    const keys = computeHints(root!.children[0]).map((h) => h.key);
    expect(keys).toContain("explainHintFullScan");
  });

  it("複数ルートは合成ルートでまとめ、`->` の無い行は直前ノードへ連結する", () => {
    const { root } = parseMysqlAnalyzeText(
      "-> Select #1  (cost=1 rows=1) (actual time=0..0 rows=1 loops=1)\n-> Filter: (a\n   AND b)  (cost=1 rows=1) (actual time=0..0 rows=1 loops=1)",
    );
    expect(root!.kind).toBe("queryPlan");
    expect(root!.children).toHaveLength(2);
    expect(root!.children[1].label).toBe("Filter: (a AND b)");
  });

  it("空・非ツリーはエラー", () => {
    expect(parseMysqlAnalyzeText("").error).not.toBeNull();
  });

  it("parseExplainForDriver は MySQL のテキストを自動判別し、JSON は従来どおり", () => {
    const analyzed = parseExplainForDriver("mysql", cellResult(text));
    expect(analyzed.error).toBeNull();
    expect(hasActual(analyzed.root)).toBe(true);
    const est = parseExplainForDriver(
      "mysql",
      cellResult(JSON.stringify({ query_block: { select_id: 1, cost_info: { query_cost: "1.00" } } })),
    );
    expect(est.root!.kind).toBe("query_block");
    expect(hasActual(est.root)).toBe(false);
  });
});

describe("乖離倍率と整形", () => {
  it("両辺を 1 行未満は 1 に切り上げて大きい方 / 小さい方", () => {
    expect(misestimateRatio(10, 10)).toBe(1);
    expect(misestimateRatio(1, 100)).toBe(100);
    expect(misestimateRatio(100, 1)).toBe(100);
    expect(misestimateRatio(0.4, 0)).toBe(1);
    expect(misestimateRatio(null, 5)).toBeNull();
    expect(misestimateRatio(5, null)).toBeNull();
  });

  it("しきい値は 10 倍 / 100 倍", () => {
    expect(misestimateLevel(9.99)).toBe("");
    expect(misestimateLevel(10)).toBe("warm");
    expect(misestimateLevel(99.9)).toBe("warm");
    expect(misestimateLevel(100)).toBe("hot");
    expect(misestimateLevel(null)).toBe("");
  });

  it("時間の整形", () => {
    expect(formatDurationMs(0.123)).toBe("0.12 ms");
    expect(formatDurationMs(12.5)).toBe("12.5 ms");
    expect(formatDurationMs(2500)).toMatch(/^2[.,]5 s$/);
  });
});
