import { describe, it, expect } from "vitest";
import {
  fuzzyMatch,
  scoreItem,
  groupCommands,
  flattenGroups,
  splitLabel,
  singleLine,
  sanitizeMruIds,
  recordMruUsage,
  pruneMruIds,
  shouldStaggerEntrance,
  MAX_MRU_ITEMS,
  MAX_STAGGER_ITEMS,
  GROUP_ORDER,
  type CommandItem,
} from "../components/commandPaletteSearch";

const noop = () => {};

function item(partial: Partial<CommandItem> & Pick<CommandItem, "id" | "group" | "label">): CommandItem {
  return { run: noop, ...partial };
}

describe("fuzzyMatch", () => {
  it("treats an empty query as a match with no ranges", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, ranges: [] });
  });

  it("returns null when not all query chars appear in order", () => {
    expect(fuzzyMatch("xyz", "users")).toBeNull();
    // in-order subsequence matches; reversed order does not
    expect(fuzzyMatch("us", "users")).not.toBeNull();
    expect(fuzzyMatch("su", "users")).toBeNull();
    expect(fuzzyMatch("zu", "users")).toBeNull();
  });

  it("matches a contiguous substring and reports a single range", () => {
    const m = fuzzyMatch("ser", "users");
    expect(m).not.toBeNull();
    expect(m!.ranges).toEqual([[1, 4]]);
  });

  it("matches a non-contiguous subsequence with multiple ranges", () => {
    const m = fuzzyMatch("oi", "order_id");
    expect(m).not.toBeNull();
    // 'o' at 0, 'i' at 6 -> two separate single-char ranges
    expect(m!.ranges).toEqual([
      [0, 1],
      [6, 7],
    ]);
  });

  it("is case-insensitive", () => {
    expect(fuzzyMatch("USR", "users")).not.toBeNull();
    expect(fuzzyMatch("usr", "USERS")).not.toBeNull();
  });

  it("scores word-boundary and contiguous matches higher", () => {
    // "ut" as a prefix of a word vs scattered in the middle
    const prefix = fuzzyMatch("us", "users")!;
    const scattered = fuzzyMatch("us", "abusiness")!;
    expect(prefix.score).toBeGreaterThan(scattered.score);
  });

  it("rewards a match that starts at a word boundary", () => {
    // "name" starting right after the underscore beats a mid-word start
    const boundary = fuzzyMatch("name", "order_name")!;
    const midword = fuzzyMatch("name", "rename")!;
    expect(boundary.score).toBeGreaterThan(midword.score);
  });

  it("ranks a short exact prefix above a longer string sharing the prefix", () => {
    // The grouping UI relies on this: "users" should beat "user_sessions".
    const exact = fuzzyMatch("users", "users")!;
    const longer = fuzzyMatch("users", "user_sessions")!;
    expect(exact.score).toBeGreaterThan(longer.score);
  });
});

describe("scoreItem", () => {
  const it1 = item({ id: "a", group: "tables", label: "orders", keywords: "shop sales" });

  it("matches an empty query with score 0 and no ranges", () => {
    const s = scoreItem(it1, "");
    expect(s).toEqual({ item: it1, score: 0, ranges: [] });
  });

  it("returns ranges into the label when the label matches", () => {
    const s = scoreItem(it1, "ord");
    expect(s).not.toBeNull();
    expect(s!.ranges).toEqual([[0, 3]]);
  });

  it("matches via keywords/sublabel without label ranges", () => {
    const s = scoreItem(it1, "sales");
    expect(s).not.toBeNull();
    expect(s!.ranges).toEqual([]);
  });

  it("ranks a label match above a keyword-only match", () => {
    const labelHit = item({ id: "x", group: "tables", label: "sales", keywords: "" });
    const keywordHit = item({ id: "y", group: "tables", label: "orders", keywords: "sales report" });
    const a = scoreItem(labelHit, "sales")!;
    const b = scoreItem(keywordHit, "sales")!;
    expect(a.score).toBeGreaterThan(b.score);
  });

  it("returns null when neither label nor keywords match", () => {
    expect(scoreItem(it1, "zzz")).toBeNull();
  });
});

