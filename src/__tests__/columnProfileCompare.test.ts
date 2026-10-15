import { describe, expect, it } from "vitest";
import type { ColumnProfile } from "../api/tauri";
import {
  baselineIndex,
  buildMetricRows,
  buildTopValueRows,
  compareExportTable,
  countMetricDifferences,
  topValueCellDiffers,
  topValueRowDiffers,
  type CompareEntry,
} from "../components/columnProfileCompare";

function profile(over: Partial<ColumnProfile> = {}): ColumnProfile {
  return {
    column: "status",
    data_type: "varchar(10)",
    numeric: false,
    total_count: 1000,
    non_null_count: 900,
    null_count: 100,
    distinct_count: 3,
    distinct_approximate: false,
    min_value: "a",
    max_value: "z",
    top_values: [
      { value: "active", count: 600 },
      { value: "closed", count: 300 },
      { value: null, count: 100 },
    ],
    histogram: [],
    notes: [],
    ...over,
  };
}
const entry = (id: string, p: ColumnProfile | null, error: string | null = null): CompareEntry => ({
  id,
  label: id,
  profile: p,
  error,
});

describe("buildMetricRows (#1539)", () => {
  it("基準 (先頭) と同じなら差なし。行数が違っても NULL 率が近ければ差としない", () => {
    const entries = [
      entry("prod", profile()),
      entry("stg", profile({ total_count: 50, null_count: 5, non_null_count: 45 })),
    ];
    const rows = buildMetricRows(entries);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.total.cells[1]).toEqual({ text: "50", differs: true });
    expect(byId.nulls.cells[1]?.differs).toBe(true);
    expect(byId.nullPct.cells[1]).toEqual({ text: "10.0%", differs: false });
    expect(byId.type.cells[1]?.differs).toBe(false);
    expect(byId.min.cells[0]).toEqual({ text: "a", differs: false });
  });

  it("NULL 率が許容を超えたら差。MIN/MAX/型/DISTINCT の違いも拾う", () => {
    const entries = [
      entry("prod", profile()),
      entry(
        "stg",
        profile({ null_count: 300, data_type: "text", distinct_count: 4, min_value: null, max_value: "zz" }),
      ),
    ];
    const byId = Object.fromEntries(buildMetricRows(entries).map((r) => [r.id, r]));
    expect(byId.nullPct.cells[1]?.differs).toBe(true);
    expect(byId.type.cells[1]?.differs).toBe(true);
    expect(byId.distinct.cells[1]?.differs).toBe(true);
    expect(byId.min.cells[1]).toEqual({ text: "NULL", differs: true });
    expect(byId.max.cells[1]?.differs).toBe(true);
    expect(countMetricDifferences(buildMetricRows(entries))).toBeGreaterThanOrEqual(5);
  });

  it("取得できなかった接続のセルは null、基準は最初の取得済み接続", () => {
    const entries = [entry("prod", null, "boom"), entry("stg", profile()), entry("dev", profile())];
    expect(baselineIndex(entries)).toBe(1);
    const rows = buildMetricRows(entries);
    expect(rows[0].cells[0]).toBeNull();
    expect(rows[0].cells[2]?.differs).toBe(false);
  });
});

describe("buildTopValueRows (#1539)", () => {
  const prod = entry("prod", profile());
  it("件数ではなく構成比で比べる (行数が違っても同じ分布なら差なし)", () => {
    const stg = entry(
      "stg",
      profile({
        total_count: 100,
        top_values: [
          { value: "active", count: 60 },
          { value: "closed", count: 30 },
          { value: null, count: 10 },
        ],
      }),
    );
    const rows = buildTopValueRows([prod, stg]);
    expect(rows.map((r) => r.label)).toEqual(["active", "closed", "NULL"]);
    expect(rows.some((r) => topValueRowDiffers(r, [prod, stg]))).toBe(false);
  });

  it("構成比が 1pt 以上ずれた値と、片方にしか無い値を差にする。NULL と文字列 'NULL' は別物", () => {
    const stg = entry(
      "stg",
      profile({
        top_values: [
          { value: "active", count: 700 },
          { value: "closed", count: 295 },
          { value: "NULL", count: 5 },
        ],
      }),
    );
    const entries = [prod, stg];
    const rows = buildTopValueRows(entries);
    const byLabel = new Map(rows.map((r) => [r.key, r]));
    const active = rows.find((r) => r.label === "active");
    const closed = rows.find((r) => r.label === "closed");
    expect(topValueCellDiffers(active as never, 1, entries)).toBe(true);
    expect(topValueCellDiffers(closed as never, 1, entries)).toBe(false);
    const nullRow = rows.find((r) => r.isNull);
    const strRow = rows.find((r) => !r.isNull && r.label === "NULL");
    expect(nullRow).toBeDefined();
    expect(strRow).toBeDefined();
    expect(byLabel.size).toBe(4);
    // 基準にだけ在る NULL 行の stg セルは欠落 = 差。
    expect(nullRow?.cells[1]).toBeNull();
    expect(topValueCellDiffers(nullRow as never, 1, entries)).toBe(true);
    // 基準自身は常に差なし。
    expect(topValueCellDiffers(nullRow as never, 0, entries)).toBe(false);
  });

  it("基準の構成比が大きい順に並べ、limit で打ち切る", () => {
    const rows = buildTopValueRows([prod, entry("stg", profile())], 2);
    expect(rows.map((r) => r.label)).toEqual(["active", "closed"]);
  });

  it("取得済みが 1 接続だけなら差は出ない", () => {
    const entries = [prod, entry("stg", null, "x")];
    expect(buildTopValueRows(entries).some((r) => topValueRowDiffers(r, entries))).toBe(false);
  });
});

describe("compareExportTable (#1624)", () => {
  const labels = {
    section: "sec",
    item: "item",
    differs: "diff",
    sectionMetric: "metric",
    sectionTop: "top",
    metric: {
      type: "Type",
      total: "Total",
      nulls: "Nulls",
      nullPct: "Null%",
      distinct: "Distinct",
      min: "Min",
      max: "Max",
    },
    absent: "absent",
  };
  it("指標と上位値を 1 枚の表にし、差のある接続名と『上位値に無い』を出す", () => {
    const entries = [
      entry("prod", profile()),
      entry("stg", profile({ total_count: 50, top_values: [{ value: "active", count: 10 }] })),
      entry("bad", null, "boom"),
    ];
    const t = compareExportTable(entries, labels);
    expect(t.header).toEqual(["sec", "item", "prod", "stg", "bad", "diff"]);
    const total = t.rows.find((r) => r[1] === "Total");
    expect(total).toEqual(["metric", "Total", "1,000", "50", null, "stg"]);
    const closed = t.rows.find((r) => r[0] === "top" && r[1] === "closed");
    expect(closed?.[3]).toBe("absent");
    expect(closed?.[4]).toBeNull();
    expect(closed?.[5]).toBe("stg");
  });
});
