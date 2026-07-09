import { describe, expect, it } from "vitest";
import {
  buildTableStatRows,
  computeTableSizeTotals,
  filterTableStats,
  foreignKeyCounts,
  formatBytes,
  formatCount,
  formatRowCount,
  sizeBarPercent,
  sortTableStats,
  type TableStatRow,
} from "../components/tableSize";
import type { ForeignKey, IndexInfo, TableSchema, TableSizeInfo } from "../api/tauri";

function row(name: string, partial: Partial<TableSizeInfo> = {}): TableSizeInfo {
  return {
    name,
    row_estimate: null,
    data_bytes: null,
    index_bytes: null,
    total_bytes: null,
    ...partial,
  };
}

function statRow(name: string, partial: Partial<TableStatRow> = {}): TableStatRow {
  return {
    ...row(name),
    columnCount: null,
    indexCount: null,
    hasPrimaryKey: null,
    foreignKeyCount: null,
    ...partial,
  };
}

function fk(table: string, partial: Partial<ForeignKey> = {}): ForeignKey {
  return {
    table,
    column: "x",
    referenced_table: "other",
    referenced_column: "id",
    constraint_name: null,
    ...partial,
  };
}

function idx(name: string, partial: Partial<IndexInfo> = {}): IndexInfo {
  return {
    name,
    columns: ["a"],
    unique: false,
    primary: false,
    method: null,
    ...partial,
  };
}

describe("formatBytes", () => {
  it("formats with binary prefixes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 * 1024 * 1024 * 3)).toBe("3.0 GB");
  });

  it("drops the fraction once the value reaches 100 of a unit", () => {
    expect(formatBytes(150 * 1024)).toBe("150 KB");
  });

  it("returns a dash for unknown / invalid sizes", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(NaN)).toBe("—");
  });
});

describe("formatRowCount", () => {
  it("formats integers with grouping and a dash for unknown", () => {
    expect(formatRowCount(0)).toBe("0");
    expect(formatRowCount(1234567)).toBe("1,234,567");
    expect(formatRowCount(null)).toBe("—");
    expect(formatRowCount(-5)).toBe("—");
  });
});

describe("formatCount", () => {
  it("formats small counts and a dash for unknown", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(12)).toBe("12");
    expect(formatCount(null)).toBe("—");
    expect(formatCount(undefined)).toBe("—");
    expect(formatCount(-1)).toBe("—");
  });
});

describe("sizeBarPercent", () => {
  it("scales value against max and clamps to [0,100]", () => {
    expect(sizeBarPercent(50, 100)).toBe(50);
    expect(sizeBarPercent(200, 100)).toBe(100);
    expect(sizeBarPercent(0, 100)).toBe(0);
    expect(sizeBarPercent(null, 100)).toBe(0);
    expect(sizeBarPercent(10, 0)).toBe(0);
  });
});

describe("sortTableStats", () => {
  const rows = [
    statRow("b", { total_bytes: 200 }),
    statRow("a", { total_bytes: 100 }),
    statRow("c", { total_bytes: null }),
  ];

  it("sorts by total descending with nulls last", () => {
    const out = sortTableStats(rows, "total_bytes", "desc").map((r) => r.name);
    expect(out).toEqual(["b", "a", "c"]);
  });

  it("sorts by total ascending but still keeps nulls last", () => {
    const out = sortTableStats(rows, "total_bytes", "asc").map((r) => r.name);
    expect(out).toEqual(["a", "b", "c"]);
  });

  it("sorts by name case-insensitively", () => {
    const named = [statRow("Zed"), statRow("alpha"), statRow("Beta")];
    expect(sortTableStats(named, "name", "asc").map((r) => r.name)).toEqual([
      "alpha",
      "Beta",
      "Zed",
    ]);
  });

  it("sorts by structural columns (index/column/fk counts) with nulls last", () => {
    const structural = [
      statRow("t1", { columnCount: 3, indexCount: 2, foreignKeyCount: 1 }),
      statRow("t2", { columnCount: 5, indexCount: 0, foreignKeyCount: 4 }),
      statRow("t3", { columnCount: null, indexCount: null, foreignKeyCount: 0 }),
    ];
    expect(sortTableStats(structural, "column_count", "desc").map((r) => r.name)).toEqual([
      "t2",
      "t1",
      "t3",
    ]);
    expect(sortTableStats(structural, "index_count", "asc").map((r) => r.name)).toEqual([
      "t2",
      "t1",
      "t3",
    ]);
    expect(sortTableStats(structural, "foreign_key_count", "desc").map((r) => r.name)).toEqual([
      "t2",
      "t1",
      "t3",
    ]);
  });

  it("sorts by primary-key presence with unknown last", () => {
    const rows = [
      statRow("hasPk", { hasPrimaryKey: true }),
      statRow("noPk", { hasPrimaryKey: false }),
      statRow("unknown", { hasPrimaryKey: null }),
    ];
    expect(sortTableStats(rows, "primary_key", "desc").map((r) => r.name)).toEqual([
      "hasPk",
      "noPk",
      "unknown",
    ]);
    expect(sortTableStats(rows, "primary_key", "asc").map((r) => r.name)).toEqual([
      "noPk",
      "hasPk",
      "unknown",
    ]);
  });

  it("does not mutate the input", () => {
    const input = [statRow("b"), statRow("a")];
    const before = input.map((r) => r.name);
    sortTableStats(input, "name", "asc");
    expect(input.map((r) => r.name)).toEqual(before);
  });
});

