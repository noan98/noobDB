import { describe, expect, it } from "vitest";
import type { Snippet } from "../api/tauri";
import { SNIPPET_COPY_ID, snippetBodyExcerpt, snippetCopyDraft, snippetMatchesQuery } from "../snippetSearch";

const snip = (over: Partial<Snippet> = {}): Snippet => ({
  id: "abc12345",
  name: "Active users",
  folder: "reports",
  tags: ["daily"],
  sql: "SELECT id,\n  email\nFROM users\nWHERE last_login > now() - interval '30 days'",
  driver: null,
  scope: { kind: "any" },
  ...over,
});

describe("snippetMatchesQuery", () => {
  it("名前・フォルダ・本文・タグのどれかに一致する", () => {
    expect(snippetMatchesQuery(snip(), "active")).toBe(true);
    expect(snippetMatchesQuery(snip(), "report")).toBe(true);
    expect(snippetMatchesQuery(snip(), "interval")).toBe(true);
    expect(snippetMatchesQuery(snip(), "dail")).toBe(true);
    expect(snippetMatchesQuery(snip(), "nothing")).toBe(false);
  });
});

describe("snippetBodyExcerpt", () => {
  it("本文だけが一致したときに前後を含む抜粋を返す", () => {
    const out = snippetBodyExcerpt(snip(), "last_login");
    expect(out).toContain("last_login");
    expect(out).not.toContain("\n");
  });
  it("名前・フォルダ・タグで一致しているなら null", () => {
    expect(snippetBodyExcerpt(snip({ sql: "select active" }), "active")).toBeNull();
    expect(snippetBodyExcerpt(snip({ sql: "select reports" }), "reports")).toBeNull();
    expect(snippetBodyExcerpt(snip({ sql: "select daily" }), "daily")).toBeNull();
  });
  it("本文にも無い・空の検索語なら null", () => {
    expect(snippetBodyExcerpt(snip(), "zzz")).toBeNull();
    expect(snippetBodyExcerpt(snip(), "  ")).toBeNull();
  });
  it("前後が切れるときは省略記号を付け、半径で切り詰める", () => {
    const long = `${"a".repeat(100)} NEEDLE ${"b".repeat(100)}`;
    const out = snippetBodyExcerpt(snip({ sql: long }), "needle", 10) ?? "";
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThan(40);
    expect(out).toContain("NEEDLE");
  });
  it("改行をまたぐ一致も空白 1 つに畳んで拾う", () => {
    expect(snippetBodyExcerpt(snip(), "id, email")).toContain("id, email");
  });
});

describe("snippetCopyDraft", () => {
  it("id を空にして名前に接尾辞を付け、元は変更しない", () => {
    const src = snip();
    const draft = snippetCopyDraft(src, " (copy)");
    expect(draft.id).toBe(SNIPPET_COPY_ID);
    expect(draft.name).toBe("Active users (copy)");
    expect(draft.sql).toBe(src.sql);
    expect(draft.tags).not.toBe(src.tags);
    expect(src.id).toBe("abc12345");
  });
});
