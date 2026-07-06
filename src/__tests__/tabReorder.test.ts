import { describe, expect, it } from "vitest";
import { moveTabBy, moveTabToIndex, reorderIfPermutation } from "../tabReorder";

describe("reorderIfPermutation", () => {
  it("accepts a valid permutation and returns the proposed order", () => {
    expect(reorderIfPermutation(["a", "b", "c"], ["c", "a", "b"])).toEqual(["c", "a", "b"]);
  });

  it("accepts an identity order", () => {
    expect(reorderIfPermutation(["a", "b"], ["a", "b"])).toEqual(["a", "b"]);
  });

  it("rejects a list of a different length (dropped id)", () => {
    expect(reorderIfPermutation(["a", "b", "c"], ["a", "b"])).toBeNull();
  });

  it("rejects a list with a duplicated id (would drop a tab)", () => {
    expect(reorderIfPermutation(["a", "b", "c"], ["a", "a", "b"])).toBeNull();
  });

  it("rejects a list that smuggles in a foreign id", () => {
    expect(reorderIfPermutation(["a", "b", "c"], ["a", "b", "x"])).toBeNull();
  });

  it("handles empty arrays", () => {
    expect(reorderIfPermutation([], [])).toEqual([]);
  });
});

describe("moveTabToIndex", () => {
  it("moves an element forward", () => {
    expect(moveTabToIndex(["a", "b", "c", "d"], "a", 2)).toEqual(["b", "c", "a", "d"]);
  });

  it("moves an element backward", () => {
    expect(moveTabToIndex(["a", "b", "c", "d"], "d", 0)).toEqual(["d", "a", "b", "c"]);
  });

  it("clamps a target index past the end", () => {
    expect(moveTabToIndex(["a", "b", "c"], "a", 99)).toEqual(["b", "c", "a"]);
  });

  it("clamps a negative target index to the start", () => {
    expect(moveTabToIndex(["a", "b", "c"], "c", -5)).toEqual(["c", "a", "b"]);
  });

  it("truncates a fractional target index", () => {
    expect(moveTabToIndex(["a", "b", "c"], "a", 1.9)).toEqual(["b", "a", "c"]);
  });

  it("returns the same array reference when the id is unknown", () => {
    const order = ["a", "b", "c"];
    expect(moveTabToIndex(order, "z", 1)).toBe(order);
  });

  it("returns the same array reference when the target equals the source", () => {
    const order = ["a", "b", "c"];
    expect(moveTabToIndex(order, "b", 1)).toBe(order);
  });

  it("does not mutate the input array", () => {
    const order = ["a", "b", "c"];
    moveTabToIndex(order, "a", 2);
    expect(order).toEqual(["a", "b", "c"]);
  });
});

describe("moveTabBy", () => {
  it("shifts an element one step right", () => {
    expect(moveTabBy(["a", "b", "c"], "a", 1)).toEqual(["b", "a", "c"]);
  });

  it("shifts an element one step left", () => {
    expect(moveTabBy(["a", "b", "c"], "c", -1)).toEqual(["a", "c", "b"]);
  });

  it("stops at the right edge (no wrap)", () => {
    const order = ["a", "b", "c"];
    expect(moveTabBy(order, "c", 1)).toBe(order);
  });

  it("stops at the left edge (no wrap)", () => {
    const order = ["a", "b", "c"];
    expect(moveTabBy(order, "a", -1)).toBe(order);
  });

  it("returns the input unchanged for an unknown id", () => {
    const order = ["a", "b", "c"];
    expect(moveTabBy(order, "z", 1)).toBe(order);
  });
});
