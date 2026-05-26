import { describe, it, expect } from "vitest";
import { analyzeDangerousSql } from "../dangerousSql";

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
