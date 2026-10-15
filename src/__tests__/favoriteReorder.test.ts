import { describe, expect, it } from "vitest";
import { moveSnippetFavorite, reorderSnippetFavorites } from "../snippetQuickAccess";
import { moveFavorite, reorderFavorites } from "../tableQuickAccess";

const snipState = { favorites: ["a", "b", "c"], recent: ["z"] };
const ref = (table: string) => ({ database: "db", table });
const tblState = { favorites: [ref("a"), ref("b"), ref("c")], recent: [ref("z")] };

describe("reorderSnippetFavorites", () => {
  it("真の順列なら並びを差し替え、recent は保つ", () => {
    const out = reorderSnippetFavorites(snipState, ["c", "a", "b"]);
    expect(out.favorites).toEqual(["c", "a", "b"]);
    expect(out.recent).toEqual(["z"]);
  });
  it("欠落・重複・混入のある並びは無視する", () => {
    expect(reorderSnippetFavorites(snipState, ["a", "a", "b"])).toBe(snipState);
    expect(reorderSnippetFavorites(snipState, ["a", "b"])).toBe(snipState);
    expect(reorderSnippetFavorites(snipState, ["a", "b", "x"])).toBe(snipState);
  });
  it("同じ並びなら同じ参照を返す", () => {
    expect(reorderSnippetFavorites(snipState, ["a", "b", "c"])).toBe(snipState);
  });
});

describe("moveSnippetFavorite", () => {
  it("delta だけずらし、端と未登録 id では動かない", () => {
    expect(moveSnippetFavorite(snipState, "a", 1).favorites).toEqual(["b", "a", "c"]);
    expect(moveSnippetFavorite(snipState, "c", -2).favorites).toEqual(["c", "a", "b"]);
    expect(moveSnippetFavorite(snipState, "a", -1)).toBe(snipState);
    expect(moveSnippetFavorite(snipState, "x", 1)).toBe(snipState);
  });
});

describe("reorderFavorites / moveFavorite (テーブル)", () => {
  it("並びを差し替える", () => {
    const out = reorderFavorites(tblState, [ref("b"), ref("c"), ref("a")]);
    expect(out.favorites.map((r) => r.table)).toEqual(["b", "c", "a"]);
    expect(out.recent).toEqual(tblState.recent);
  });
  it("別テーブルの混入は無視する", () => {
    expect(reorderFavorites(tblState, [ref("a"), ref("b"), ref("x")])).toBe(tblState);
  });
  it("moveFavorite は 1 つずらす", () => {
    expect(moveFavorite(tblState, ref("b"), -1).favorites.map((r) => r.table)).toEqual(["b", "a", "c"]);
    expect(moveFavorite(tblState, ref("c"), 1)).toBe(tblState);
  });
});
