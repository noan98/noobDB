import { describe, expect, it } from "vitest";
import { isMissingSavepointError, afterRelease, afterRollbackTo, isValidSavepointName, pushSavepoint, savepointName } from "../savepoints";

describe("savepoints", () => {
  it("generates valid names", () => {
    expect(savepointName(3)).toBe("sp_3");
    expect(isValidSavepointName(savepointName(12))).toBe(true);
  });

  it("rejects unsafe names", () => {
    for (const n of ["", "1a", "a b", 'a"b', "a`b", "a;b", "日本", "a".repeat(64)]) {
      expect(isValidSavepointName(n)).toBe(false);
    }
    expect(isValidSavepointName("a".repeat(63))).toBe(true);
  });

  it("push appends and moves duplicates to the end", () => {
    expect(pushSavepoint(["a", "b"], "c")).toEqual(["a", "b", "c"]);
    expect(pushSavepoint(["a", "b"], "a")).toEqual(["b", "a"]);
  });

  it("rollback to keeps the target and drops newer ones", () => {
    expect(afterRollbackTo(["a", "b", "c"], "b")).toEqual(["a", "b"]);
    expect(afterRollbackTo(["a", "b"], "b")).toEqual(["a", "b"]);
    expect(afterRollbackTo(["a", "b"], "x")).toEqual(["a", "b"]);
  });

  it("release drops the target and newer ones", () => {
    expect(afterRelease(["a", "b", "c"], "b")).toEqual(["a"]);
    expect(afterRelease(["a", "b", "c"], "c")).toEqual(["a", "b"]);
    expect(afterRelease(["a"], "x")).toEqual(["a"]);
  });

  it("detects missing-savepoint errors", () => {
    expect(isMissingSavepointError("ERROR 1305 (42000): SAVEPOINT sp_1 does not exist")).toBe(true);
    expect(isMissingSavepointError('error returned from database: savepoint "sp_1" does not exist')).toBe(true);
    expect(isMissingSavepointError("no such savepoint: sp_1")).toBe(true);
    expect(isMissingSavepointError("syntax error")).toBe(false);
  });
});
