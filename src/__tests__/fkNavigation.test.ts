import { describe, expect, it } from "vitest";
import { buildFkJumpSql, buildReverseRefSql } from "../fkNavigation";

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

describe("列型付きのリテラル化", () => {
  it("BLOB 列のキーは 16 進リテラルになる (順方向 / 逆方向)", () => {
    expect(
      buildFkJumpSql({ driver: "mysql", refTable: "t", refColumn: "id", value: "ab12", valueType: "BLOB" }),
    ).toBe("SELECT * FROM `t` WHERE `id` = 0xab12");
    expect(
      buildReverseRefSql({
        driver: "sqlite",
        childTable: "c",
        childColumn: "pid",
        value: "ab12",
        valueType: "BLOB",
      }),
    ).toBe('SELECT * FROM "c" WHERE "pid" = X\'ab12\'');
  });

  it("文字列で届いた BIGINT / BIGINT UNSIGNED は裸の数値になり、型なしなら従来どおり引用符付き", () => {
    const p = { driver: "mysql", refTable: "t", refColumn: "id", value: "9007199254740993" };
    for (const valueType of ["BIGINT", "BIGINT UNSIGNED"]) {
      expect(buildFkJumpSql({ ...p, valueType })).toBe("SELECT * FROM `t` WHERE `id` = 9007199254740993");
    }
    expect(buildFkJumpSql(p)).toBe("SELECT * FROM `t` WHERE `id` = '9007199254740993'");
  });

  it("DECIMAL の文字列は裸の数値、日時 / UUID は引用符付き、bool は TRUE/FALSE", () => {
    const base = { driver: "mysql", refTable: "t", refColumn: "k" };
    expect(buildFkJumpSql({ ...base, value: "1.50", valueType: "DECIMAL" })).toBe(
      "SELECT * FROM `t` WHERE `k` = 1.50",
    );
    expect(buildFkJumpSql({ ...base, value: "2024-01-02 03:04:05", valueType: "DATETIME" })).toBe(
      "SELECT * FROM `t` WHERE `k` = '2024-01-02 03:04:05'",
    );
    expect(
      buildFkJumpSql({ ...base, value: "123e4567-e89b-12d3-a456-426614174000", valueType: "CHAR" }),
    ).toBe("SELECT * FROM `t` WHERE `k` = '123e4567-e89b-12d3-a456-426614174000'");
    expect(buildFkJumpSql({ ...base, value: true, valueType: "BOOLEAN" })).toBe(
      "SELECT * FROM `t` WHERE `k` = TRUE",
    );
  });

  it("BLOB 宣言でも値が 16 進でなければ (SQLite 非 STRICT の TEXT / INTEGER) 通常のリテラルに戻る", () => {
    const base = { driver: "sqlite", refTable: "t", refColumn: "k", valueType: "BLOB" };
    expect(buildFkJumpSql({ ...base, value: "a'b" })).toBe("SELECT * FROM \"t\" WHERE \"k\" = 'a''b'");
    expect(buildFkJumpSql({ ...base, value: 5 })).toBe('SELECT * FROM "t" WHERE "k" = 5');
    expect(buildFkJumpSql({ ...base, value: "a' OR 1=1 --" })).toBe(
      "SELECT * FROM \"t\" WHERE \"k\" = 'a'' OR 1=1 --'",
    );
  });
});
