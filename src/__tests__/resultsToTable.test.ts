import { describe, expect, it } from "vitest";
import {
  type AppendTargetColumn,
  autoMapAppendColumns,
  buildCreateTableAsSql,
  buildInsertSelectSql,
  findAppendIssues,
  hasBlockingAppendIssue,
  isCtasEligibleSql,
  tableNameCollides,
} from "../components/resultsToTable";

describe("isCtasEligibleSql", () => {
  it("accepts a plain SELECT", () => {
    expect(isCtasEligibleSql("SELECT * FROM users")).toBe(true);
    expect(isCtasEligibleSql("  select id, name from users where id > 1  ")).toBe(true);
  });

  it("accepts a WITH ... SELECT (CTE)", () => {
    expect(isCtasEligibleSql("WITH recent AS (SELECT * FROM orders) SELECT * FROM recent")).toBe(true);
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
    expect(buildCreateTableAsSql("mysql", null, "t", "SELECT 1")).toBe("CREATE TABLE `t` AS\nSELECT 1;");
  });

  it("strips a trailing semicolon from the source query instead of doubling it", () => {
    expect(buildCreateTableAsSql("mysql", null, "t", "SELECT 1;\n")).toBe("CREATE TABLE `t` AS\nSELECT 1;");
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

describe("append helpers (#1623)", () => {
  const tcol = (name: string, over: Partial<AppendTargetColumn> = {}): AppendTargetColumn => ({
    name,
    nullable: true,
    default: null,
    extra: "",
    ...over,
  });

  it("autoMapAppendColumns matches names case-insensitively, falls back to position only when nothing matches", () => {
    const target = [tcol("ID"), tcol("Total")];
    expect(autoMapAppendColumns(["id", "x"], target)).toEqual(["ID", null]);
    expect(autoMapAppendColumns(["a", "b"], target)).toEqual(["ID", "Total"]);
    expect(autoMapAppendColumns(["a", "b", "c"], target)).toEqual([null, null, null]);
  });

  it("findAppendIssues reports blocking and warning problems", () => {
    const target = [
      tcol("id", { nullable: false }),
      tcol("n", { nullable: false, extra: "auto_increment" }),
      tcol("v"),
    ];
    expect(findAppendIssues(["a"], [null], target)).toContainEqual({ kind: "noneMapped" });
    expect(findAppendIssues(["a", "b"], ["v", "v"], target)).toContainEqual({
      kind: "duplicateTarget",
      column: "v",
    });
    expect(findAppendIssues(["a", "A"], ["id", "v"], target)).toContainEqual({
      kind: "duplicateSource",
      column: "a",
    });
    // 採番列は未対応でも警告にならない。必須列 id が未対応なら警告。
    const issues = findAppendIssues(["a"], ["v"], target);
    expect(issues).toEqual([{ kind: "missingRequired", column: "id" }]);
    expect(hasBlockingAppendIssue(issues)).toBe(false);
    expect(hasBlockingAppendIssue([{ kind: "noneMapped" }])).toBe(true);
  });

  it("buildInsertSelectSql quotes per dialect, skips unmapped columns and strips the trailing semicolon", () => {
    expect(
      buildInsertSelectSql("postgres", "public", "t", ["a", "b"], ["x", null], "SELECT 1 AS a, 2 AS b;"),
    ).toBe('INSERT INTO "public"."t" ("x")\nSELECT "a"\nFROM (\nSELECT 1 AS a, 2 AS b\n) AS _src;');
    expect(buildInsertSelectSql("sqlite", null, "t", ["a"], ["a"], "SELECT 1 AS a")).toContain(
      'INSERT INTO "t" ("a")',
    );
    expect(buildInsertSelectSql("mysql", "d", "t", ["a"], [null], "SELECT 1")).toBe("");
  });
});
