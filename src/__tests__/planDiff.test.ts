import { describe, expect, it } from "vitest";
import type { QueryResult } from "../api/tauri";
import { parseExplainForDriver } from "../components/explainPlan";
import {
  comparePlans,
  isFullScanAccess,
  normalizePlan,
  opsFromSnapshot,
  planFingerprint,
  resultFromSnapshot,
  rowsMagnitude,
  snapshotFromResult,
  type PlanOp,
} from "../components/planDiff";

// --- フィクスチャ (3 方言) ---------------------------------------------------

/** MySQL `EXPLAIN FORMAT=JSON`: users を ref (ix_user) で、orders を ALL で読む結合。 */
function mysqlPlanJson(opts?: {
  usersAccess?: string;
  usersKey?: string | null;
  usersRows?: number;
  ordersJoinBuffer?: string;
}): string {
  const usersTable: Record<string, unknown> = {
    table_name: "users",
    access_type: opts?.usersAccess ?? "ref",
    rows_examined_per_scan: opts?.usersRows ?? 100,
    cost_info: { prefix_cost: "10.5" },
  };
  const key = opts?.usersKey === undefined ? "ix_user" : opts.usersKey;
  if (key !== null) usersTable.key = key;
  const ordersTable: Record<string, unknown> = {
    table_name: "orders",
    access_type: "ALL",
    rows_examined_per_scan: 5000,
    cost_info: { prefix_cost: "510.0" },
  };
  if (opts?.ordersJoinBuffer) ordersTable.using_join_buffer = opts.ordersJoinBuffer;
  return JSON.stringify({
    query_block: {
      select_id: 1,
      cost_info: { query_cost: "520.5" },
      nested_loop: [{ table: usersTable }, { table: ordersTable }],
    },
  });
}

/** PostgreSQL `EXPLAIN (FORMAT JSON)`: join ノード配下に 2 つのスキャン。 */
function pgPlanJson(opts?: {
  joinType?: string;
  scanType?: string;
  indexName?: string;
  scanRows?: number;
}): string {
  const scan: Record<string, unknown> = {
    "Node Type": opts?.scanType ?? "Index Scan",
    "Relation Name": "orders",
    "Total Cost": 120.0,
    "Plan Rows": opts?.scanRows ?? 300,
  };
  if (opts?.scanType !== "Seq Scan") scan["Index Name"] = opts?.indexName ?? "ix_orders_user";
  return JSON.stringify([
    {
      Plan: {
        "Node Type": opts?.joinType ?? "Nested Loop",
        "Total Cost": 300.0,
        "Plan Rows": 300,
        Plans: [
          {
            "Node Type": "Seq Scan",
            "Relation Name": "users",
            "Total Cost": 80.0,
            "Plan Rows": 1000,
          },
          scan,
        ],
      },
    },
  ]);
}

function mysqlResult(json: string): QueryResult {
  return {
    columns: [{ name: "EXPLAIN", type_name: "JSON" }],
    rows: [[json]],
    rows_affected: 0,
    elapsed_ms: 1,
  };
}

function sqliteResult(rows: [number, number, number, string][]): QueryResult {
  return {
    columns: ["id", "parent", "notused", "detail"].map((name) => ({ name, type_name: "" })),
    rows: rows.map((r) => [...r]),
    rows_affected: 0,
    elapsed_ms: 1,
  };
}

function opsFor(driver: string, result: QueryResult): PlanOp[] {
  const { root } = parseExplainForDriver(driver, result);
  return normalizePlan(root, driver);
}

// --- 正規化 ------------------------------------------------------------------

describe("normalizePlan (mysql)", () => {
  it("extracts table access, index and row estimates", () => {
    const ops = opsFor("mysql", mysqlResult(mysqlPlanJson()));
    const users = ops.find((o) => o.object === "users")!;
    expect(users.access).toBe("ref");
    expect(users.index).toBe("ix_user");
    expect(users.estRows).toBe(100);
    const orders = ops.find((o) => o.object === "orders")!;
    expect(orders.access).toBe("ALL");
    expect(orders.index).toBeNull();
  });

  it("marks the nested_loop wrapper as a join op and hash join via join buffer", () => {
    const ops = opsFor(
      "mysql",
      mysqlResult(mysqlPlanJson({ ordersJoinBuffer: "hash join" })),
    );
    expect(ops.some((o) => o.kind === "nested_loop" && o.join === "nested loop")).toBe(true);
    const orders = ops.find((o) => o.object === "orders")!;
    expect(orders.join).toBe("hash join");
  });

  it("returns an empty list for a null root", () => {
    expect(normalizePlan(null, "mysql")).toEqual([]);
  });
});

