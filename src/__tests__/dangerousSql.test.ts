import { describe, it, expect } from "vitest";
import { analyzeDangerousSql, isReadOnlySql } from "../dangerousSql";

describe("analyzeDangerousSql", () => {
  it("flags DELETE without a top-level WHERE", () => {
    expect(analyzeDangerousSql("DELETE FROM users")).toEqual([
      { kind: "deleteNoWhere", target: "users" },
    ]);
  });

  it("ignores DELETE guarded by a top-level WHERE", () => {
    expect(analyzeDangerousSql("DELETE FROM users WHERE id = 1")).toEqual([]);
  });

  it("flags UPDATE without a top-level WHERE", () => {
    expect(analyzeDangerousSql("UPDATE users SET active = 0")).toEqual([
      { kind: "updateNoWhere", target: "users" },
    ]);
  });

  it("ignores UPDATE guarded by a top-level WHERE", () => {
    expect(
      analyzeDangerousSql("UPDATE users SET active = 0 WHERE id = 1"),
    ).toEqual([]);
  });

  it("does not treat a WHERE inside a sub-select as the statement's guard", () => {
    expect(
      analyzeDangerousSql(
        "UPDATE t SET c = (SELECT x FROM y WHERE y.id = 1)",
      ),
    ).toEqual([{ kind: "updateNoWhere", target: "t" }]);
  });

  it("does not treat a WHERE inside a string literal as a guard", () => {
    expect(
      analyzeDangerousSql("UPDATE t SET note = 'delete where all rows'"),
    ).toEqual([{ kind: "updateNoWhere", target: "t" }]);
  });

  it("does not treat a WHERE inside a comment as a guard", () => {
    expect(analyzeDangerousSql("DELETE FROM t -- where id = 1")).toEqual([
      { kind: "deleteNoWhere", target: "t" },
    ]);
    expect(analyzeDangerousSql("DELETE FROM t /* where id = 1 */")).toEqual([
      { kind: "deleteNoWhere", target: "t" },
    ]);
  });

  it("flags DROP and reads the object name past IF EXISTS", () => {
    expect(analyzeDangerousSql("DROP TABLE foo")).toEqual([
      { kind: "drop", target: "foo" },
    ]);
    expect(analyzeDangerousSql("DROP TABLE IF EXISTS foo")).toEqual([
      { kind: "drop", target: "foo" },
    ]);
  });

  it("flags TRUNCATE with and without the optional TABLE keyword", () => {
    expect(analyzeDangerousSql("TRUNCATE foo")).toEqual([
      { kind: "truncate", target: "foo" },
    ]);
    expect(analyzeDangerousSql("TRUNCATE TABLE foo")).toEqual([
      { kind: "truncate", target: "foo" },
    ]);
  });

  it("strips quoting from the parsed target identifier", () => {
    expect(analyzeDangerousSql("DROP TABLE `my table`")).toEqual([
      { kind: "drop", target: "my table" },
    ]);
    expect(analyzeDangerousSql('DELETE FROM "my tbl"')).toEqual([
      { kind: "deleteNoWhere", target: "my tbl" },
    ]);
  });

  it("returns a null target when it cannot be parsed", () => {
    expect(analyzeDangerousSql("DELETE")).toEqual([
      { kind: "deleteNoWhere", target: null },
    ]);
  });

  it("reports one finding per dangerous statement", () => {
    expect(
      analyzeDangerousSql("DELETE FROM a; UPDATE b SET x = 1"),
    ).toEqual([
      { kind: "deleteNoWhere", target: "a" },
      { kind: "updateNoWhere", target: "b" },
    ]);
  });

  it("ignores benign and non-destructive statements", () => {
    expect(analyzeDangerousSql("SELECT * FROM users")).toEqual([]);
    expect(analyzeDangerousSql("INSERT INTO t (x) VALUES (1)")).toEqual([]);
    expect(analyzeDangerousSql("")).toEqual([]);
  });

  it("still detects a dangerous statement preceded by a comment", () => {
    expect(
      analyzeDangerousSql("/* cleanup */ DELETE FROM sessions"),
    ).toEqual([{ kind: "deleteNoWhere", target: "sessions" }]);
  });
});

describe("isReadOnlySql", () => {
  it("accepts statements that begin with an allowed read-only keyword", () => {
    expect(isReadOnlySql("SELECT * FROM users")).toBe(true);
    expect(isReadOnlySql("  select 1")).toBe(true);
    expect(isReadOnlySql("SHOW TABLES")).toBe(true);
    expect(isReadOnlySql("DESCRIBE users")).toBe(true);
    expect(isReadOnlySql("DESC users")).toBe(true);
    expect(isReadOnlySql("EXPLAIN SELECT 1")).toBe(true);
    expect(isReadOnlySql("WITH t AS (SELECT 1) SELECT * FROM t")).toBe(true);
  });

  it("tolerates trailing semicolons, whitespace, and comments", () => {
    expect(isReadOnlySql("SELECT 1;")).toBe(true);
    expect(isReadOnlySql("SELECT 1;   ")).toBe(true);
    expect(isReadOnlySql("SELECT 1 -- trailing")).toBe(true);
  });

  it("rejects write and DDL statements", () => {
    expect(isReadOnlySql("INSERT INTO t (x) VALUES (1)")).toBe(false);
    expect(isReadOnlySql("UPDATE t SET x = 1 WHERE id = 2")).toBe(false);
    expect(isReadOnlySql("DELETE FROM t WHERE id = 1")).toBe(false);
    expect(isReadOnlySql("DROP TABLE t")).toBe(false);
    expect(isReadOnlySql("TRUNCATE t")).toBe(false);
    expect(isReadOnlySql("CREATE TABLE t (id int)")).toBe(false);
    expect(isReadOnlySql("CALL do_thing()")).toBe(false);
  });

  it("rejects a write/DDL keyword hiding inside a SELECT-prefixed body", () => {
    // Data-modifying CTE and SELECT ... INTO both begin with allowed keywords.
    expect(
      isReadOnlySql("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d"),
    ).toBe(false);
    expect(isReadOnlySql("SELECT * INTO backup FROM t")).toBe(false);
  });

  it("rejects a hidden second statement", () => {
    expect(isReadOnlySql("SELECT 1; DELETE FROM t")).toBe(false);
  });

  it("rejects row-locking SELECTs", () => {
    expect(isReadOnlySql("SELECT * FROM t FOR UPDATE")).toBe(false);
    expect(isReadOnlySql("SELECT * FROM t FOR SHARE")).toBe(false);
    expect(isReadOnlySql("SELECT * FROM t LOCK IN SHARE MODE")).toBe(false);
  });

  it("is not fooled by keywords inside strings or comments", () => {
    expect(isReadOnlySql("SELECT 'delete from t' AS note")).toBe(true);
    expect(isReadOnlySql("SELECT 1 /* drop table t */")).toBe(true);
  });

  it("treats empty or unrecognized input as not read-only", () => {
    expect(isReadOnlySql("")).toBe(false);
    expect(isReadOnlySql("   ")).toBe(false);
    expect(isReadOnlySql("(SELECT 1)")).toBe(false);
  });
});
