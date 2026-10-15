import { beforeEach, describe, expect, it } from "vitest";
import {
  AI_CACHE_MAX_ENTRIES,
  AI_CACHE_MAX_ENTRY_CHARS,
  AI_CACHE_MAX_TOTAL_CHARS,
  aiCacheKey,
  fingerprint,
  loadAiCache,
  removeAiCache,
  saveAiCache,
} from "../ai/aiCache";

const isObj = (v: unknown): v is { n: number } =>
  !!v && typeof v === "object" && typeof (v as { n?: unknown }).n === "number";

beforeEach(() => {
  localStorage.clear();
});

describe("AI キャッシュ (#1620)", () => {
  it("指紋は同じ入力で同じ、1 文字違えば変わる", () => {
    expect(fingerprint("users(id,name)")).toBe(fingerprint("users(id,name)"));
    expect(fingerprint("users(id,name)")).not.toBe(fingerprint("users(id,nam)"));
    expect(fingerprint("")).toMatch(/^[0-9a-z]+$/);
  });

  it("キーはプロファイル・対象ごとに分かれ、区切り文字を含む名前でも衝突しない", () => {
    expect(aiCacheKey("testDataPlan", "p1", "db", "t")).not.toBe(aiCacheKey("testDataPlan", "p2", "db", "t"));
    expect(aiCacheKey("testDataPlan", "p1", "a:b", "c")).not.toBe(
      aiCacheKey("testDataPlan", "p1", "a", "b:c"),
    );
  });

  it("保存した値を読み戻し、検証を通らない値・壊れた値は null", () => {
    const k = aiCacheKey("schemaDoc", "p", "db");
    expect(saveAiCache(k, { n: 1 })).toBe(true);
    expect(loadAiCache(k, isObj)).toEqual({ n: 1 });
    localStorage.setItem(k, '{"n":"x"}');
    expect(loadAiCache(k, isObj)).toBeNull();
    localStorage.setItem(k, "{ not json");
    expect(loadAiCache(k, isObj)).toBeNull();
    expect(loadAiCache(aiCacheKey("schemaDoc", "p", "none"), isObj)).toBeNull();
  });

  it("大きすぎる値は保存しない", () => {
    expect(
      saveAiCache(aiCacheKey("schemaDoc", "p", "big"), { n: 1, pad: "x".repeat(AI_CACHE_MAX_ENTRY_CHARS) }),
    ).toBe(false);
  });

  it("合計サイズが上限を超えないよう、保存前に古いエントリから捨てる", () => {
    const chunk = AI_CACHE_MAX_ENTRY_CHARS - 100;
    const keys = [0, 1, 2].map((i) => aiCacheKey("schemaDoc", "p", `big${i}`));
    for (const k of keys) expect(saveAiCache(k, { n: 1, pad: "x".repeat(chunk) })).toBe(true);
    let total = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith("noobdb.aiCache.v1:") && !key.endsWith("index")) {
        total += localStorage.getItem(key)?.length ?? 0;
      }
    }
    expect(total).toBeLessThanOrEqual(AI_CACHE_MAX_TOTAL_CHARS);
    expect(loadAiCache(keys[0], isObj)).toBeNull();
    expect(loadAiCache(keys[2], isObj)).not.toBeNull();
  });

  it("エントリ数の上限を超えたら、最後に使ったのが古いものから捨てる", () => {
    const keys = Array.from({ length: AI_CACHE_MAX_ENTRIES + 1 }, (_, i) =>
      aiCacheKey("testDataPlan", "p", `t${i}`),
    );
    for (const k of keys) saveAiCache(k, { n: 1 });
    expect(loadAiCache(keys[0], isObj)).toBeNull();
    expect(loadAiCache(keys[keys.length - 1], isObj)).not.toBeNull();
  });

  it("removeAiCache で消える。localStorage が使えなくても例外にしない", () => {
    const k = aiCacheKey("schemaDoc", "p", "x");
    saveAiCache(k, { n: 1 });
    removeAiCache(k);
    expect(loadAiCache(k, isObj)).toBeNull();
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("blocked");
    };
    try {
      expect(loadAiCache(k, isObj)).toBeNull();
    } finally {
      Storage.prototype.getItem = original;
    }
  });
});