describe("normalizePlan (postgres)", () => {
  it("extracts scans, join method and row estimates", () => {
    const ops = opsFor("postgres", mysqlResult(pgPlanJson()));
    expect(ops[0].join).toBe("nested loop");
    const users = ops.find((o) => o.object === "users")!;
    expect(users.access).toBe("Seq Scan");
    expect(users.estRows).toBe(1000);
    const orders = ops.find((o) => o.object === "orders")!;
    expect(orders.access).toBe("Index Scan");
    expect(orders.index).toBe("ix_orders_user");
  });
});

describe("normalizePlan (sqlite)", () => {
  it("parses SCAN / SEARCH detail lines", () => {
    const ops = opsFor(
      "sqlite",
      sqliteResult([
        [2, 0, 0, "SCAN users"],
        [3, 0, 0, "SEARCH orders USING INDEX ix_user (user_id=?)"],
        [4, 0, 0, "SEARCH items USING COVERING INDEX ix_cov (a=?)"],
        [5, 0, 0, "SEARCH t USING INTEGER PRIMARY KEY (rowid=?)"],
      ]),
    );
    const scans = ops.filter((o) => o.object !== null);
    expect(scans.map((o) => [o.object, o.access, o.index])).toEqual([
      ["users", "SCAN", null],
      ["orders", "SEARCH USING INDEX", "ix_user"],
      ["items", "SEARCH USING COVERING INDEX", "ix_cov"],
      ["t", "SEARCH USING INTEGER PRIMARY KEY", null],
    ]);
  });
});

describe("isFullScanAccess / rowsMagnitude", () => {
  it("recognizes full scans across dialects", () => {
    expect(isFullScanAccess("ALL")).toBe(true);
    expect(isFullScanAccess("Seq Scan")).toBe(true);
    expect(isFullScanAccess("SCAN")).toBe(true);
    expect(isFullScanAccess("ref")).toBe(false);
    expect(isFullScanAccess("Index Scan")).toBe(false);
    expect(isFullScanAccess("SEARCH USING INDEX")).toBe(false);
    expect(isFullScanAccess(null)).toBe(false);
  });

  it("buckets estimates by order of magnitude", () => {
    expect(rowsMagnitude(null)).toBeNull();
    expect(rowsMagnitude(0)).toBe(0);
    expect(rowsMagnitude(9)).toBe(0);
    expect(rowsMagnitude(10)).toBe(1);
    expect(rowsMagnitude(99_999)).toBe(4);
  });
});

// --- フィンガープリント (dedupe) ----------------------------------------------

describe("planFingerprint", () => {
  it("is stable for the same plan and ignores cost-only fluctuations", () => {
    const a = opsFor("mysql", mysqlResult(mysqlPlanJson({ usersRows: 100 })));
    const b = opsFor("mysql", mysqlResult(mysqlPlanJson({ usersRows: 120 })));
    // 100 → 120 は同じ桁なのでフィンガープリントは変わらない (世代を増やさない)。
    expect(planFingerprint(a)).toBe(planFingerprint(b));
  });

  it("changes when the access method changes", () => {
    const a = opsFor("mysql", mysqlResult(mysqlPlanJson()));
    const b = opsFor(
      "mysql",
      mysqlResult(mysqlPlanJson({ usersAccess: "ALL", usersKey: null })),
    );
    expect(planFingerprint(a)).not.toBe(planFingerprint(b));
  });

  it("changes when the row estimate jumps an order of magnitude", () => {
    const a = opsFor("mysql", mysqlResult(mysqlPlanJson({ usersRows: 100 })));
    const b = opsFor("mysql", mysqlResult(mysqlPlanJson({ usersRows: 100_000 })));
    expect(planFingerprint(a)).not.toBe(planFingerprint(b));
  });
});

// --- 比較 (変化検知) -----------------------------------------------------------

