import { describe, expect, it, vi } from "vitest";
import type { PublicationInfo } from "../api/tauri";
import { hasAddablePublication, shouldSuggestPublication } from "../components/publicationSuggest";

const pub = (over: Partial<PublicationInfo> = {}): PublicationInfo =>
  ({
    name: "pub1",
    all_tables: false,
    tables: [],
    schemas: [],
    ...over,
  }) as PublicationInfo;

const base = { driver: "postgres", readOnly: false, schema: "public", table: "orders" };

describe("hasAddablePublication", () => {
  it("明示メンバー型 (FOR TABLE) は対象", () => {
    expect(
      hasAddablePublication(
        [pub({ tables: [{ schema: "public", table: "x" }] as never })],
        "public",
        "orders",
      ),
    ).toBe(true);
  });
  it("FOR ALL TABLES / そのスキーマの TABLES IN SCHEMA だけなら対象外", () => {
    expect(hasAddablePublication([pub({ all_tables: true })], "public", "orders")).toBe(false);
    expect(hasAddablePublication([pub({ schemas: ["public"] })], "public", "orders")).toBe(false);
  });
  it("別スキーマの TABLES IN SCHEMA は対象", () => {
    expect(hasAddablePublication([pub({ schemas: ["other"] })], "public", "orders")).toBe(true);
  });
  it("パブリケーション無しは対象外", () => {
    expect(hasAddablePublication([], "public", "orders")).toBe(false);
  });
});

describe("shouldSuggestPublication", () => {
  it("条件を満たすと true", async () => {
    expect(await shouldSuggestPublication(base, async () => [pub()])).toBe(true);
  });
  it("MySQL / SQLite では取得もしない", async () => {
    const list = vi.fn(async () => [pub()]);
    expect(await shouldSuggestPublication({ ...base, driver: "mysql" }, list)).toBe(false);
    expect(list).not.toHaveBeenCalled();
  });
  it("read_only では出さない", async () => {
    const list = vi.fn(async () => [pub()]);
    expect(await shouldSuggestPublication({ ...base, readOnly: true }, list)).toBe(false);
    expect(list).not.toHaveBeenCalled();
  });
  it("パブリケーション無し / 取得失敗は false (例外にしない)", async () => {
    expect(await shouldSuggestPublication(base, async () => [])).toBe(false);
    expect(await shouldSuggestPublication(base, async () => Promise.reject(new Error("boom")))).toBe(false);
  });
});
