import { beforeEach, describe, expect, it } from "vitest";
import type { ColumnDiff, SchemaDiff, TableColumnInfo, TableDiff } from "../api/tauri";
import {
  buildDriftDetail,
  buildSnapshotPayload,
  canDiff,
  captureGeneration,
  diffIndexes,
  EMPTY_SCHEMA_DRIFT,
  fingerprintPayload,
  fnv1a,
  formatTableChangeFragment,
  loadSchemaDrift,
  MAX_GENERATIONS,
  MAX_SNAPSHOT_BYTES,
  newGenerationId,
  normalizeSchemaDrift,
  recordSnapshotGeneration,
  saveSchemaDrift,
  summarizeDrift,
  toDiffInput,
  type SchemaGeneration,
  type SchemaSnapshotPayload,
  type SnapshotTable,
} from "../schemaDrift";

function col(name: string, dataType = "int"): TableColumnInfo {
  return {
    name,
    data_type: dataType,
    nullable: true,
    key: "",
    default: null,
    extra: "",
    referenced_table: null,
    referenced_column: null,
  };
}

function table(name: string, columns: TableColumnInfo[], indexes: SnapshotTable["indexes"] = []): SnapshotTable {
  return { name, columns, indexes };
}

function payload(tables: SnapshotTable[], database = "app"): SchemaSnapshotPayload {
  return buildSnapshotPayload("mysql", database, tables);
}

function gen(tables: SnapshotTable[], capturedAt = "2026-07-08T00:00:00.000Z"): SchemaGeneration {
  return captureGeneration(payload(tables), capturedAt);
}

