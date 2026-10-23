import { describe, expect, it } from "vitest";
import { collectDropImpacts } from "../dropImpact";

const fk = (table: string, column: string, referencedColumn = "id") => ({ table, column, referencedColumn });

describe("collectDropImpacts", () => {
  it("参照が無ければ空", () => {
    expect(collectDropImpacts({ users: [] }, ["users"])).toEqual([]);
    expect(collectDropImpacts({}, ["users"])).toEqual([]);
  });

  it("DROP されずに残る子テーブルの参照だけを返す", () => {
    const got = collectDropImpacts({ users: [fk("orders", "user_id"), fk("logs", "uid")] }, ["users"]);
    expect(got).toEqual([{ table: "users", refs: [fk("orders", "user_id"), fk("logs", "uid")] }]);
  });

  it("同じ DROP 対象に含まれる子 (自己参照を含む) は除く", () => {
    const got = collectDropImpacts(
      {
        users: [fk("orders", "user_id"), fk("users", "parent_id")],
        orders: [fk("items", "order_id")],
      },
      ["users", "orders"],
    );
    // orders も items も… orders は対象内なので users→orders は除外、users の自己参照も除外。
    expect(got).toEqual([{ table: "orders", refs: [fk("items", "order_id")] }]);
  });

  it("別スキーマの同名テーブルは DROP 対象と同名でも残る子として扱う (#1786)", () => {
    const cross = { schema: "sales", ...fk("users", "uid") };
    expect(collectDropImpacts({ users: [cross] }, ["users"])).toEqual([{ table: "users", refs: [cross] }]);
  });

  it("全ての子が対象内なら空", () => {
    expect(collectDropImpacts({ a: [fk("b", "a_id")], b: [fk("a", "b_id")] }, ["a", "b"])).toEqual([]);
  });
});