describe("foreignKeyCounts", () => {
  it("counts distinct constraints per table, grouping composite columns", () => {
    const fks: ForeignKey[] = [
      // composite fk (2 columns share one constraint) → 1
      fk("orders", { column: "a", constraint_name: "fk_ab" }),
      fk("orders", { column: "b", constraint_name: "fk_ab" }),
      // a second, distinct constraint → 2
      fk("orders", { column: "c", constraint_name: "fk_c" }),
      // different table
      fk("items", { column: "x", constraint_name: "fk_x" }),
    ];
    const counts = foreignKeyCounts(fks);
    expect(counts.get("orders")).toBe(2);
    expect(counts.get("items")).toBe(1);
  });

  it("falls back to column/target key when constraint_name is null", () => {
    const fks: ForeignKey[] = [
      fk("t", { column: "a", referenced_table: "u", referenced_column: "id" }),
      fk("t", { column: "b", referenced_table: "u", referenced_column: "id" }),
    ];
    expect(foreignKeyCounts(fks).get("t")).toBe(2);
  });
});

describe("buildTableStatRows", () => {
  const sizes: TableSizeInfo[] = [row("users", { row_estimate: 10 }), row("orders")];
  const overview: TableSchema[] = [
    { name: "users", columns: ["id", "name", "email"] },
    { name: "orders", columns: ["id", "user_id"] },
    // extra table only in overview is ignored (list is anchored on sizes)
    { name: "audit", columns: ["id"] },
  ];
  const fks: ForeignKey[] = [fk("orders", { column: "user_id", constraint_name: "fk_u" })];

  it("merges columns, indexes, pk and fk counts keyed by table name", () => {
    const indexes = new Map<string, IndexInfo[] | null>([
      ["users", [idx("PRIMARY", { primary: true }), idx("idx_email", { unique: true })]],
      ["orders", [idx("idx_user", {})]],
    ]);
    const rows = buildTableStatRows(sizes, overview, fks, indexes);
    expect(rows.map((r) => r.name)).toEqual(["users", "orders"]);
    const users = rows[0];
    expect(users.columnCount).toBe(3);
    expect(users.indexCount).toBe(2);
    expect(users.hasPrimaryKey).toBe(true);
    expect(users.foreignKeyCount).toBe(0);
    const orders = rows[1];
    expect(orders.columnCount).toBe(2);
    expect(orders.indexCount).toBe(1);
    expect(orders.hasPrimaryKey).toBe(false);
    expect(orders.foreignKeyCount).toBe(1);
  });

  it("marks index/pk as unknown (null) when indexes were not fetched or failed", () => {
    const indexes = new Map<string, IndexInfo[] | null>([
      ["users", null], // fetch failed
      // "orders" absent → not fetched
    ]);
    const rows = buildTableStatRows(sizes, overview, fks, indexes);
    expect(rows[0].indexCount).toBeNull();
    expect(rows[0].hasPrimaryKey).toBeNull();
    expect(rows[1].indexCount).toBeNull();
    expect(rows[1].hasPrimaryKey).toBeNull();
    // column and fk counts still resolve from whole-db calls
    expect(rows[0].columnCount).toBe(3);
    expect(rows[1].foreignKeyCount).toBe(1);
  });

  it("leaves columnCount null for a table missing from schema_overview", () => {
    const rows = buildTableStatRows([row("ghost")], overview, [], new Map());
    expect(rows[0].columnCount).toBeNull();
    expect(rows[0].foreignKeyCount).toBe(0);
  });
});

describe("filterTableStats", () => {
  const rows = [
    statRow("users", { indexCount: 2, hasPrimaryKey: true }),
    statRow("orders", { indexCount: 0, hasPrimaryKey: false }),
    statRow("logs", { indexCount: 0, hasPrimaryKey: true }),
    statRow("scratch", { indexCount: null, hasPrimaryKey: null }),
  ];

  it("filters by case-insensitive name substring", () => {
    expect(filterTableStats(rows, { nameQuery: "OR" }).map((r) => r.name)).toEqual(["orders"]);
    expect(filterTableStats(rows, { nameQuery: "  " }).length).toBe(rows.length);
  });

  it("keeps only tables with no index, excluding unknown", () => {
    expect(filterTableStats(rows, { onlyNoIndex: true }).map((r) => r.name)).toEqual([
      "orders",
      "logs",
    ]);
  });

  it("keeps only tables with no primary key, excluding unknown", () => {
    expect(filterTableStats(rows, { onlyNoPrimaryKey: true }).map((r) => r.name)).toEqual([
      "orders",
    ]);
  });

  it("combines predicates", () => {
    expect(
      filterTableStats(rows, { onlyNoIndex: true, onlyNoPrimaryKey: true }).map((r) => r.name),
    ).toEqual(["orders"]);
  });
});

describe("computeTableSizeTotals", () => {
  it("sums numeric fields treating unknown as zero", () => {
    const totals = computeTableSizeTotals([
      row("a", { row_estimate: 10, data_bytes: 100, index_bytes: 20, total_bytes: 120 }),
      row("b", { row_estimate: null, data_bytes: 50, index_bytes: null, total_bytes: 50 }),
    ]);
    expect(totals).toEqual({
      tableCount: 2,
      rowEstimate: 10,
      dataBytes: 150,
      indexBytes: 20,
      totalBytes: 170,
    });
  });
});
