import { describe, expect, it } from "vitest";
import type { QueryResult } from "../api/tauri";
import { buildScanPlan, scanTone, summarizeScan, SCAN_SMALL_TABLE_ROWS } from "../components/scanPreflight";

// 実機 (MySQL 8.0 / PostgreSQL 16 / SQLite 3.45) の EXPLAIN 出力を元にした入力。

function cellResult(json: unknown): QueryResult {
  return {
    columns: [{ name: "EXPLAIN", type_name: "" }],
    rows: [[JSON.stringify(json)]],
    rows_affected: null,
  } as unknown as QueryResult;
}

function sqliteResult(details: string[]): QueryResult {
  return {
    columns: ["id", "parent", "notused", "detail"].map((name) => ({ name, type_name: "" })),
    rows: details.map((d, i) => [i + 2, 0, 0, d]),
    rows_affected: null,
  } as unknown as QueryResult;
}

const mysqlTable = (name: string, access: string, rows: number) => ({
  table: { table_name: name, access_type: access, rows_examined_per_scan: rows, filtered: "10.00" },
});

describe("buildScanPlan", () => {
  it("単純な SELECT は EXPLAIN 文を組み立てる (方言別プレフィックス)", () => {
    expect(buildScanPlan("SELECT * FROM t WHERE a = 1;", "mysql")?.explainSql).toBe(
      "EXPLAIN FORMAT=JSON SELECT * FROM t WHERE a = 1;",
    );
    expect(buildScanPlan("select * from t", "postgres")?.explainSql).toBe(
      "EXPLAIN (FORMAT JSON) select * from t",
    );
    expect(buildScanPlan("  select * from t  ", "sqlite")?.explainSql).toBe(
      "EXPLAIN QUERY PLAN select * from t",
    );
  });

  it("JOIN / ORDER BY / LIMIT 付きの単一 SELECT も対象", () => {
    expect(
      buildScanPlan("SELECT * FROM a JOIN b ON a.id = b.aid ORDER BY a.id LIMIT 5", "mysql")?.explainSql,
    ).not.toBeNull();
  });

  it("SELECT 以外・空・複数文・FROM なしは null (バッジを出さない)", () => {
    expect(buildScanPlan("", "mysql")).toBeNull();
    expect(buildScanPlan("UPDATE t SET a = 1", "mysql")).toBeNull();
    expect(buildScanPlan("DELETE FROM t", "mysql")).toBeNull();
    expect(buildScanPlan("EXPLAIN SELECT * FROM t", "mysql")).toBeNull();
    expect(buildScanPlan("SELECT * FROM a; SELECT * FROM b", "mysql")).toBeNull();
    expect(buildScanPlan("SELECT 1", "postgres")).toBeNull();
    expect(buildScanPlan("WITH x AS (SELECT 1) SELECT * FROM x", "postgres")).toBeNull();
  });

  it("文字列・コメント内の ; や キーワードに惑わされない", () => {
    expect(
      buildScanPlan("SELECT * FROM t WHERE a = 'x; y' -- ; union\n", "mysql")?.explainSql,
    ).not.toBeNull();
    expect(buildScanPlan("SELECT 'union' AS u FROM t", "mysql")?.explainSql).not.toBeNull();
    expect(buildScanPlan("SELECT `for` FROM t", "mysql")?.explainSql).not.toBeNull();
  });

  it("INTO・ロック句付きは対象外", () => {
    expect(buildScanPlan("SELECT * INTO OUTFILE '/tmp/x' FROM t", "mysql")).toBeNull();
    expect(buildScanPlan("SELECT * FROM t FOR UPDATE", "postgres")).toBeNull();
    expect(buildScanPlan("SELECT * FROM t LOCK IN SHARE MODE", "mysql")).toBeNull();
  });

  it("集合演算とサブクエリは推定不可に降格 (explainSql: null)", () => {
    expect(buildScanPlan("SELECT a FROM x UNION SELECT a FROM y", "mysql")).toEqual({ explainSql: null });
    expect(buildScanPlan("SELECT a FROM x EXCEPT SELECT a FROM y", "postgres")).toEqual({ explainSql: null });
    expect(buildScanPlan("SELECT * FROM t WHERE id IN (SELECT id FROM u)", "mysql")).toEqual({
      explainSql: null,
    });
    expect(buildScanPlan("SELECT * FROM (SELECT * FROM u) s", "sqlite")).toEqual({ explainSql: null });
  });

  it("巨大な SQL は対象外", () => {
    expect(buildScanPlan(`SELECT * FROM t WHERE a = '${"x".repeat(70_000)}'`, "mysql")).toBeNull();
  });
});

