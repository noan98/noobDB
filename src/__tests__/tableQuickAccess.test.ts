import { describe, expect, it } from "vitest";
import {
  EMPTY_QUICK_ACCESS,
  MAX_RECENT,
  isFavorite,
  normalizeQuickAccess,
  pruneMissing,
  recordRecent,
  removeFavorite,
  tableRefEquals,
  toggleFavorite,
} from "../tableQuickAccess";

const ref = (database: string, table: string) => ({ database, table });

describe("tableRefEquals", () => {
  it("matches on both database and table", () => {
    expect(tableRefEquals(ref("a", "t"), ref("a", "t"))).toBe(true);
    expect(tableRefEquals(ref("a", "t"), ref("b", "t"))).toBe(false);
    expect(tableRefEquals(ref("a", "t"), ref("a", "u"))).toBe(false);
  });
});

describe("toggleFavorite", () => {
  it("adds when absent and removes when present", () => {
    const s1 = toggleFavorite(EMPTY_QUICK_ACCESS, ref("db", "users"));
    expect(isFavorite(s1, ref("db", "users"))).toBe(true);
    const s2 = toggleFavorite(s1, ref("db", "users"));
    expect(isFavorite(s2, ref("db", "users"))).toBe(false);
  });

  it("does not touch recent", () => {
    const s = recordRecent(EMPTY_QUICK_ACCESS, ref("db", "a"));
    const s2 = toggleFavorite(s, ref("db", "b"));
    expect(s2.recent).toEqual(s.recent);
  });

  it("treats same table in different databases as distinct", () => {
    let s = toggleFavorite(EMPTY_QUICK_ACCESS, ref("db1", "users"));
    s = toggleFavorite(s, ref("db2", "users"));
    expect(s.favorites).toHaveLength(2);
  });
});

describe("removeFavorite", () => {
  it("removes only the matching ref", () => {
    let s = toggleFavorite(EMPTY_QUICK_ACCESS, ref("db", "a"));
    s = toggleFavorite(s, ref("db", "b"));
    s = removeFavorite(s, ref("db", "a"));
    expect(s.favorites).toEqual([ref("db", "b")]);
  });
});

describe("recordRecent", () => {
  it("prepends new entries (most-recent first)", () => {
    let s = recordRecent(EMPTY_QUICK_ACCESS, ref("db", "a"));
    s = recordRecent(s, ref("db", "b"));
    expect(s.recent).toEqual([ref("db", "b"), ref("db", "a")]);
  });

  it("moves a re-opened table back to the front without duplicating", () => {
    let s = recordRecent(EMPTY_QUICK_ACCESS, ref("db", "a"));
    s = recordRecent(s, ref("db", "b"));
    s = recordRecent(s, ref("db", "a"));
    expect(s.recent).toEqual([ref("db", "a"), ref("db", "b")]);
  });

  it("caps the list at MAX_RECENT", () => {
    let s = EMPTY_QUICK_ACCESS;
    for (let i = 0; i < MAX_RECENT + 5; i++) {
      s = recordRecent(s, ref("db", `t${i}`));
    }
    expect(s.recent).toHaveLength(MAX_RECENT);
    // The most recent insert should be at the head.
    expect(s.recent[0]).toEqual(ref("db", `t${MAX_RECENT + 4}`));
  });
});

describe("normalizeQuickAccess", () => {
  it("returns empty for non-objects", () => {
    expect(normalizeQuickAccess(null)).toEqual(EMPTY_QUICK_ACCESS);
    expect(normalizeQuickAccess(42)).toEqual(EMPTY_QUICK_ACCESS);
    expect(normalizeQuickAccess("x")).toEqual(EMPTY_QUICK_ACCESS);
  });

  it("drops malformed entries and dedupes", () => {
    const s = normalizeQuickAccess({
      favorites: [ref("db", "a"), { database: "db" }, ref("db", "a"), "nope"],
      recent: [ref("db", "x"), ref("db", "x")],
    });
    expect(s.favorites).toEqual([ref("db", "a")]);
    expect(s.recent).toEqual([ref("db", "x")]);
  });

  it("clamps recent to MAX_RECENT", () => {
    const recent = Array.from({ length: MAX_RECENT + 8 }, (_, i) => ref("db", `t${i}`));
    const s = normalizeQuickAccess({ recent });
    expect(s.recent).toHaveLength(MAX_RECENT);
  });
});

describe("pruneMissing", () => {
  it("removes refs no longer present in the schema", () => {
    let s = toggleFavorite(EMPTY_QUICK_ACCESS, ref("db", "a"));
    s = toggleFavorite(s, ref("db", "gone"));
    s = recordRecent(s, ref("db", "gone"));
    s = recordRecent(s, ref("db", "a"));
    const pruned = pruneMissing(s, [ref("db", "a")]);
    expect(pruned.favorites).toEqual([ref("db", "a")]);
    expect(pruned.recent).toEqual([ref("db", "a")]);
  });

  it("returns the same reference when nothing changes", () => {
    const s = toggleFavorite(EMPTY_QUICK_ACCESS, ref("db", "a"));
    expect(pruneMissing(s, [ref("db", "a")])).toBe(s);
  });
});
