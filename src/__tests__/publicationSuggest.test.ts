import { describe, expect, it, vi } from "vitest";
import type { PublicationInfo } from "../api/tauri";
import {
  hasAddablePublication,
  hasReplicaIdentityRisk,
  shouldSuggestPublication,
} from "../components/publicationSuggest";

const pub = (over: Partial<PublicationInfo> = {}): PublicationInfo =>
  ({
    name: "pub1",
    all_tables: false,
    tables: [],
    schemas: [],
    ...over,
  }) as PublicationInfo;

const noPk = { replica_identity: "d", has_primary_key: false };
const withPk = { replica_identity: "d", has_primary_key: true };

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
    expect(await shouldSuggestPublication(base, async () => [pub()])).toEqual({ replicaIdentityRisk: false });
  });
  it("MySQL / SQLite では取得もしない", async () => {
    const list = vi.fn(async () => [pub()]);
    expect(await shouldSuggestPublication({ ...base, driver: "mysql" }, list)).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });
  it("read_only では出さない", async () => {
    const list = vi.fn(async () => [pub()]);
    expect(await shouldSuggestPublication({ ...base, readOnly: true }, list)).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });
  it("UNLOGGED 表・スキーマ不明は出さない", async () => {
    expect(await shouldSuggestPublication({ ...base, unlogged: true }, async () => [pub()])).toBeNull();
    expect(await shouldSuggestPublication({ ...base, schema: "" }, async () => [pub()])).toBeNull();
  });
  it("パブリケーション無し / 取得失敗は null (例外にしない)", async () => {
    expect(await shouldSuggestPublication(base, async () => [])).toBeNull();
    expect(await shouldSuggestPublication(base, async () => Promise.reject(new Error("boom")))).toBeNull();
  });
});

describe("hasReplicaIdentityRisk (#2212)", () => {
  const upd = pub({ publish: ["insert", "update", "delete"] });
  it("追加できる update / delete 公開のパブリケーションがあり、主キーの無い表なら true", () => {
    expect(hasReplicaIdentityRisk([upd], "public", "orders", noPk)).toBe(true);
  });
  it("主キーがある・identity が不明なら false", () => {
    expect(hasReplicaIdentityRisk([upd], "public", "orders", withPk)).toBe(false);
    expect(hasReplicaIdentityRisk([upd], "public", "orders", null)).toBe(false);
  });
  it("insert だけを公開するパブリケーションなら false", () => {
    expect(hasReplicaIdentityRisk([pub({ publish: ["insert"] })], "public", "orders", noPk)).toBe(false);
  });
  it("追加できないパブリケーション (FOR ALL TABLES) だけなら false", () => {
    expect(hasReplicaIdentityRisk([{ ...upd, all_tables: true }], "public", "orders", noPk)).toBe(false);
  });
});

describe("shouldSuggestPublication の REPLICA IDENTITY 警告 (#2212)", () => {
  const upd = pub({ publish: ["insert", "update", "delete"] });
  it("主キーの無い表は提案を控えず、警告つきで返す", async () => {
    expect(
      await shouldSuggestPublication(
        base,
        async () => [upd],
        async () => noPk,
      ),
    ).toEqual({
      replicaIdentityRisk: true,
    });
  });
  it("主キーがある表は警告なし", async () => {
    expect(
      await shouldSuggestPublication(
        base,
        async () => [upd],
        async () => withPk,
      ),
    ).toEqual({
      replicaIdentityRisk: false,
    });
  });
  it("identity の取得に失敗しても提案は出し、警告はしない", async () => {
    expect(
      await shouldSuggestPublication(
        base,
        async () => [upd],
        async () => Promise.reject(new Error("x")),
      ),
    ).toEqual({ replicaIdentityRisk: false });
  });
  it("追加先が無ければ identity は取りに行かない", async () => {
    const getIdentity = vi.fn(async () => noPk);
    expect(await shouldSuggestPublication(base, async () => [], getIdentity)).toBeNull();
    expect(getIdentity).not.toHaveBeenCalled();
  });
});
