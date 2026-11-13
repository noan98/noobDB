import { describe, expect, it } from "vitest";
import type { SchemaDiff } from "../api/tauri";
import {
  buildCompareMatrix,
  columnBreakdown,
  filterMatrixRows,
  MAX_COMPARE_DATABASES,
  MAX_COMPARE_TARGETS,
  sortMatrixRows,
} from "../components/schemaCompareMatrixModel";

function diffOf(tables: [string, SchemaDiff["tables"][number]["status"]][]): SchemaDiff {
  return {
    source_driver: "mysql",
    target_driver: "mysql",
    tables: tables.map(([name, status]) => ({ name, status, columns: [], foreign_keys: [] })),
  } as unknown as SchemaDiff;
}

describe("buildCompareMatrix (基準 1 vs 比較先 複数)", () => {
  it("上限は基準を含めて 5 つ (比較先 4)", () => {
    expect(MAX_COMPARE_DATABASES).toBe(5);
    expect(MAX_COMPARE_TARGETS).toBe(4);
  });

  it("テーブル名の和集合を名前順に並べ、比較先ごとの状態をマスに入れる", () => {
    const m = buildCompareMatrix([
      {
        diff: diffOf([
          ["users", "same"],
          ["orders", "different"],
        ]),
        error: null,
      },
      {
        diff: diffOf([
          ["users", "source_only"],
          ["orders", "same"],
          ["legacy", "target_only"],
        ]),
        error: null,
      },
    ]);
    expect(m.rows.map((r) => r.name)).toEqual(["legacy", "orders", "users"]);
    // legacy は 2 つ目の比較先にだけある → 1 つ目の列では「どちらにも無い」。
    expect(m.rows[0]).toEqual({
      name: "legacy",
      cells: ["absent", "target_only"],
      differs: true,
      drift: 1,
      compared: 2,
    });
    expect(m.rows[1]?.cells).toEqual(["different", "same"]);
    expect(m.rows[2]?.cells).toEqual(["same", "source_only"]);
    expect(m.differingTables).toEqual([1, 2]);
  });

  it("比較に失敗した列は error で、差分ありには数えない", () => {
    const m = buildCompareMatrix([
      { diff: diffOf([["users", "same"]]), error: null },
      { diff: null, error: "boom" },
    ]);
    expect(m.rows).toEqual([
      { name: "users", cells: ["same", "error"], differs: false, drift: 0, compared: 1 },
    ]);
    expect(m.differingTables).toEqual([0, null]);
  });

  it("filterMatrixRows は差分のある行と名前の部分一致 (大小無視) で絞る", () => {
    const { rows } = buildCompareMatrix([
      {
        diff: diffOf([
          ["Users", "different"],
          ["orders", "same"],
        ]),
        error: null,
      },
    ]);
    expect(filterMatrixRows(rows, true, "").map((r) => r.name)).toEqual(["Users"]);
    expect(filterMatrixRows(rows, false, "").map((r) => r.name)).toEqual(["orders", "Users"]);
    expect(filterMatrixRows(rows, false, " user ").map((r) => r.name)).toEqual(["Users"]);
  });
});

describe("ドリフト度と並べ替え", () => {
  const m = buildCompareMatrix([
    {
      diff: diffOf([
        ["a", "same"],
        ["b", "different"],
        ["c", "different"],
      ]),
      error: null,
    },
    {
      diff: diffOf([
        ["a", "same"],
        ["b", "source_only"],
        ["c", "same"],
      ]),
      error: null,
    },
    {
      diff: diffOf([
        ["a", "target_only"],
        ["b", "different"],
        ["c", "same"],
      ]),
      error: null,
    },
    { diff: null, error: "boom" },
  ]);

  it("ずれている比較先の数と、比較できた比較先の数を行ごとに持つ (失敗列は分母に入れない)", () => {
    expect(m.rows.map((r) => [r.name, r.drift, r.compared])).toEqual([
      ["a", 1, 3],
      ["b", 3, 3],
      ["c", 1, 3],
    ]);
  });

  it("ずれが多い順は drift の降順で、同数は名前順。元の配列は変えない", () => {
    expect(sortMatrixRows(m.rows, "drift").map((r) => r.name)).toEqual(["b", "a", "c"]);
    expect(sortMatrixRows(m.rows, "name").map((r) => r.name)).toEqual(["a", "b", "c"]);
    expect(m.rows.map((r) => r.name)).toEqual(["a", "b", "c"]);
  });

  it("absent はずれに数えない", () => {
    const x = buildCompareMatrix([
      { diff: diffOf([["a", "same"]]), error: null },
      {
        diff: diffOf([
          ["a", "same"],
          ["only", "target_only"],
        ]),
        error: null,
      },
    ]);
    expect(x.rows.find((r) => r.name === "only")).toMatchObject({ drift: 1, compared: 2 });
  });

  it("columnBreakdown は追加 / 削除 / 変更を数え、差分なしは数えず、失敗列は null", () => {
    expect(
      columnBreakdown(
        diffOf([
          ["a", "same"],
          ["b", "source_only"],
          ["c", "target_only"],
          ["d", "different"],
          ["e", "different"],
        ]),
      ),
    ).toEqual({ source_only: 1, target_only: 1, different: 2 });
    expect(columnBreakdown(null)).toBeNull();
  });
});