describe("fnv1a", () => {
  it("is deterministic for the same input", () => {
    expect(fnv1a("hello")).toBe(fnv1a("hello"));
  });

  it("differs for different input", () => {
    expect(fnv1a("hello")).not.toBe(fnv1a("hellp"));
  });

  it("returns an 8-char hex string", () => {
    expect(fnv1a("x")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("buildSnapshotPayload / fingerprintPayload", () => {
  it("sorts tables by name so fingerprint is stable regardless of fetch order", () => {
    const a = buildSnapshotPayload("mysql", "app", [table("b", [col("id")]), table("a", [col("id")])]);
    const b = buildSnapshotPayload("mysql", "app", [table("a", [col("id")]), table("b", [col("id")])]);
    expect(a.tables.map((t) => t.name)).toEqual(["a", "b"]);
    expect(fingerprintPayload(a)).toBe(fingerprintPayload(b));
  });

  it("fingerprint changes when column metadata changes", () => {
    const a = buildSnapshotPayload("mysql", "app", [table("orders", [col("id")])]);
    const b = buildSnapshotPayload("mysql", "app", [table("orders", [col("id"), col("total", "numeric(10,2)")])]);
    expect(fingerprintPayload(a)).not.toBe(fingerprintPayload(b));
  });
});

describe("captureGeneration", () => {
  it("stores the full payload when under the size guard", () => {
    const g = gen([table("orders", [col("id")])]);
    expect(g.omitted).toBe(false);
    expect(g.payload).not.toBeNull();
    expect(g.tableCount).toBe(1);
    expect(g.fingerprint).toMatch(/^[0-9a-f]{8}$/);
  });

  it("omits the payload but keeps metadata when serialized size exceeds the guard", () => {
    // 1 列だけの巨大なデフォルト値でガードを超えさせる。
    const huge = col("id");
    huge.default = "x".repeat(MAX_SNAPSHOT_BYTES + 1000);
    const g = gen([table("orders", [huge])]);
    expect(g.omitted).toBe(true);
    expect(g.payload).toBeNull();
    expect(g.tableCount).toBe(1);
    expect(g.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(canDiff(g)).toBe(false);
  });
});

describe("recordSnapshotGeneration", () => {
  it("adds the first generation", () => {
    const g = gen([table("orders", [col("id")])]);
    const rec = recordSnapshotGeneration(EMPTY_SCHEMA_DRIFT, g);
    expect(rec.added).toBe(true);
    expect(rec.prev).toBeNull();
    expect(rec.state.generations).toEqual([g]);
  });

  it("does not add a new generation when the fingerprint is unchanged", () => {
    const g1 = gen([table("orders", [col("id")])]);
    const state1 = recordSnapshotGeneration(EMPTY_SCHEMA_DRIFT, g1).state;
    const g2 = gen([table("orders", [col("id")])]);
    const rec = recordSnapshotGeneration(state1, g2);
    expect(rec.added).toBe(false);
    expect(rec.state.generations).toHaveLength(1);
  });

  it("adds a new generation and reports the previous one when content differs", () => {
    const g1 = gen([table("orders", [col("id")])]);
    const state1 = recordSnapshotGeneration(EMPTY_SCHEMA_DRIFT, g1).state;
    const g2 = gen([table("orders", [col("id"), col("total")])]);
    const rec = recordSnapshotGeneration(state1, g2);
    expect(rec.added).toBe(true);
    expect(rec.prev).toEqual(g1);
    expect(rec.state.generations[0]).toEqual(g2);
    expect(rec.state.generations[1]).toEqual(g1);
  });

  it("rotates out generations beyond MAX_GENERATIONS", () => {
    let state = EMPTY_SCHEMA_DRIFT;
    for (let i = 0; i < MAX_GENERATIONS + 5; i++) {
      const g = gen([table("orders", [col("id"), col(`c${i}`)])]);
      state = recordSnapshotGeneration(state, g).state;
    }
    expect(state.generations).toHaveLength(MAX_GENERATIONS);
  });
});

describe("normalizeSchemaDrift", () => {
  it("returns EMPTY for garbage input", () => {
    expect(normalizeSchemaDrift(null)).toEqual(EMPTY_SCHEMA_DRIFT);
    expect(normalizeSchemaDrift(42)).toEqual(EMPTY_SCHEMA_DRIFT);
    expect(normalizeSchemaDrift({ generations: "nope" })).toEqual(EMPTY_SCHEMA_DRIFT);
  });

  it("drops invalid generations and clamps to MAX_GENERATIONS", () => {
    const valid = gen([table("orders", [col("id")])]);
    const many = Array.from({ length: MAX_GENERATIONS + 3 }, () => valid);
    const state = normalizeSchemaDrift({ generations: [...many, { bogus: true }, null] });
    expect(state.generations).toHaveLength(MAX_GENERATIONS);
    expect(state.generations.every((g) => g.id === valid.id)).toBe(true);
  });

  it("accepts an omitted generation (payload null)", () => {
    const huge = col("id");
    huge.default = "x".repeat(MAX_SNAPSHOT_BYTES + 1000);
    const omitted = gen([table("orders", [huge])]);
    const state = normalizeSchemaDrift({ generations: [omitted] });
    expect(state.generations).toEqual([omitted]);
  });
});

describe("load/save round-trip (localStorage)", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips through localStorage", () => {
    const g = gen([table("orders", [col("id")])]);
    const state = recordSnapshotGeneration(EMPTY_SCHEMA_DRIFT, g).state;
    saveSchemaDrift("profileA", state);
    expect(loadSchemaDrift("profileA")).toEqual(state);
  });

  it("removes the storage key once every generation is gone", () => {
    saveSchemaDrift("profileA", EMPTY_SCHEMA_DRIFT);
    expect(localStorage.getItem("noobdb.schemadrift.profileA")).toBeNull();
  });

  it("recovers from corrupted JSON", () => {
    localStorage.setItem("noobdb.schemadrift.profileA", "{not json");
    expect(loadSchemaDrift("profileA")).toEqual(EMPTY_SCHEMA_DRIFT);
  });
});

describe("newGenerationId", () => {
  it("produces unique, prefixed ids", () => {
    const a = newGenerationId();
    const b = newGenerationId();
    expect(a).toMatch(/^drift_/);
    expect(a).not.toBe(b);
  });
});

describe("toDiffInput", () => {
  it("strips indexes, keeping only name/columns for the backend diff shape", () => {
    const g = gen([table("orders", [col("id")], [{ name: "pk", columns: ["id"], unique: true, primary: true, method: null }])]);
    expect(toDiffInput(g)).toEqual([{ name: "orders", columns: [col("id")] }]);
  });

  it("returns null for an omitted generation", () => {
    const huge = col("id");
    huge.default = "x".repeat(MAX_SNAPSHOT_BYTES + 1000);
    const g = gen([table("orders", [huge])]);
    expect(toDiffInput(g)).toBeNull();
  });
});

describe("diffIndexes", () => {
  it("detects added, removed and changed indexes on shared tables", () => {
    const prev = gen([
      table(
        "orders",
        [col("id")],
        [
          { name: "idx_removed", columns: ["a"], unique: false, primary: false, method: null },
          { name: "idx_changed", columns: ["a"], unique: false, primary: false, method: null },
        ],
      ),
    ]);
    const next = gen([
      table(
        "orders",
        [col("id")],
        [
          { name: "idx_changed", columns: ["a", "b"], unique: false, primary: false, method: null },
          { name: "idx_added", columns: ["c"], unique: true, primary: false, method: null },
        ],
      ),
    ]);
    const entries = diffIndexes(prev, next);
    expect(entries).toEqual([
      { table: "orders", indexName: "idx_added", status: "added" },
      { table: "orders", indexName: "idx_changed", status: "changed" },
      { table: "orders", indexName: "idx_removed", status: "removed" },
    ]);
  });

  it("ignores tables present on only one side (already reflected by the table-level diff)", () => {
    const prev = gen([table("only_prev", [col("id")], [{ name: "i", columns: ["id"], unique: false, primary: false, method: null }])]);
    const next = gen([table("only_next", [col("id")], [{ name: "i", columns: ["id"], unique: false, primary: false, method: null }])]);
    expect(diffIndexes(prev, next)).toEqual([]);
  });

  it("returns an empty array when either generation was omitted", () => {
    const huge = col("id");
    huge.default = "x".repeat(MAX_SNAPSHOT_BYTES + 1000);
    const omitted = gen([table("orders", [huge])]);
    const normal = gen([table("orders", [col("id")])]);
    expect(diffIndexes(omitted, normal)).toEqual([]);
    expect(diffIndexes(normal, omitted)).toEqual([]);
  });
});

describe("summarizeDrift", () => {
  function columnDiff(name: string, status: ColumnDiff["status"]): ColumnDiff {
    return { name, status, source: null, target: null, changed_fields: status === "different" ? ["data_type"] : [] };
  }

  function tableDiff(name: string, status: TableDiff["status"], columns: ColumnDiff[] = []): TableDiff {
    return { name, status, columns };
  }

  function diff(tables: TableDiff[]): SchemaDiff {
    return { source_driver: "mysql", target_driver: "mysql", tables };
  }

  it("classifies whole-table additions and removals", () => {
    const summary = summarizeDrift(
      diff([tableDiff("new_table", "target_only"), tableDiff("gone_table", "source_only")]),
      [],
    );
    expect(summary.tables).toHaveLength(2);
    expect(summary.tables.find((t) => t.table === "new_table")?.tableStatus).toBe("added");
    expect(summary.tables.find((t) => t.table === "gone_table")?.tableStatus).toBe("removed");
  });

  it("counts column-level changes for a table present on both sides", () => {
    const summary = summarizeDrift(
      diff([
        tableDiff("orders", "different", [
          columnDiff("total", "target_only"),
          columnDiff("legacy", "source_only"),
          columnDiff("status", "different"),
        ]),
      ]),
      [],
    );
    expect(summary.tables).toEqual([
      {
        table: "orders",
        tableStatus: "changed",
        columnsAdded: 1,
        columnsRemoved: 1,
        columnsChanged: 1,
        indexesAdded: 0,
        indexesRemoved: 0,
        indexesChanged: 0,
      },
    ]);
  });

  it("excludes identical tables with no index changes", () => {
    const summary = summarizeDrift(diff([tableDiff("orders", "same")]), []);
    expect(summary.tables).toEqual([]);
  });

  it("still reports a same-status table when only its indexes changed", () => {
    const summary = summarizeDrift(diff([tableDiff("orders", "same")]), [
      { table: "orders", indexName: "idx_a", status: "added" },
    ]);
    expect(summary.tables).toEqual([
      {
        table: "orders",
        tableStatus: "changed",
        columnsAdded: 0,
        columnsRemoved: 0,
        columnsChanged: 0,
        indexesAdded: 1,
        indexesRemoved: 0,
        indexesChanged: 0,
      },
    ]);
  });

  it("sorts the result by table name", () => {
    const summary = summarizeDrift(
      diff([tableDiff("zeta", "target_only"), tableDiff("alpha", "target_only")]),
      [],
    );
    expect(summary.tables.map((t) => t.table)).toEqual(["alpha", "zeta"]);
  });
});

describe("formatTableChangeFragment / buildDriftDetail", () => {
  it("formats a whole-table addition/removal with a leading sign", () => {
    expect(
      formatTableChangeFragment({
        table: "orders",
        tableStatus: "added",
        columnsAdded: 0,
        columnsRemoved: 0,
        columnsChanged: 0,
        indexesAdded: 0,
        indexesRemoved: 0,
        indexesChanged: 0,
      }),
    ).toBe("+orders");
    expect(
      formatTableChangeFragment({
        table: "orders",
        tableStatus: "removed",
        columnsAdded: 0,
        columnsRemoved: 0,
        columnsChanged: 0,
        indexesAdded: 0,
        indexesRemoved: 0,
        indexesChanged: 0,
      }),
    ).toBe("-orders");
  });

  it("formats column and index change counts", () => {
    expect(
      formatTableChangeFragment({
        table: "orders",
        tableStatus: "changed",
        columnsAdded: 2,
        columnsRemoved: 0,
        columnsChanged: 1,
        indexesAdded: 1,
        indexesRemoved: 0,
        indexesChanged: 0,
      }),
    ).toBe("orders(+2,~1,idx+1)");
  });

  it("joins up to maxTables fragments and appends an ellipsis when truncated", () => {
    const summary = {
      tables: ["a", "b", "c", "d"].map((table) => ({
        table,
        tableStatus: "added" as const,
        columnsAdded: 0,
        columnsRemoved: 0,
        columnsChanged: 0,
        indexesAdded: 0,
        indexesRemoved: 0,
        indexesChanged: 0,
      })),
    };
    expect(buildDriftDetail(summary, 2)).toBe("+a, +b, …");
    expect(buildDriftDetail(summary, 10)).toBe("+a, +b, +c, +d");
  });

  it("returns an empty string for an empty summary", () => {
    expect(buildDriftDetail({ tables: [] })).toBe("");
  });
});
