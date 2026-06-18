import { describe, expect, it } from "vitest";
import type { ForeignKey } from "../api/tauri";
import {
  buildFkJumpSql,
  buildReverseRefSql,
  incomingForeignKeys,
} from "../fkNavigation";

describe("buildFkJumpSql", () => {
  it("qualifies the referenced table with the database for MySQL", () => {
    expect(
      buildFkJumpSql({
        driver: "mysql",
        database: "shop",
        refTable: "users",
        refColumn: "id",
        value: 42,
      }),
    ).toBe("SELECT * FROM `shop`.`users` WHERE `id` = 42");
  });

  it("uses double quotes and database qualification for PostgreSQL", () => {
    expect(
      buildFkJumpSql({
        driver: "postgres",
        database: "shop",
        refTable: "users",
        refColumn: "id",
        value: 7,
      }),
    ).toBe('SELECT * FROM "shop"."users" WHERE "id" = 7');
  });

  it("omits the database qualifier for SQLite", () => {
    expect(
      buildFkJumpSql({
        driver: "sqlite",
        database: "main",
        refTable: "users",
        refColumn: "id",
        value: 1,
      }),
    ).toBe('SELECT * FROM "users" WHERE "id" = 1');
  });

  it("omits the database qualifier when database is empty", () => {
    expect(
      buildFkJumpSql({
        driver: "mysql",
        database: "",
        refTable: "users",
        refColumn: "id",
        value: 1,
      }),
    ).toBe("SELECT * FROM `users` WHERE `id` = 1");
  });

  it("escapes string literals per dialect (MySQL doubles backslashes)", () => {
    expect(
      buildFkJumpSql({
        driver: "mysql",
        database: null,
        refTable: "t",
        refColumn: "name",
        value: "a'b\\c",
      }),
    ).toBe("SELECT * FROM `t` WHERE `name` = 'a''b\\\\c'");
  });

  it("does not double backslashes for PostgreSQL", () => {
    expect(
      buildFkJumpSql({
        driver: "postgres",
        database: null,
        refTable: "t",
        refColumn: "name",
        value: "a\\c",
      }),
    ).toBe('SELECT * FROM "t" WHERE "name" = \'a\\c\'');
  });

  it("emits IS NULL for null values", () => {
    expect(
      buildFkJumpSql({
        driver: "mysql",
        database: null,
        refTable: "t",
        refColumn: "parent_id",
        value: null,
      }),
    ).toBe("SELECT * FROM `t` WHERE `parent_id` IS NULL");
  });

  it("quotes identifiers containing the quote character", () => {
    expect(
      buildFkJumpSql({
        driver: "mysql",
        database: null,
        refTable: "we`ird",
        refColumn: "id",
        value: 1,
      }),
    ).toBe("SELECT * FROM `we``ird` WHERE `id` = 1");
  });
});

describe("incomingForeignKeys", () => {
  const fks: ForeignKey[] = [
    {
      table: "orders",
      column: "user_id",
      referenced_table: "users",
      referenced_column: "id",
      constraint_name: "fk_orders_user",
    },
    {
      table: "comments",
      column: "author_id",
      referenced_table: "users",
      referenced_column: "id",
      constraint_name: null,
    },
    {
      table: "orders",
      column: "product_id",
      referenced_table: "products",
      referenced_column: "id",
      constraint_name: null,
    },
    {
      table: "broken",
      column: "x",
      referenced_table: "users",
      referenced_column: null,
      constraint_name: null,
    },
  ];

  it("returns only FKs pointing at the given table", () => {
    expect(incomingForeignKeys(fks, "users")).toEqual([
      { table: "orders", column: "user_id", referencedColumn: "id" },
      { table: "comments", column: "author_id", referencedColumn: "id" },
    ]);
  });

  it("drops entries with an unknown referenced column", () => {
    // `broken` references users but with a null referenced_column → excluded.
    const result = incomingForeignKeys(fks, "users");
    expect(result.some((r) => r.table === "broken")).toBe(false);
  });

  it("returns an empty list when nothing references the table", () => {
    expect(incomingForeignKeys(fks, "nowhere")).toEqual([]);
  });
});

describe("buildReverseRefSql", () => {
  it("filters the child table by the referencing column and value", () => {
    expect(
      buildReverseRefSql({
        driver: "mysql",
        database: "shop",
        childTable: "orders",
        childColumn: "user_id",
        value: 42,
      }),
    ).toBe("SELECT * FROM `shop`.`orders` WHERE `user_id` = 42");
  });

  it("emits IS NULL when the referenced key value is null", () => {
    expect(
      buildReverseRefSql({
        driver: "postgres",
        database: null,
        childTable: "orders",
        childColumn: "user_id",
        value: null,
      }),
    ).toBe('SELECT * FROM "orders" WHERE "user_id" IS NULL');
  });
});
