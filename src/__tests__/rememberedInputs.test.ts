// @vitest-environment jsdom (localStorage に触れるため)
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_REMEMBERED_ENTRIES,
  asRecord,
  forgetRemembered,
  loadRemembered,
  pickBool,
  pickNumber,
  pickOneOf,
  pickString,
  rememberScope,
  saveRemembered,
} from "../rememberedInputs";

const asObj = (raw: unknown) => asRecord(raw);

beforeEach(() => {
  localStorage.clear();
});

describe("rememberedInputs", () => {
  it("スコープごとに保存して読み戻せる", () => {
    saveRemembered("dump", "p1", { gzip: true });
    saveRemembered("dump", "p2", { gzip: false });
    expect(loadRemembered("dump", "p1", asObj)).toEqual({ gzip: true });
    expect(loadRemembered("dump", "p2", asObj)).toEqual({ gzip: false });
    expect(loadRemembered("dump", "none", asObj)).toBeNull();
    expect(loadRemembered("other", "p1", asObj)).toBeNull();
  });

  it("rememberScope は部分が違えば別スコープ、null は空として扱う", () => {
    expect(rememberScope("a", "b")).not.toBe(rememberScope("ab", ""));
    expect(rememberScope("a", null)).toBe(rememberScope("a", ""));
  });

  it("上限を超えたら最後に使った順で古いスコープを捨てる", () => {
    for (let i = 0; i < MAX_REMEMBERED_ENTRIES + 5; i++) saveRemembered("f", `s${i}`, { i });
    expect(loadRemembered("f", "s0", asObj)).toBeNull();
    expect(loadRemembered("f", `s${MAX_REMEMBERED_ENTRIES + 4}`, asObj)).toEqual({
      i: MAX_REMEMBERED_ENTRIES + 4,
    });
  });

  it("保存し直したスコープは LRU の先頭に戻り、捨てられにくくなる", () => {
    for (let i = 0; i < MAX_REMEMBERED_ENTRIES; i++) saveRemembered("f", `s${i}`, { i });
    saveRemembered("f", "s0", { i: 0, again: true });
    saveRemembered("f", "new", { i: -1 });
    expect(loadRemembered("f", "s0", asObj)).toEqual({ i: 0, again: true });
    expect(loadRemembered("f", "s1", asObj)).toBeNull();
  });

  it("forgetRemembered は 1 スコープだけ消す", () => {
    saveRemembered("f", "a", { x: 1 });
    saveRemembered("f", "b", { x: 2 });
    forgetRemembered("f", "a");
    expect(loadRemembered("f", "a", asObj)).toBeNull();
    expect(loadRemembered("f", "b", asObj)).toEqual({ x: 2 });
  });

  it("壊れた JSON・形違いは記憶なしとして扱う", () => {
    localStorage.setItem("noobdb.remember.v1.f", "{not json");
    expect(loadRemembered("f", "a", asObj)).toBeNull();
    localStorage.setItem("noobdb.remember.v1.f", JSON.stringify({ order: "x", entries: [1] }));
    expect(loadRemembered("f", "a", asObj)).toBeNull();
    // 壊れたあとでも保存できる。
    saveRemembered("f", "a", { ok: true });
    expect(loadRemembered("f", "a", asObj)).toEqual({ ok: true });
  });

  it("sanitize が null を返す / 例外を投げる値は記憶なし", () => {
    saveRemembered("f", "a", "string");
    expect(loadRemembered("f", "a", asObj)).toBeNull();
    expect(
      loadRemembered("f", "a", () => {
        throw new Error("x");
      }),
    ).toBeNull();
  });

  it("localStorage が使えなくても例外を出さない", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => saveRemembered("f", "a", { x: 1 })).not.toThrow();
    spy.mockRestore();
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(loadRemembered("f", "a", asObj)).toBeNull();
    get.mockRestore();
  });
});

describe("pick helpers", () => {
  it("型が合うときだけ採用し、違えば既定", () => {
    expect(pickString("x", "d")).toBe("x");
    expect(pickString(1, "d")).toBe("d");
    expect(pickBool(true, false)).toBe(true);
    expect(pickBool("true", false)).toBe(false);
    expect(pickOneOf("b", ["a", "b"] as const, "a")).toBe("b");
    expect(pickOneOf("z", ["a", "b"] as const, "a")).toBe("a");
    expect(pickNumber(3, 1)).toBe(3);
    expect(pickNumber(Number.NaN, 1)).toBe(1);
    expect(asRecord([])).toBeNull();
    expect(asRecord(null)).toBeNull();
  });
});
