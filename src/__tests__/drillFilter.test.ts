import { describe, expect, it } from "vitest";
import type { CellValue, Column } from "../api/tauri";
import {
  applyDrillRequest,
  chartDrillConditions,
  drillColumnFilter,
  drillSummary,
  pivotDrillConditions,
  type ColumnFilterEntry,
  type DrillCondition,
} from "../components/drillFilter";
import { columnFilterPasses, isColumnFilterActive } from "../components/gridSortFilter";
import { buildPivotModel } from "../components/pivotData";

// ピボット / チャートの集計キーから、絞り込んだグリッドへ移るための純ロジック (#2236)。

const cols = (...names: string[]): Column[] => names.map((name) => ({ name, type_name: "TEXT" }) as Column);
const COLUMNS = cols("region", "status", "amount");
const ROWS: CellValue[][] = [
  ["東京", "paid", 100],
  ["東京", "open", 50],
  ["大阪", "paid", 30],
  [null, "paid", 5],
  ["(null)", "paid", 7],
  ["", "open", 1],
];
const CFG = { rowField: 0, colField: 1, valueField: 2, agg: "sum" as const };

/** 条件を適用したあとに残る行 (グリッドの列フィルタと同じ判定)。 */
function survivors(conds: DrillCondition[], numeric: (i: number) => boolean = () => false): CellValue[][] {
  const state = applyDrillRequest([], { mode: "apply", conditions: conds }, numeric);
  return ROWS.filter((r) =>
    state.every((f) =>
      columnFilterPasses(r[Number(f.id)], f.value as Parameters<typeof columnFilterPasses>[1]),
    ),
  );
}

describe("pivotDrillConditions", () => {
  const model = buildPivotModel(COLUMNS, ROWS, CFG);
  const at = (rk: string) => model.rowKeys.indexOf(rk);

  it("本体セルは行軸と列軸の両方で絞る", () => {
    const conds = pivotDrillConditions(model, COLUMNS, CFG, {
      row: at("東京"),
      col: model.colKeys.indexOf("paid"),
    });
    expect(conds).toEqual([
      { colIdx: 0, column: "region", value: "東京" },
      { colIdx: 1, column: "status", value: "paid" },
    ]);
    expect(survivors(conds)).toEqual([["東京", "paid", 100]]);
  });

  it("行見出し・行の合計は行軸だけ、列見出し・列の合計は列軸だけで絞る", () => {
    const rowOnly = pivotDrillConditions(model, COLUMNS, CFG, { row: at("大阪"), col: null });
    expect(rowOnly).toEqual([{ colIdx: 0, column: "region", value: "大阪" }]);
    expect(survivors(rowOnly)).toEqual([["大阪", "paid", 30]]);

    const colOnly = pivotDrillConditions(model, COLUMNS, CFG, {
      row: null,
      col: model.colKeys.indexOf("open"),
    });
    expect(colOnly).toEqual([{ colIdx: 1, column: "status", value: "open" }]);
    expect(survivors(colOnly)).toHaveLength(2);
  });

  it("総計と範囲外の添字では絞れない (空配列)", () => {
    expect(pivotDrillConditions(model, COLUMNS, CFG, { row: null, col: null })).toEqual([]);
    expect(pivotDrillConditions(model, COLUMNS, CFG, { row: 99, col: 0 })).toEqual([]);
    expect(pivotDrillConditions(model, COLUMNS, CFG, { row: 0, col: 99 })).toEqual([]);
  });

  it("列軸が無い設定では列の指定を無視する", () => {
    const cfg = { rowField: 0, colField: null, valueField: 2, agg: "sum" as const };
    const m = buildPivotModel(COLUMNS, ROWS, cfg);
    const conds = pivotDrillConditions(m, COLUMNS, cfg, { row: m.rowKeys.indexOf("東京"), col: 0 });
    expect(conds).toEqual([{ colIdx: 0, column: "region", value: "東京" }]);
  });

  it('NULL の行と文字列 "(null)" の行を取り違えない', () => {
    const nullRow = pivotDrillConditions(model, COLUMNS, CFG, { row: at("(null)"), col: null });
    expect(nullRow[0].value).toBeNull();
    expect(survivors(nullRow)).toEqual([[null, "paid", 5]]);

    const textRow = pivotDrillConditions(model, COLUMNS, CFG, { row: at('"(null)"'), col: null });
    expect(textRow[0].value).toBe("(null)");
    expect(survivors(textRow)).toEqual([["(null)", "paid", 7]]);
  });

  it("空文字のキーでも、その行だけに絞れる", () => {
    const empty = pivotDrillConditions(model, COLUMNS, CFG, { row: at(""), col: null });
    expect(empty[0].value).toBe("");
    expect(survivors(empty)).toEqual([["", "open", 1]]);
  });
});

describe("chartDrillConditions", () => {
  it("X ラベルの列で絞る", () => {
    expect(chartDrillConditions(ROWS, COLUMNS, 0, "東京")).toEqual([
      { colIdx: 0, column: "region", value: "東京" },
    ]);
  });

  it("ラベル (null) は、元に NULL があれば NULL として扱う", () => {
    expect(chartDrillConditions(ROWS, COLUMNS, 0, "(null)")[0].value).toBeNull();
  });

  it('元に NULL が無ければ文字列 "(null)" として扱う', () => {
    const rows: CellValue[][] = [["(null)", "a", 1]];
    expect(chartDrillConditions(rows, COLUMNS, 0, "(null)")[0].value).toBe("(null)");
  });

  it("ラベルが無い・列が不正なときは空配列", () => {
    expect(chartDrillConditions(ROWS, COLUMNS, 0, undefined)).toEqual([]);
    expect(chartDrillConditions(ROWS, COLUMNS, -1, "x")).toEqual([]);
  });
});

