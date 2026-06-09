import { describe, expect, it } from "vitest";
import { buildObjectIndex, searchObjects } from "../objectSearch";

const schemas = {
  shop: [
    { name: "users", columns: ["id", "user_name", "email"] },
    { name: "orders", columns: ["id", "user_id", "total"] },
  ],
  analytics: [{ name: "events", columns: ["id", "user_id", "ts"] }],
};

describe("buildObjectIndex", () => {
  it("flattens tables and columns into entries", () => {
    const idx = buildObjectIndex(schemas);
    // 3 tables + (3 + 3 + 3) columns = 12 entries.
    expect(idx).toHaveLength(12);
    expect(idx.filter((e) => e.kind === "table")).toHaveLength(3);
    expect(idx).toContainEqual({ kind: "table", database: "shop", table: "users" });
    expect(idx).toContainEqual({
      kind: "column",
      database: "shop",
      table: "orders",
      column: "user_id",
    });
  });
});

describe("searchObjects", () => {
  const idx = buildObjectIndex(schemas);

  it("returns empty for a blank query", () => {
    expect(searchObjects(idx, "  ")).toEqual([]);
  });

  it("matches table names and ranks an exact table hit first", () => {
    const res = searchObjects(idx, "users");
    expect(res[0]).toEqual({ kind: "table", database: "shop", table: "users" });
  });

  it("finds columns across databases", () => {
    const res = searchObjects(idx, "user_id");
    const tables = res.map((e) => `${e.database}.${e.table}`);
    expect(tables).toContain("shop.orders");
    expect(tables).toContain("analytics.events");
  });

  it("is case-insensitive and matches substrings", () => {
    const res = searchObjects(idx, "USER");
    expect(res.length).toBeGreaterThan(0);
    // The table "users" (prefix match + table bonus) should outrank a mere
    // substring column match.
    expect(res[0].kind).toBe("table");
  });

  it("caps results at the given limit", () => {
    const res = searchObjects(idx, "id", 2);
    expect(res).toHaveLength(2);
  });
});
