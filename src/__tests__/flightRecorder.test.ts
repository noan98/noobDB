import { describe, expect, it } from "vitest";
import {
  batchUndoIsPartial,
  countCapturableStatements,
  isSingleCapturableStatement,
  noteBatchCaptureStats,
} from "../flightRecorder";

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

  it("rejects REPLACE and TRUNCATE, mirroring the backend's classify_write_kind", () => {
    // Symmetry with `db::classify_write_kind`'s own test
    // (`classify_write_kind_treats_everything_else_as_other`): `REPLACE INTO`
    // and `TRUNCATE` are not one of the three captured DML kinds.
    expect(isSingleCapturableStatement("REPLACE INTO t (a) VALUES (1)")).toBe(false);
    expect(isSingleCapturableStatement("TRUNCATE t")).toBe(false);
    expect(isSingleCapturableStatement("TRUNCATE TABLE t")).toBe(false);
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

describe("countCapturableStatements (#1626)", () => {
  it("counts only INSERT / UPDATE / DELETE statements of a multi-statement script", () => {
    const sql =
      "CREATE TABLE t (id INT); INSERT INTO t VALUES (1); SELECT * FROM t; UPDATE t SET id = 2; DELETE FROM t;";
    expect(countCapturableStatements(sql)).toBe(3);
  });

  it("ignores semicolons inside string literals and empty statements", () => {
    expect(countCapturableStatements("INSERT INTO t VALUES ('a;b');;  ;")).toBe(1);
    expect(countCapturableStatements("SELECT 1; SELECT 2")).toBe(0);
    expect(countCapturableStatements("")).toBe(0);
  });

  it("does not treat a keyword inside a literal as a statement start", () => {
    expect(countCapturableStatements("SELECT 'insert into x'")).toBe(0);
  });
});

describe("batchUndoIsPartial", () => {
  it("統計が無い (再起動後など) バッチは注記しない", () => {
    expect(batchUndoIsPartial("unknown-batch", 3)).toBe(false);
  });

  it("記録できなかった文があるか、記録が欠けているときだけ真", () => {
    noteBatchCaptureStats("b-full", 3, 0);
    expect(batchUndoIsPartial("b-full", 3)).toBe(false);
    noteBatchCaptureStats("b-skipped", 3, 2);
    expect(batchUndoIsPartial("b-skipped", 3)).toBe(true);
    noteBatchCaptureStats("b-missing", 3, 0);
    expect(batchUndoIsPartial("b-missing", 2)).toBe(true);
  });

  it("バッチ id が無ければ何も控えない", () => {
    noteBatchCaptureStats(null, 1, 1);
    expect(batchUndoIsPartial("", 0)).toBe(false);
  });
});
