import { describe, it, expect } from "vitest";
import {
  fuzzyMatch,
  scoreItem,
  groupCommands,
  flattenGroups,
  splitLabel,
  singleLine,
  GROUP_ORDER,
  type CommandItem,
} from "../components/commandPalette";

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
