import { describe, expect, it } from "vitest";
import type { CellValue, Column } from "../api/tauri";
import { buildGridInsertSelection, planGridInsert } from "../components/gridDragInsert";

const col = (name: string, type_name: string): Column => ({ name, type_name });
const id = col("id", "BIGINT");
const name = col("name", "VARCHAR");
const sel = (driver: string, columns: Column[], rows: CellValue[][], masked = false) => ({
  driver,
  columns,
  rows,
  masked,
});
const text = (p: ReturnType<typeof planGridInsert>) => {
  if (!p.ok) throw new Error(`blocked: ${p.reason}`);
  return p.text;
};

describe("planGridInsert", () => {
  it("1 セル: 型付きリテラル (3 ドライバの引用符規則)", () => {
    expect(text(planGridInsert("auto", sel("mysql", [name], [["it's"]])))).toBe("'it''s'");
    expect(text(planGridInsert("auto", sel("postgres", [id], [[42]])))).toBe("42");
    expect(text(planGridInsert("auto", sel("sqlite", [name], [[null]])))).toBe("NULL");
  });

  it("1 セル: 2^53 を超える整数を丸めない (文字列のまま裸の数値)", () => {
    expect(text(planGridInsert("auto", sel("mysql", [id], [["9007199254740993"]])))).toBe("9007199254740993");
    expect(text(planGridInsert("where", sel("postgres", [id], [["-9223372036854775808"]])))).toBe(
      '"id" = -9223372036854775808',
    );
    expect(
      text(planGridInsert("in", sel("sqlite", [id], [["9007199254740993"], ["9007199254740995"]]))),
    ).toBe('"id" IN (9007199254740993, 9007199254740995)');
  });

  it("1 セルの where: = / NULL は IS NULL", () => {
    expect(text(planGridInsert("where", sel("mysql", [name], [["a"]])))).toBe("`name` = 'a'");
    expect(text(planGridInsert("where", sel("mysql", [name], [[null]])))).toBe("`name` IS NULL");
  });

  it("1 列の複数セル: IN リスト。重複を除き順序は保つ", () => {
    expect(text(planGridInsert("auto", sel("postgres", [id], [[3], [1], [3], [2], [1]])))).toBe(
      '"id" IN (3, 1, 2)',
    );
  });

  it("IN リストの NULL: IN に入れず IS NULL を OR で足す / NULL だけなら IS NULL", () => {
    expect(text(planGridInsert("in", sel("mysql", [id], [[1], [null], [2], [null]])))).toBe(
      "(`id` IN (1, 2) OR `id` IS NULL)",
    );
    expect(text(planGridInsert("in", sel("mysql", [id], [[null], [null]])))).toBe("`id` IS NULL");
  });

  it("1 列の where は IN と同じ", () => {
    expect(text(planGridInsert("where", sel("mysql", [name], [["a"], ["b"]])))).toBe("`name` IN ('a', 'b')");
  });

  it("1 行の複数列: AND 条件 (NULL は IS NULL)", () => {
    expect(text(planGridInsert("auto", sel("postgres", [id, name], [[1, "x"]])))).toBe(
      `"id" = 1 AND "name" = 'x'`,
    );
    expect(text(planGridInsert("auto", sel("sqlite", [id, name], [[1, null]])))).toBe(
      `"id" = 1 AND "name" IS NULL`,
    );
  });

  it("列名のクオートは識別子中の引用符を倍にする", () => {
    expect(text(planGridInsert("where", sel("postgres", [col('a"b', "TEXT")], [["x"]])))).toBe(
      `"a""b" = 'x'`,
    );
    expect(text(planGridInsert("where", sel("mysql", [col("a`b", "TEXT")], [["x"]])))).toBe("`a``b` = 'x'");
  });

  it("BLOB: 16 進リテラルで挿入する", () => {
    const blob = col("data", "BLOB");
    expect(text(planGridInsert("auto", sel("mysql", [blob], [["deadbeef"]])))).toBe("0xdeadbeef");
    expect(text(planGridInsert("auto", sel("sqlite", [blob], [["deadbeef"]])))).toBe("X'deadbeef'");
    expect(text(planGridInsert("auto", sel("postgres", [blob], [["deadbeef"]])))).toBe("'\\xdeadbeef'");
  });

  it("複数行 × 複数列と、IN の複数列は shape で拒否する", () => {
    expect(
      planGridInsert(
        "auto",
        sel(
          "mysql",
          [id, name],
          [
            [1, "a"],
            [2, "b"],
          ],
        ),
      ),
    ).toEqual({
      ok: false,
      reason: "shape",
    });
    expect(planGridInsert("in", sel("mysql", [id, name], [[1, "a"]]))).toEqual({
      ok: false,
      reason: "shape",
    });
  });

  it("マスク中のセルを含むと値を出さず masked で拒否する", () => {
    expect(planGridInsert("auto", sel("mysql", [id], [[1]], true))).toEqual({ ok: false, reason: "masked" });
  });

  it("空の選択は empty", () => {
    expect(planGridInsert("auto", sel("mysql", [], []))).toEqual({ ok: false, reason: "empty" });
  });

  it("ラベルは 1 行に畳んで長いものは省略する", () => {
    const p = planGridInsert("auto", sel("mysql", [name], [["a\nb" + "x".repeat(100)]]));
    expect(p.ok && p.label.length).toBeLessThanOrEqual(40);
    expect(p.ok && p.label).not.toContain("\n");
  });
});

describe("buildGridInsertSelection", () => {
  const columns = [id, name];
  const rows: CellValue[][] = [
    [1, "a"],
    [2, "b"],
  ];
  it("元の index から行列を作る (表示順を保つ)", () => {
    const s = buildGridInsertSelection({
      driver: "mysql",
      columns,
      rows,
      rowIndices: [1, 0],
      colIndices: [1],
      isMasked: () => false,
    });
    expect(s.rows).toEqual([["b"], ["a"]]);
    expect(s.columns).toEqual([name]);
  });
  it("マスク中のセルを含むと値を載せない", () => {
    const s = buildGridInsertSelection({
      driver: "mysql",
      columns,
      rows,
      rowIndices: [0, 1],
      colIndices: [0, 1],
      isMasked: (r, c) => r === 1 && c === 1,
    });
    expect(s.masked).toBe(true);
    expect(s.rows).toEqual([]);
    expect(planGridInsert("auto", s)).toEqual({ ok: false, reason: "masked" });
  });
});