describe("summarizeScan: MySQL", () => {
  it("access_type=ALL は全表スキャン + 走査行数", () => {
    const s = summarizeScan(
      "mysql",
      cellResult({ query_block: { select_id: 1, ...mysqlTable("big", "ALL", 19177) } }),
    );
    expect(s).toEqual({ fullScan: true, fullScanTables: ["big"], scanRows: 19177, scanNodes: 1 });
  });

  it("主キー参照 (const) は全表スキャンではない", () => {
    const s = summarizeScan(
      "mysql",
      cellResult({ query_block: { select_id: 1, ...mysqlTable("big", "const", 1) } }),
    );
    expect(s).toEqual({ fullScan: false, fullScanTables: [], scanRows: 1, scanNodes: 1 });
  });

  it("JOIN は走査ノードの最大行数を採り、ALL のテーブルだけ全表スキャン", () => {
    const s = summarizeScan(
      "mysql",
      cellResult({
        query_block: {
          select_id: 1,
          nested_loop: [mysqlTable("b", "ALL", 19177), mysqlTable("a", "eq_ref", 1)],
        },
      }),
    );
    expect(s).toEqual({ fullScan: true, fullScanTables: ["b"], scanRows: 19177, scanNodes: 2 });
  });

  it("テーブルを読まないプラン (no tables used) は null", () => {
    expect(
      summarizeScan("mysql", cellResult({ query_block: { select_id: 1, message: "No tables used" } })),
    ).toBeNull();
  });
});

describe("summarizeScan: PostgreSQL", () => {
  it("フィルタ無し Seq Scan は全表スキャン + Plan Rows", () => {
    const s = summarizeScan(
      "postgres",
      cellResult([{ Plan: { "Node Type": "Seq Scan", "Relation Name": "big", "Plan Rows": 50000 } }]),
    );
    expect(s).toEqual({ fullScan: true, fullScanTables: ["big"], scanRows: 50000, scanNodes: 1 });
  });

  it("Filter 付き Seq Scan は行数を採らない (Plan Rows は出力行数で過小になる)", () => {
    const s = summarizeScan(
      "postgres",
      cellResult([
        {
          Plan: {
            "Node Type": "Seq Scan",
            "Relation Name": "big",
            "Plan Rows": 1,
            Filter: "(v = 'x5'::text)",
          },
        },
      ]),
    );
    expect(s).toEqual({ fullScan: true, fullScanTables: ["big"], scanRows: null, scanNodes: 1 });
  });

  it("Index Scan は全表スキャンではない", () => {
    const s = summarizeScan(
      "postgres",
      cellResult([{ Plan: { "Node Type": "Index Scan", "Relation Name": "ix", "Plan Rows": 1 } }]),
    );
    expect(s).toEqual({ fullScan: false, fullScanTables: [], scanRows: 1, scanNodes: 1 });
  });

  it("Hash Join の下の Seq Scan を再帰的に拾い最大行数を採る", () => {
    const s = summarizeScan(
      "postgres",
      cellResult([
        {
          Plan: {
            "Node Type": "Hash Join",
            "Plan Rows": 50000,
            Plans: [
              { "Node Type": "Seq Scan", "Relation Name": "big", "Plan Rows": 50000 },
              {
                "Node Type": "Hash",
                "Plan Rows": 100,
                Plans: [{ "Node Type": "Seq Scan", "Relation Name": "small", "Plan Rows": 100 }],
              },
            ],
          },
        },
      ]),
    );
    expect(s).toEqual({ fullScan: true, fullScanTables: ["big", "small"], scanRows: 50000, scanNodes: 2 });
  });

  it("CTE / Subquery Scan は実テーブルの走査として数えない", () => {
    const s = summarizeScan(
      "postgres",
      cellResult([{ Plan: { "Node Type": "Subquery Scan", "Plan Rows": 5 } }]),
    );
    expect(s).toBeNull();
  });
});

