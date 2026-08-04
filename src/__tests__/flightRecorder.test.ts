import { describe, expect, it } from "vitest";
import { isSingleCapturableStatement } from "../flightRecorder";

describe("isSingleCapturableStatement", () => {
  it("recognises a single INSERT/UPDATE/DELETE statement", () => {
    expect(isSingleCapturableStatement("INSERT INTO t (a) VALUES (1)")).toBe(true);
    expect(isSingleCapturableStatement("  update t set a=1 where id=1")).toBe(true);
    expect(isSingleCapturableStatement("DELETE FROM t WHERE id=1;")).toBe(true);
  });

  it("rejects SELECT, DDL, and empty input", () => {
    expect(isSingleCapturableStatement("SELECT * FROM t")).toBe(false);
    expect(isSingleCapturableStatement("CREATE TABLE t (id INT)")).toBe(false);
    expect(isSingleCapturableStatement("DROP TABLE t")).toBe(false);
    expect(isSingleCapturableStatement("")).toBe(false);
    expect(isSingleCapturableStatement("   ")).toBe(false);
  });

  it("rejects a multi-statement script even if the first statement is a DML write", () => {
    expect(isSingleCapturableStatement("UPDATE t SET a=1; DELETE FROM t2")).toBe(false);
    expect(isSingleCapturableStatement("INSERT INTO t (a) VALUES (1); SELECT 1")).toBe(false);
  });

  it("ignores a DML keyword hidden inside a comment or string literal", () => {
    expect(isSingleCapturableStatement("-- insert style guide\nSELECT * FROM t")).toBe(false);
    expect(isSingleCapturableStatement("SELECT 'update me' FROM t")).toBe(false);
  });
});