describe("groupCommands", () => {
  const items: CommandItem[] = [
    item({ id: "h1", group: "history", label: "select * from logs" }),
    item({ id: "t1", group: "tables", label: "users" }),
    item({ id: "n1", group: "navigation", label: "Open settings" }),
    item({ id: "t2", group: "tables", label: "user_sessions" }),
    item({ id: "s1", group: "snippets", label: "count users" }),
  ];

  it("keeps groups in GROUP_ORDER and drops empty ones", () => {
    const grouped = groupCommands(items, "");
    const order = grouped.map((g) => g.group);
    // navigation, tables, snippets, history present; connections absent
    expect(order).toEqual(["navigation", "tables", "snippets", "history"]);
    // order respects the canonical GROUP_ORDER
    const canonical = GROUP_ORDER.filter((g) => order.includes(g));
    expect(order).toEqual(canonical);
  });

  it("preserves input order within a group when query is empty", () => {
    const grouped = groupCommands(items, "");
    const tables = grouped.find((g) => g.group === "tables")!;
    expect(tables.items.map((s) => s.item.id)).toEqual(["t1", "t2"]);
  });

  it("filters out non-matching items and only keeps matching groups", () => {
    const grouped = groupCommands(items, "user");
    const groups = grouped.map((g) => g.group);
    expect(groups).toEqual(["tables", "snippets"]);
    const tables = grouped.find((g) => g.group === "tables")!;
    expect(tables.items.map((s) => s.item.id).sort()).toEqual(["t1", "t2"]);
  });

  it("sorts within a group by score descending when query is non-empty", () => {
    const grouped = groupCommands(items, "users");
    const tables = grouped.find((g) => g.group === "tables")!;
    // "users" (exact) should outrank "user_sessions" (subsequence with gap)
    expect(tables.items[0].item.id).toBe("t1");
  });
});

describe("flattenGroups", () => {
  it("flattens grouped commands into display order", () => {
    const items: CommandItem[] = [
      item({ id: "t1", group: "tables", label: "users" }),
      item({ id: "n1", group: "navigation", label: "settings" }),
    ];
    const flat = flattenGroups(groupCommands(items, ""));
    // navigation comes before tables per GROUP_ORDER
    expect(flat.map((s) => s.item.id)).toEqual(["n1", "t1"]);
  });
});

describe("splitLabel", () => {
  it("returns the whole label unhighlighted when there are no ranges", () => {
    expect(splitLabel("users", [])).toEqual([{ text: "users", highlighted: false }]);
  });

  it("splits around a single range", () => {
    expect(splitLabel("users", [[1, 4]])).toEqual([
      { text: "u", highlighted: false },
      { text: "ser", highlighted: true },
      { text: "s", highlighted: false },
    ]);
  });

  it("handles a leading range with no trailing remainder", () => {
    expect(splitLabel("ab", [[0, 2]])).toEqual([{ text: "ab", highlighted: true }]);
  });

  it("splits around multiple ranges", () => {
    expect(splitLabel("order_id", [[0, 1], [6, 8]])).toEqual([
      { text: "o", highlighted: true },
      { text: "rder_", highlighted: false },
      { text: "id", highlighted: true },
    ]);
  });
});

describe("groupCommands: mru (#845)", () => {
  const items: CommandItem[] = [
    item({ id: "h1", group: "history", label: "select * from logs" }),
    item({ id: "t1", group: "tables", label: "users" }),
    item({ id: "n1", group: "navigation", label: "Open settings" }),
    item({ id: "t2", group: "tables", label: "user_sessions" }),
    item({ id: "s1", group: "snippets", label: "count users" }),
  ];

  it("prepends a mru group (in mruIds order) when the query is empty", () => {
    const grouped = groupCommands(items, "", ["s1", "t2"]);
    expect(grouped[0].group).toBe("mru");
    expect(grouped[0].items.map((s) => s.item.id)).toEqual(["s1", "t2"]);
  });

  it("removes mru'd items from their original group instead of duplicating them", () => {
    const grouped = groupCommands(items, "", ["t2"]);
    const tables = grouped.find((g) => g.group === "tables")!;
    // t2 now lives only in the mru group; t1 is untouched.
    expect(tables.items.map((s) => s.item.id)).toEqual(["t1"]);
    const mru = grouped.find((g) => g.group === "mru")!;
    expect(mru.items.map((s) => s.item.id)).toEqual(["t2"]);
  });

  it("silently skips mru ids that no longer match any item", () => {
    const grouped = groupCommands(items, "", ["gone", "t1"]);
    const mru = grouped.find((g) => g.group === "mru")!;
    expect(mru.items.map((s) => s.item.id)).toEqual(["t1"]);
  });

  it("omits the mru group entirely when no id matches", () => {
    const grouped = groupCommands(items, "", ["gone"]);
    expect(grouped.some((g) => g.group === "mru")).toBe(false);
  });

  it("omits the mru group when mruIds is empty", () => {
    const grouped = groupCommands(items, "", []);
    expect(grouped.some((g) => g.group === "mru")).toBe(false);
  });

  it("ignores mru entirely once the query is non-empty", () => {
    const grouped = groupCommands(items, "user", ["t2"]);
    expect(grouped.some((g) => g.group === "mru")).toBe(false);
    // t2 is back in its normal group, matched by the query as usual.
    const tables = grouped.find((g) => g.group === "tables")!;
    expect(tables.items.map((s) => s.item.id).sort()).toEqual(["t1", "t2"]);
  });

  it("defaults to no mru section when mruIds is omitted", () => {
    const grouped = groupCommands(items, "");
    expect(grouped.some((g) => g.group === "mru")).toBe(false);
  });
});

