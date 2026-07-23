import { describe, expect, it } from "vitest";
import {
  applyGroupOrder,
  applySubsequenceOrder,
  moveItemBy,
  reorderIfPermutation,
} from "../connectionOrder";

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

  it("rejects a list with a duplicated id (would drop a profile)", () => {
    expect(reorderIfPermutation(["a", "b", "c"], ["a", "a", "b"])).toBeNull();
  });

  it("rejects a list that smuggles in a foreign id", () => {
    expect(reorderIfPermutation(["a", "b", "c"], ["a", "b", "x"])).toBeNull();
  });

  it("handles empty arrays", () => {
    expect(reorderIfPermutation([], [])).toEqual([]);
  });
});

describe("moveItemBy", () => {
  it("shifts an element one step forward", () => {
    expect(moveItemBy(["a", "b", "c"], "a", 1)).toEqual(["b", "a", "c"]);
  });

  it("shifts an element one step backward", () => {
    expect(moveItemBy(["a", "b", "c"], "c", -1)).toEqual(["a", "c", "b"]);
  });

  it("stops at the right edge (no wrap, same reference)", () => {
    const order = ["a", "b", "c"];
    expect(moveItemBy(order, "c", 1)).toBe(order);
  });

  it("stops at the left edge (no wrap, same reference)", () => {
    const order = ["a", "b", "c"];
    expect(moveItemBy(order, "a", -1)).toBe(order);
  });

  it("returns the same reference when the id is unknown", () => {
    const order = ["a", "b", "c"];
    expect(moveItemBy(order, "z", 1)).toBe(order);
  });

  it("does not mutate the input array", () => {
    const order = ["a", "b", "c"];
    moveItemBy(order, "a", 1);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("supports multi-step deltas", () => {
    expect(moveItemBy(["a", "b", "c", "d"], "a", 2)).toEqual(["b", "c", "a", "d"]);
  });
});

describe("applySubsequenceOrder", () => {
  it("reorders only the members of the subsequence, keeping others fixed", () => {
    // group "x" = a, c, e (in that relative order); b, d belong to other groups.
    const order = ["a", "b", "c", "d", "e"];
    const newGroupOrder = ["e", "a", "c"]; // move "e" to the front of its group
    expect(applySubsequenceOrder(order, newGroupOrder)).toEqual(["e", "b", "a", "d", "c"]);
  });

  it("returns the same reference when nothing actually moves", () => {
    const order = ["a", "b", "c"];
    expect(applySubsequenceOrder(order, ["a", "c"])).toBe(order);
  });

  it("returns the same reference when subOrder has a duplicate", () => {
    const order = ["a", "b", "c"];
    expect(applySubsequenceOrder(order, ["a", "a"])).toBe(order);
  });

  it("returns the same reference when subOrder smuggles in a foreign id", () => {
    const order = ["a", "b", "c"];
    expect(applySubsequenceOrder(order, ["a", "x"])).toBe(order);
  });

  it("returns the same reference when subOrder has fewer members than order actually has", () => {
    // order has two "a"-group members conceptually but subOrder only lists one.
    const order = ["a", "b", "c"];
    expect(applySubsequenceOrder(order, ["a", "b", "c", "d"])).toBe(order);
  });

  it("returns the same reference for an empty subOrder", () => {
    const order = ["a", "b", "c"];
    expect(applySubsequenceOrder(order, [])).toBe(order);
  });

  it("does not mutate the input array", () => {
    const order = ["a", "b", "c", "d"];
    applySubsequenceOrder(order, ["d", "a"]);
    expect(order).toEqual(["a", "b", "c", "d"]);
  });

  it("moves a whole group to the front (ungrouped-interleaved case)", () => {
    // Profiles: g1a(group1) u1(none) g1b(group1) u2(none) g2a(group2)
    const order = ["g1a", "u1", "g1b", "u2", "g2a"];
    // Reordering group1's own two members (swap them) shouldn't touch u1/u2/g2a.
    const moved = applySubsequenceOrder(order, ["g1b", "g1a"]);
    expect(moved).toEqual(["g1b", "u1", "g1a", "u2", "g2a"]);
  });
});

describe("applyGroupOrder", () => {
  it("falls back to alphabetical order when nothing is stored (default behavior)", () => {
    expect(applyGroupOrder(["zeta", "alpha", "mid"], [])).toEqual(["alpha", "mid", "zeta"]);
  });

  it("keeps the stored relative order for known groups", () => {
    expect(applyGroupOrder(["alpha", "mid", "zeta"], ["zeta", "alpha", "mid"])).toEqual([
      "zeta",
      "alpha",
      "mid",
    ]);
  });

  it("appends new (never-reordered) groups alphabetically after the known ones", () => {
    expect(applyGroupOrder(["zeta", "alpha", "mid", "new-b", "new-a"], ["zeta", "alpha"])).toEqual([
      "zeta",
      "alpha",
      "mid",
      "new-a",
      "new-b",
    ]);
  });

  it("drops stored names that no longer exist", () => {
    expect(applyGroupOrder(["alpha"], ["gone", "alpha"])).toEqual(["alpha"]);
  });

  it("returns a true permutation of names (same length/elements)", () => {
    const names = ["c", "a", "b"];
    const result = applyGroupOrder(names, ["b"]);
    expect(result.length).toBe(names.length);
    expect(new Set(result)).toEqual(new Set(names));
  });

  it("handles no groups at all", () => {
    expect(applyGroupOrder([], ["stale"])).toEqual([]);
  });
});
