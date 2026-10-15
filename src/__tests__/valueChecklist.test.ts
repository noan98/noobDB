import { describe, expect, it } from "vitest";
import {
  buildHandleRequest,
  columnFilterPasses,
  distinctValueOptions,
  isColumnFilterActive,
  isServerInSafeValue,
  type ColumnFilter,
} from "../components/gridSortFilter";

const inFilter = (values: string[]): ColumnFilter => ({
  op: "in",
  value: "",
  value2: "",
  nullMode: "any",
  values,
});

describe("in フィルタ (値のチェックリスト, #1628)", () => {
  it("選んだ値のいずれかに完全一致 (大小区別) した行だけ通す", () => {
    const f = inFilter(["open", "closed"]);
    expect(columnFilterPasses("open", f)).toBe(true);
    expect(columnFilterPasses("Open", f)).toBe(false);
    expect(columnFilterPasses("pending", f)).toBe(false);
  });
  it("NULL は値条件に一致しない", () => {
    expect(columnFilterPasses(null, inFilter(["a"]))).toBe(false);
  });
  it("数値・真偽値は文字列表現で照合する", () => {
    const f = inFilter(["1", "true"]);
    expect(columnFilterPasses(1, f)).toBe(true);
    expect(columnFilterPasses(true, f)).toBe(true);
    expect(columnFilterPasses(2, f)).toBe(false);
  });
  it("values が空なら絞り込みにならない", () => {
    expect(isColumnFilterActive(inFilter([]))).toBe(false);
    expect(isColumnFilterActive(inFilter(["a"]))).toBe(true);
  });
  it("ハンドル向けの要求に values が載る", () => {
    const req = buildHandleRequest([], [{ id: "0", value: inFilter(["a", "b"]) }], "", ["string"]);
    expect(req.filters[0]).toMatchObject({ col: 0, op: "in", values: ["a", "b"] });
  });
});

describe("distinctValueOptions (#1628)", () => {
  const rows = [["b"], ["a"], ["b"], [null], ["c"], ["b"], ["a"]];
  it("出現数の多い順、同数は値の昇順で NULL を除いて返す", () => {
    expect(distinctValueOptions(rows, 0)).toEqual([
      { value: "b", count: 3 },
      { value: "a", count: 2 },
      { value: "c", count: 1 },
    ]);
  });
  it("種類が上限を超えたら null", () => {
    expect(distinctValueOptions(rows, 0, 2)).toBeNull();
    expect(distinctValueOptions(rows, 0, 3)).not.toBeNull();
  });
  it("行が無ければ空配列", () => {
    expect(distinctValueOptions([], 0)).toEqual([]);
  });
});

describe("isServerInSafeValue (#1628)", () => {
  it("カンマ・改行・前後空白・空文字はサーバ側 in に往復できない", () => {
    expect(isServerInSafeValue("open")).toBe(true);
    expect(isServerInSafeValue("a,b")).toBe(false);
    expect(isServerInSafeValue("a\nb")).toBe(false);
    expect(isServerInSafeValue(" a")).toBe(false);
    expect(isServerInSafeValue("")).toBe(false);
  });
});
