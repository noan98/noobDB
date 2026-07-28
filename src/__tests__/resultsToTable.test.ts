import { describe, expect, it } from "vitest";
import {
  buildCreateTableAsSql,
  isCtasEligibleSql,
  tableNameCollides,
} from "../components/resultsToTable";

describe("isCtasEligibleSql", () => {
  it("accepts a plain SELECT", () => {
    expect(isCtasEligibleSql("SELECT * FROM users")).toBe(true);
    expect(isCtasEligibleSql("  select id, name from users where id > 1  ")).toBe(true);
  });

  it("accepts a WITH ... SELECT (CTE)", () => {
    expect(
      isCtasEligibleSql("WITH recent AS (SELECT * FROM orders) SELECT * FROM recent"),
    ).toBe(true);
  });

  it("tolerates a single trailing semicolon and surrounding whitespace", () => {
    expect(isCtasEligibleSql("SELECT 1;")).toBe(true);
    expect(isCtasEligibleSql("SELECT 1;\n")).toBe(true);
  });

  it("rejects non-SELECT statements", () => {
    expect(isCtasEligibleSql("SHOW TABLES")).toBe(false);
    expect(isCtasEligibleSql("DESCRIBE users")).toBe(false);
    expect(isCtasEligibleSql("EXPLAIN SELECT 1")).toBe(false);
    expect(isCtasEligibleSql("INSERT INTO t VALUES (1)")).toBe(false);
    expect(isCtasEligibleSql("UPDATE t SET a = 1")).toBe(false);
    expect(isCtasEligibleSql("CREATE TABLE t (id INT)")).toBe(false);
  });

  it("rejects stacked statements (a hidden 2nd statement)", () => {
    expect(isCtasEligibleSql("SELECT 1; DROP TABLE users")).toBe(false);
    expect(isCtasEligibleSql("SELECT 1;;")).toBe(false);
  });

  it("rejects empty input", () => {
    expect(isCtasEligibleSql("")).toBe(false);
    expect(isCtasEligibleSql("   ")).toBe(false);
    expect(isCtasEligibleSql(";")).toBe(false);
  });

  it("ignores a semicolon hidden inside a string literal or comment", () => {
    expect(isCtasEligibleSql("SELECT 'a;b' AS s FROM t")).toBe(true);
    expect(isCtasEligibleSql("SELECT 1 -- drop table t; \nFROM t")).toBe(true);
  });

  it("does not mistake a leading keyword typo or lowercase 'select' inside a string for eligibility", () => {
    expect(isCtasEligibleSql("SELEC * FROM t")).toBe(false);
    expect(isCtasEligibleSql("'select 1'")).toBe(false);
  });
});

describe("buildCreateTableAsSql", () => {
  it("qualifies the new table name with the database on MySQL/Postgres", () => {
    expect(buildCreateTableAsSql("mysql", "shop", "top_users", "SELECT * FROM users")).toBe(
      "CREATE TABLE `shop`.`top_users` AS\nSELECT * FROM users;",
    );
    expect(buildCreateTableAsSql("postgres", "public", "top_users", "SELECT * FROM users")).toBe(
      'CREATE TABLE "public"."top_users" AS\nSELECT * FROM users;',
    );
  });

  it("never qualifies on SQLite (no schema concept)", () => {
    expect(buildCreateTableAsSql("sqlite", "main", "top_users", "SELECT * FROM users")).toBe(
      'CREATE TABLE "top_users" AS\nSELECT * FROM users;',
    );
  });

  it("omits the qualifier when database is null", () => {
    expect(buildCreateTableAsSql("mysql", null, "t", "SELECT 1")).toBe(
      "CREATE TABLE `t` AS\nSELECT 1;",
    );
  });

  it("strips a trailing semicolon from the source query instead of doubling it", () => {
    expect(buildCreateTableAsSql("mysql", null, "t", "SELECT 1;\n")).toBe(
      "CREATE TABLE `t` AS\nSELECT 1;",
    );
  });

  it("escapes embedded quotes in the new table name", () => {
    expect(buildCreateTableAsSql("postgres", null, 'we"ird', "SELECT 1")).toBe(
      'CREATE TABLE "we""ird" AS\nSELECT 1;',
    );
  });
});

describe("tableNameCollides", () => {
  it("matches case-insensitively", () => {
    expect(tableNameCollides(["Users", "orders"], "users")).toBe(true);
    expect(tableNameCollides(["Users", "orders"], "USERS")).toBe(true);
    expect(tableNameCollides(["Users", "orders"], "products")).toBe(false);
  });

  it("trims surrounding whitespace before comparing", () => {
    expect(tableNameCollides(["users"], "  users  ")).toBe(true);
  });

  it("treats an empty/whitespace-only name as not colliding", () => {
    expect(tableNameCollides(["users"], "")).toBe(false);
    expect(tableNameCollides(["users"], "   ")).toBe(false);
  });
});
