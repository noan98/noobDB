import { describe, expect, it } from "vitest";
import {
  EMPTY_SNIPPET_QUICK_ACCESS,
  MAX_RECENT_SNIPPETS,
  forgetSnippetQuickAccess,
  isSnippetFavorite,
  normalizeSnippetQuickAccess,
  recordSnippetRun,
  toggleSnippetFavorite,
} from "../snippetQuickAccess";

describe("toggleSnippetFavorite", () => {
  it("adds when absent and removes when present", () => {
    const s1 = toggleSnippetFavorite(EMPTY_SNIPPET_QUICK_ACCESS, "abc12345");
    expect(isSnippetFavorite(s1, "abc12345")).toBe(true);
    const s2 = toggleSnippetFavorite(s1, "abc12345");
    expect(isSnippetFavorite(s2, "abc12345")).toBe(false);
  });

  it("does not touch recent", () => {
    const s = recordSnippetRun(EMPTY_SNIPPET_QUICK_ACCESS, "aaa");
    const s2 = toggleSnippetFavorite(s, "bbb");
    expect(s2.recent).toEqual(s.recent);
  });

  it("keeps insertion order (new favorites appended at the end)", () => {
    let s = toggleSnippetFavorite(EMPTY_SNIPPET_QUICK_ACCESS, "a");
    s = toggleSnippetFavorite(s, "b");
    expect(s.favorites).toEqual(["a", "b"]);
  });
});

describe("recordSnippetRun", () => {
  it("prepends new entries (most-recent first)", () => {
    let s = recordSnippetRun(EMPTY_SNIPPET_QUICK_ACCESS, "a");
    s = recordSnippetRun(s, "b");
    expect(s.recent).toEqual(["b", "a"]);
  });

  it("moves a re-run snippet back to the front without duplicating", () => {
    let s = recordSnippetRun(EMPTY_SNIPPET_QUICK_ACCESS, "a");
    s = recordSnippetRun(s, "b");
    s = recordSnippetRun(s, "a");
    expect(s.recent).toEqual(["a", "b"]);
  });

  it("does not touch favorites", () => {
    const s = toggleSnippetFavorite(EMPTY_SNIPPET_QUICK_ACCESS, "fav");
    const s2 = recordSnippetRun(s, "other");
    expect(s2.favorites).toEqual(s.favorites);
  });

  it("caps the list at MAX_RECENT_SNIPPETS", () => {
    let s = EMPTY_SNIPPET_QUICK_ACCESS;
    for (let i = 0; i < MAX_RECENT_SNIPPETS + 5; i++) {
      s = recordSnippetRun(s, `id${i}`);
    }
    expect(s.recent).toHaveLength(MAX_RECENT_SNIPPETS);
    expect(s.recent[0]).toEqual(`id${MAX_RECENT_SNIPPETS + 4}`);
  });
});

describe("forgetSnippetQuickAccess", () => {
  it("removes the id from both favorites and recent", () => {
    let s = toggleSnippetFavorite(EMPTY_SNIPPET_QUICK_ACCESS, "a");
    s = toggleSnippetFavorite(s, "b");
    s = recordSnippetRun(s, "a");
    s = recordSnippetRun(s, "c");
    const next = forgetSnippetQuickAccess(s, "a");
    expect(next.favorites).toEqual(["b"]);
    expect(next.recent).toEqual(["c"]);
  });

  it("returns the same reference when nothing changes", () => {
    const s = toggleSnippetFavorite(EMPTY_SNIPPET_QUICK_ACCESS, "a");
    expect(forgetSnippetQuickAccess(s, "does-not-exist")).toBe(s);
  });
});

describe("normalizeSnippetQuickAccess", () => {
  it("returns empty for non-objects", () => {
    expect(normalizeSnippetQuickAccess(null)).toEqual(EMPTY_SNIPPET_QUICK_ACCESS);
    expect(normalizeSnippetQuickAccess(42)).toEqual(EMPTY_SNIPPET_QUICK_ACCESS);
    expect(normalizeSnippetQuickAccess("x")).toEqual(EMPTY_SNIPPET_QUICK_ACCESS);
  });

  it("drops malformed entries and dedupes", () => {
    const s = normalizeSnippetQuickAccess({
      favorites: ["a", 42, "a", null],
      recent: ["x", "x"],
    });
    expect(s.favorites).toEqual(["a"]);
    expect(s.recent).toEqual(["x"]);
  });

  it("clamps recent to MAX_RECENT_SNIPPETS", () => {
    const recent = Array.from({ length: MAX_RECENT_SNIPPETS + 8 }, (_, i) => `id${i}`);
    const s = normalizeSnippetQuickAccess({ recent });
    expect(s.recent).toHaveLength(MAX_RECENT_SNIPPETS);
  });
});