describe("comparePlans", () => {
  it("reports nothing for identical plans", () => {
    const ops = opsFor("mysql", mysqlResult(mysqlPlanJson()));
    const cmp = comparePlans(ops, ops);
    expect(cmp.significant).toBe(false);
    expect(cmp.changes).toEqual([]);
  });

  it("flags index → full scan as a warning access change", () => {
    const prev = opsFor("mysql", mysqlResult(mysqlPlanJson()));
    const next = opsFor(
      "mysql",
      mysqlResult(mysqlPlanJson({ usersAccess: "ALL", usersKey: null })),
    );
    const cmp = comparePlans(prev, next);
    const change = cmp.changes.find((c) => c.kind === "access")!;
    expect(change.object).toBe("users");
    expect(change.severity).toBe("warning");
    expect(change.before).toBe("ref");
    expect(change.after).toBe("ALL");
  });

  it("flags an index swap (same access) as an info change", () => {
    const prev = opsFor("mysql", mysqlResult(mysqlPlanJson({ usersKey: "ix_a" })));
    const next = opsFor("mysql", mysqlResult(mysqlPlanJson({ usersKey: "ix_b" })));
    const cmp = comparePlans(prev, next);
    const change = cmp.changes.find((c) => c.kind === "index")!;
    expect(change.severity).toBe("info");
    expect(change.before).toBe("ix_a");
    expect(change.after).toBe("ix_b");
  });

  it("flags a join method change (postgres nested loop → hash join)", () => {
    const prev = opsFor("postgres", mysqlResult(pgPlanJson({ joinType: "Nested Loop" })));
    const next = opsFor("postgres", mysqlResult(pgPlanJson({ joinType: "Hash Join" })));
    const cmp = comparePlans(prev, next);
    const change = cmp.changes.find((c) => c.kind === "join")!;
    expect(change.before).toBe("nested loop");
    expect(change.after).toBe("hash join");
  });

  it("flags an order-of-magnitude row estimate increase as a warning", () => {
    const prev = opsFor("postgres", mysqlResult(pgPlanJson({ scanRows: 300 })));
    const next = opsFor("postgres", mysqlResult(pgPlanJson({ scanRows: 30_000 })));
    const cmp = comparePlans(prev, next);
    const change = cmp.changes.find((c) => c.kind === "estRows")!;
    expect(change.severity).toBe("warning");
    expect(change.object).toBe("orders");
  });

  it("ignores row estimate changes under the factor threshold", () => {
    const prev = opsFor("postgres", mysqlResult(pgPlanJson({ scanRows: 300 })));
    const next = opsFor("postgres", mysqlResult(pgPlanJson({ scanRows: 600 })));
    expect(comparePlans(prev, next).changes.filter((c) => c.kind === "estRows")).toEqual([]);
  });

  it("reports added / removed operations", () => {
    const prev = opsFor(
      "sqlite",
      sqliteResult([[2, 0, 0, "SEARCH orders USING INDEX ix_user (user_id=?)"]]),
    );
    const next = opsFor(
      "sqlite",
      sqliteResult([
        [2, 0, 0, "SEARCH orders USING INDEX ix_user (user_id=?)"],
        [3, 0, 0, "USE TEMP B-TREE FOR ORDER BY"],
      ]),
    );
    const cmp = comparePlans(prev, next);
    expect(cmp.changes.some((c) => c.kind === "opAdded")).toBe(true);
    const back = comparePlans(next, prev);
    expect(back.changes.some((c) => c.kind === "opRemoved")).toBe(true);
  });

  it("pairs by object name when structural paths shift", () => {
    // 先頭にノードが挿入されて配列インデックスがずれても、users/orders は
    // オブジェクト名で対応付き、偽の追加/削除を報告しない。
    const prev = opsFor(
      "sqlite",
      sqliteResult([
        [2, 0, 0, "SCAN users"],
        [3, 0, 0, "SEARCH orders USING INDEX ix_user (user_id=?)"],
      ]),
    );
    const next = opsFor(
      "sqlite",
      sqliteResult([
        [1, 0, 0, "SEARCH items USING INDEX ix_items (id=?)"],
        [2, 0, 0, "SCAN users"],
        [3, 0, 0, "SEARCH orders USING INDEX ix_user (user_id=?)"],
      ]),
    );
    const cmp = comparePlans(prev, next);
    const added = cmp.changes.filter((c) => c.kind === "opAdded");
    expect(cmp.changes.filter((c) => c.kind === "opRemoved")).toEqual([]);
    expect(added.map((c) => c.object)).toContain("items");
    expect(added.map((c) => c.object)).not.toContain("users");
    expect(added.map((c) => c.object)).not.toContain("orders");
  });
});

// --- スナップショット直列化 ----------------------------------------------------

describe("snapshot round-trip", () => {
  it("mysql/postgres: stores the raw JSON cell and restores identical ops", () => {
    const result = mysqlResult(mysqlPlanJson());
    const snapshot = snapshotFromResult("mysql", result)!;
    expect(snapshot.payloadKind).toBe("json");
    expect(opsFromSnapshot(snapshot)).toEqual(opsFor("mysql", result));
  });

  it("sqlite: stores rows and restores a 4-column result", () => {
    const result = sqliteResult([
      [2, 0, 0, "SCAN users"],
      [3, 2, 0, "USE TEMP B-TREE FOR ORDER BY"],
    ]);
    const snapshot = snapshotFromResult("sqlite", result)!;
    expect(snapshot.payloadKind).toBe("sqliteRows");
    const restored = resultFromSnapshot(snapshot);
    expect(restored.rows).toEqual([
      [2, 0, 0, "SCAN users"],
      [3, 2, 0, "USE TEMP B-TREE FOR ORDER BY"],
    ]);
    expect(opsFromSnapshot(snapshot)).toEqual(opsFor("sqlite", result));
  });

  it("returns null for an empty EXPLAIN result", () => {
    expect(
      snapshotFromResult("mysql", {
        columns: [],
        rows: [],
        rows_affected: 0,
        elapsed_ms: 0,
      }),
    ).toBeNull();
  });
});