describe("sanitizeMruIds (#845)", () => {
  it("returns an empty array for non-array input", () => {
    expect(sanitizeMruIds(undefined)).toEqual([]);
    expect(sanitizeMruIds(null)).toEqual([]);
    expect(sanitizeMruIds("conn:a")).toEqual([]);
    expect(sanitizeMruIds({ 0: "conn:a" })).toEqual([]);
  });

  it("drops non-string and empty-string entries", () => {
    expect(sanitizeMruIds(["conn:a", 1, null, undefined, {}, "", "table:t"])).toEqual([
      "conn:a",
      "table:t",
    ]);
  });

  it("de-duplicates, keeping only the first (most recent) occurrence", () => {
    expect(sanitizeMruIds(["conn:a", "table:t", "conn:a"])).toEqual(["conn:a", "table:t"]);
  });

  it("clamps to MAX_MRU_ITEMS", () => {
    const many = Array.from({ length: MAX_MRU_ITEMS + 3 }, (_, i) => `id:${i}`);
    expect(sanitizeMruIds(many)).toEqual(many.slice(0, MAX_MRU_ITEMS));
  });
});

describe("recordMruUsage (#845)", () => {
  it("inserts a new id at the front", () => {
    expect(recordMruUsage([], "conn:a")).toEqual(["conn:a"]);
    expect(recordMruUsage(["conn:a"], "table:t")).toEqual(["table:t", "conn:a"]);
  });

  it("moves an existing id to the front instead of duplicating it", () => {
    expect(recordMruUsage(["conn:a", "table:t", "snippet:s"], "table:t")).toEqual([
      "table:t",
      "conn:a",
      "snippet:s",
    ]);
  });

  it("truncates once the cap is exceeded, dropping the oldest entry", () => {
    const full = Array.from({ length: MAX_MRU_ITEMS }, (_, i) => `id:${i}`);
    const next = recordMruUsage(full, "id:new");
    expect(next).toHaveLength(MAX_MRU_ITEMS);
    expect(next[0]).toBe("id:new");
    expect(next).not.toContain(`id:${MAX_MRU_ITEMS - 1}`);
  });
});

describe("pruneMruIds (#845)", () => {
  it("removes ids the predicate rejects", () => {
    expect(pruneMruIds(["a", "b", "c"], (id) => id !== "b")).toEqual(["a", "c"]);
  });

  it("returns the same array instance when nothing is removed", () => {
    const input = ["a", "b"];
    expect(pruneMruIds(input, () => true)).toBe(input);
  });

  it("returns an empty array when every id is rejected", () => {
    expect(pruneMruIds(["a", "b"], () => false)).toEqual([]);
  });
});

describe("CommandItem.shortcut (#843)", () => {
  it("carries the shortcut hint through scoring and grouping unchanged", () => {
    const withShortcut = item({
      id: "n1",
      group: "navigation",
      label: "New tab",
      shortcut: "Cmd/Ctrl+T",
    });
    const scored = scoreItem(withShortcut, "");
    expect(scored?.item.shortcut).toBe("Cmd/Ctrl+T");
    const grouped = groupCommands([withShortcut], "");
    expect(grouped[0].items[0].item.shortcut).toBe("Cmd/Ctrl+T");
  });

  it("is optional and left undefined when the caller omits it", () => {
    const withoutShortcut = item({ id: "n2", group: "navigation", label: "Help" });
    expect(withoutShortcut.shortcut).toBeUndefined();
  });
});

describe("shouldStaggerEntrance (#976)", () => {
  it("is true for indices within the cap", () => {
    expect(shouldStaggerEntrance(0)).toBe(true);
    expect(shouldStaggerEntrance(MAX_STAGGER_ITEMS - 1)).toBe(true);
  });

  it("is false once the index reaches the cap (avoids staggered-reveal lag on large result sets)", () => {
    expect(shouldStaggerEntrance(MAX_STAGGER_ITEMS)).toBe(false);
    expect(shouldStaggerEntrance(MAX_STAGGER_ITEMS + 50)).toBe(false);
  });

  it("is false for a not-found index (-1, e.g. flat.indexOf miss)", () => {
    expect(shouldStaggerEntrance(-1)).toBe(false);
  });
});

describe("singleLine", () => {
  it("collapses whitespace and trims", () => {
    expect(singleLine("  select\n  *\tfrom users  ")).toBe("select * from users");
  });

  it("truncates with an ellipsis past the limit", () => {
    const out = singleLine("abcdefghij", 5);
    expect(out).toBe("abcd…");
    expect(out.length).toBe(5);
  });

  it("leaves short strings intact", () => {
    expect(singleLine("short", 100)).toBe("short");
  });
});
