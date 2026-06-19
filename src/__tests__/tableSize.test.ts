import { describe, expect, it } from "vitest";
import {
  computeTableSizeTotals,
  formatBytes,
  formatRowCount,
  sizeBarPercent,
  sortTableSizes,
} from "../components/tableSize";
import type { TableSizeInfo } from "../api/tauri";

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

describe("sizeBarPercent", () => {
  it("scales value against max and clamps to [0,100]", () => {
    expect(sizeBarPercent(50, 100)).toBe(50);
    expect(sizeBarPercent(200, 100)).toBe(100);
    expect(sizeBarPercent(0, 100)).toBe(0);
    expect(sizeBarPercent(null, 100)).toBe(0);
    expect(sizeBarPercent(10, 0)).toBe(0);
  });
});

describe("sortTableSizes", () => {
  const rows = [
    row("b", { total_bytes: 200 }),
    row("a", { total_bytes: 100 }),
    row("c", { total_bytes: null }),
  ];

  it("sorts by total descending with nulls last", () => {
    const out = sortTableSizes(rows, "total_bytes", "desc").map((r) => r.name);
    expect(out).toEqual(["b", "a", "c"]);
  });

  it("sorts by total ascending but still keeps nulls last", () => {
    const out = sortTableSizes(rows, "total_bytes", "asc").map((r) => r.name);
    expect(out).toEqual(["a", "b", "c"]);
  });

  it("sorts by name case-insensitively", () => {
    const named = [row("Zed"), row("alpha"), row("Beta")];
    expect(sortTableSizes(named, "name", "asc").map((r) => r.name)).toEqual([
      "alpha",
      "Beta",
      "Zed",
    ]);
  });

  it("does not mutate the input", () => {
    const input = [row("b"), row("a")];
    const before = input.map((r) => r.name);
    sortTableSizes(input, "name", "asc");
    expect(input.map((r) => r.name)).toEqual(before);
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