describe("drillColumnFilter", () => {
  it("文字列は大小区別の equals にする", () => {
    const f = drillColumnFilter("Apple", false);
    expect(f).toMatchObject({ op: "equals", value: "Apple", nullMode: "any", caseSensitive: true });
    expect(columnFilterPasses("Apple", f)).toBe(true);
    expect(columnFilterPasses("apple", f)).toBe(false);
  });

  it("数値列は数値比較 (1 と 1.0 は同じキー)", () => {
    const f = drillColumnFilter("1", true);
    expect(f.op).toBe("eq");
    expect(columnFilterPasses(1, f)).toBe(true);
    expect(columnFilterPasses("1.0", f)).toBe(true);
    expect(columnFilterPasses(2, f)).toBe(false);
  });

  it("2^53 を超える整数キーも丸めずに比較する", () => {
    const f = drillColumnFilter("9007199254740993", true);
    expect(columnFilterPasses("9007199254740993", f)).toBe(true);
    expect(columnFilterPasses("9007199254740992", f)).toBe(false);
  });

  it("NULL は IS NULL 相当 (テキスト列・数値列とも)", () => {
    for (const numeric of [false, true]) {
      const f = drillColumnFilter(null, numeric);
      expect(f.nullMode).toBe("only");
      expect(isColumnFilterActive(f)).toBe(true);
      expect(columnFilterPasses(null, f)).toBe(true);
      expect(columnFilterPasses("x", f)).toBe(false);
      expect(columnFilterPasses(0, f)).toBe(false);
    }
  });

  it("空文字・空白だけのキーは有効なフィルタになり、完全一致だけを通す", () => {
    for (const key of ["", " ", "  "]) {
      const f = drillColumnFilter(key, false);
      expect(isColumnFilterActive(f)).toBe(true);
      expect(columnFilterPasses(key, f)).toBe(true);
      expect(columnFilterPasses(null, f)).toBe(false);
      expect(columnFilterPasses("x", f)).toBe(false);
    }
    expect(columnFilterPasses(" ", drillColumnFilter("", false))).toBe(false);
  });

  it("日付・時刻の文字列キーはそのまま等値比較する", () => {
    const f = drillColumnFilter("2024-03-01", false);
    expect(columnFilterPasses("2024-03-01", f)).toBe(true);
    expect(columnFilterPasses("2024-03-02", f)).toBe(false);
  });
});

describe("applyDrillRequest", () => {
  const conds: DrillCondition[] = [
    { colIdx: 0, column: "region", value: "東京" },
    { colIdx: 1, column: "status", value: "paid" },
  ];
  const other: ColumnFilterEntry = { id: "2", value: { op: "gt", value: "10", value2: "", nullMode: "any" } };

  it("apply は他の列のフィルタを捨て、条件の列だけにする", () => {
    const next = applyDrillRequest(
      [other, { id: "0", value: "stale" }],
      { mode: "apply", conditions: conds },
      () => false,
    );
    expect(next.map((f) => f.id)).toEqual(["0", "1"]);
  });

  it("clear は条件の列のフィルタだけ外し、ほかは残す", () => {
    const applied = applyDrillRequest([], { mode: "apply", conditions: conds }, () => false);
    const next = applyDrillRequest([...applied, other], { mode: "clear", conditions: conds }, () => false);
    expect(next).toEqual([other]);
  });

  it("同じ列の条件は後勝ち", () => {
    const next = applyDrillRequest(
      [],
      {
        mode: "apply",
        conditions: [
          { colIdx: 0, column: "region", value: "a" },
          { colIdx: 0, column: "region", value: "b" },
        ],
      },
      () => false,
    );
    expect(next).toHaveLength(1);
    expect((next[0].value as { value: string }).value).toBe("b");
  });

  it("数値列の判定は列ごとに渡す", () => {
    const next = applyDrillRequest(
      [],
      { mode: "apply", conditions: [{ colIdx: 2, column: "amount", value: "50" }] },
      (i) => i === 2,
    );
    expect((next[0].value as { op: string }).op).toBe("eq");
  });
});

describe("drillSummary", () => {
  it("列=値 を × でつなぐ", () => {
    expect(
      drillSummary([
        { colIdx: 0, column: "region", value: "東京" },
        { colIdx: 1, column: "status", value: "paid" },
      ]),
    ).toBe("region=東京 × status=paid");
  });

  it("NULL・空文字・長い値・改行を読みやすく畳む", () => {
    expect(drillSummary([{ colIdx: 0, column: "r", value: null }], "(NULL)")).toBe("r=(NULL)");
    expect(drillSummary([{ colIdx: 0, column: "r", value: "" }])).toBe('r=""');
    expect(drillSummary([{ colIdx: 0, column: "r", value: "a\nb" }])).toBe("r=a b");
    expect(drillSummary([{ colIdx: 0, column: "r", value: "x".repeat(40) }], "NULL", 10)).toBe(
      `r=${"x".repeat(9)}…`,
    );
  });
});