describe("summarizeScan: SQLite", () => {
  it("SCAN t (インデックス指定なし) は全表スキャン、行数は不明", () => {
    expect(summarizeScan("sqlite", sqliteResult(["SCAN t"]))).toEqual({
      fullScan: true,
      fullScanTables: ["t"],
      scanRows: null,
      scanNodes: 1,
    });
    expect(summarizeScan("sqlite", sqliteResult(["SCAN TABLE t"]))?.fullScanTables).toEqual(["t"]);
  });

  it("SEARCH ... USING INDEX は全表スキャンではない", () => {
    expect(summarizeScan("sqlite", sqliteResult(["SEARCH t USING INTEGER PRIMARY KEY (rowid=?)"]))).toEqual({
      fullScan: false,
      fullScanTables: [],
      scanRows: null,
      scanNodes: 1,
    });
  });

  it("SCAN ... USING COVERING INDEX は全表スキャン扱いしない", () => {
    expect(summarizeScan("sqlite", sqliteResult(["SCAN u USING COVERING INDEX ux"]))?.fullScan).toBe(false);
  });

  it("JOIN: 片方 SCAN・片方 SEARCH なら SCAN 側だけ全表スキャン", () => {
    const s = summarizeScan(
      "sqlite",
      sqliteResult(["SCAN u", "SEARCH t USING INTEGER PRIMARY KEY (rowid=?)"]),
    );
    expect(s).toEqual({ fullScan: true, fullScanTables: ["u"], scanRows: null, scanNodes: 2 });
  });

  it("SCAN CONSTANT ROW や空の結果は null", () => {
    expect(summarizeScan("sqlite", sqliteResult(["SCAN CONSTANT ROW"]))).toBeNull();
    expect(
      summarizeScan("sqlite", { columns: [], rows: [], rows_affected: null } as unknown as QueryResult),
    ).toBeNull();
  });
});

describe("summarizeScan: 不正入力", () => {
  it("JSON として読めない出力は null", () => {
    const bad = { columns: [], rows: [["not json"]], rows_affected: null } as unknown as QueryResult;
    expect(summarizeScan("mysql", bad)).toBeNull();
    expect(summarizeScan("postgres", null)).toBeNull();
  });
});

describe("scanTone", () => {
  const base = { fullScanTables: [], scanNodes: 1 };
  it("行数と全表スキャンで段階表示する", () => {
    expect(scanTone({ ...base, fullScan: false, scanRows: 1 })).toBe("neutral");
    expect(scanTone({ ...base, fullScan: false, scanRows: null })).toBe("neutral");
    expect(scanTone({ ...base, fullScan: true, scanRows: SCAN_SMALL_TABLE_ROWS - 1 })).toBe("neutral");
    expect(scanTone({ ...base, fullScan: true, scanRows: SCAN_SMALL_TABLE_ROWS })).toBe("warning");
    expect(scanTone({ ...base, fullScan: true, scanRows: null })).toBe("warning");
    expect(scanTone({ ...base, fullScan: false, scanRows: 100_000 })).toBe("warning");
    expect(scanTone({ ...base, fullScan: true, scanRows: 1_000_000 })).toBe("danger");
  });
});
