import { describe, expect, it } from "vitest";
import {
  computeTableSizeTotals,
  filterTableStats,
  formatBytes,
  formatCount,
  formatRowCount,
  sizeBarPercent,
  sortTableStats,
  toTableStatRows,
  type TableStatRow,
} from "../components/tableSize";
import type { TableSizeInfo, TableStatistic } from "../api/tauri";

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

describe("toTableStatRows", () => {
  // 結合 (列数・インデックス・PK・FK 数) はバックエンドの `table_statistics` が行う
  // (#1255、Rust 側 `db::schema_insight` のテストが検証)。ここでは戻り値の
  // snake_case をダッシュボードの行へ写す層だけを固定する。
  it("maps the backend statistics onto dashboard rows, keeping order", () => {
    const stats: TableStatistic[] = [
      {
        ...row("users", { row_estimate: 10, total_bytes: 120 }),
        column_count: 3,
        index_count: 2,
        has_primary_key: true,
        foreign_key_count: 0,
      },
      {
        ...row("ghost"),
        column_count: null,
        index_count: 0,
        has_primary_key: false,
        foreign_key_count: 1,
      },
    ];
    const rows = toTableStatRows(stats);
    expect(rows.map((r) => r.name)).toEqual(["users", "ghost"]);
    expect(rows[0]).toMatchObject({
      row_estimate: 10,
      total_bytes: 120,
      columnCount: 3,
      indexCount: 2,
      hasPrimaryKey: true,
      foreignKeyCount: 0,
    });
    // 列メタデータが無いテーブルの列数は「不明」のまま (0 にしない)。
    expect(rows[1].columnCount).toBeNull();
    expect(rows[1].indexCount).toBe(0);
    expect(rows[1].hasPrimaryKey).toBe(false);
    expect(rows[1].foreignKeyCount).toBe(1);
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
