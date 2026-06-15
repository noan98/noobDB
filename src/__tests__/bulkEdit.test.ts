import { describe, it, expect } from "vitest";
import { CellValue, Column } from "../api/tauri";
import { planBulkCellEdit } from "../components/bulkEdit";
import {
  buildUpdateStatements,
  isEditableColumnType,
  rowEditKey,
  validateCellInput,
  type PendingEdits,
} from "../components/cellEdit";

function col(name: string, type_name: string): Column {
  return { name, type_name };
}

// A 3-column table: id (PK, INT), name (VARCHAR), age (INT).
const columns = [col("id", "INT"), col("name", "VARCHAR"), col("age", "INT")];
const PK = [0];
const rows: CellValue[][] = [
  [1, "alice", 30],
  [2, "bob", 40],
  [3, "carol", 50],
];

// Default predicates: every column editable, no validation errors.
const allEditable = () => true;
const noValidate = () => null;

// Turn a plan into a PendingEdits map (as App would) so we can assert the
// generated SQL via the existing buildUpdateStatements.
function toPending(applied: { rowKey: string; colIdx: number; value: string }[]): PendingEdits {
  const out: PendingEdits = {};
  for (const e of applied) {
    out[e.rowKey] = { ...(out[e.rowKey] ?? {}), [e.colIdx]: e.value };
  }
  return out;
}

describe("planBulkCellEdit", () => {
  it("returns an empty plan when the table has no resolvable PK", () => {
    const plan = planBulkCellEdit({
      rows,
      columns,
      pkIndices: [],
      rowIndices: [0, 1],
      colIndices: [1],
      value: "x",
      isColEditable: allEditable,
      validate: noValidate,
    });
    expect(plan.applied).toEqual([]);
    expect(plan.rowCount).toBe(0);
  });

  it("applies a single value to every selected cell across rows and columns", () => {
    const plan = planBulkCellEdit({
      rows,
      columns,
      pkIndices: PK,
      rowIndices: [0, 1, 2],
      colIndices: [1],
      value: "redacted",
      isColEditable: allEditable,
      validate: noValidate,
    });
    expect(plan.applied).toHaveLength(3);
    expect(plan.rowCount).toBe(3);
    expect(plan.skippedReadonly).toBe(0);
    expect(plan.skippedInvalid).toBe(0);
    for (const e of plan.applied) {
      expect(e.colIdx).toBe(1);
      expect(e.value).toBe("redacted");
    }
  });

  it("feeds buildUpdateStatements to emit one UPDATE per selected row", () => {
    const plan = planBulkCellEdit({
      rows,
      columns,
      pkIndices: PK,
      rowIndices: [0, 2],
      colIndices: [1],
      value: "NULL",
      isColEditable: allEditable,
      validate: noValidate,
    });
    const stmts = buildUpdateStatements({
      driver: "mysql",
      database: "db",
      table: "users",
      columns,
      rows,
      pkIndices: PK,
      edits: toPending(plan.applied),
    });
    expect(stmts).toEqual([
      "UPDATE `db`.`users` SET `name` = NULL WHERE `id` = 1;",
      "UPDATE `db`.`users` SET `name` = NULL WHERE `id` = 3;",
    ]);
  });

  it("sets multiple columns in a row into one combined UPDATE", () => {
    const plan = planBulkCellEdit({
      rows,
      columns,
      pkIndices: PK,
      rowIndices: [1],
      colIndices: [1, 2],
      value: "9",
      isColEditable: allEditable,
      // age is INT but "9" is a valid number; name VARCHAR accepts anything.
      validate: (colIdx, value) =>
        validateCellInput(value, columns[colIdx].type_name, true),
    });
    expect(plan.applied).toHaveLength(2);
    const stmts = buildUpdateStatements({
      driver: "postgres",
      database: "db",
      table: "users",
      columns,
      rows,
      pkIndices: PK,
      edits: toPending(plan.applied),
    });
    expect(stmts).toEqual([`UPDATE "db"."users" SET "name" = '9', "age" = 9 WHERE "id" = 2;`]);
  });

  it("skips non-editable columns and counts them", () => {
    const cols = [col("id", "INT"), col("data", "BLOB")];
    const blobRows: CellValue[][] = [[1, "deadbeef"]];
    const plan = planBulkCellEdit({
      rows: blobRows,
      columns: cols,
      pkIndices: PK,
      rowIndices: [0],
      colIndices: [1],
      value: "x",
      isColEditable: (c) => isEditableColumnType(cols[c].type_name),
      validate: noValidate,
    });
    expect(plan.applied).toHaveLength(0);
    expect(plan.skippedReadonly).toBe(1);
    expect(plan.skippedInvalid).toBe(0);
  });

  it("skips cells whose value is invalid for the column type", () => {
    const plan = planBulkCellEdit({
      rows,
      columns,
      pkIndices: PK,
      rowIndices: [0, 1],
      colIndices: [2], // age INT
      value: "not-a-number",
      isColEditable: allEditable,
      validate: (colIdx, value) =>
        validateCellInput(value, columns[colIdx].type_name, true),
    });
    expect(plan.applied).toHaveLength(0);
    expect(plan.skippedInvalid).toBe(2);
  });

  it("keys edits by PK identity, not array position", () => {
    const plan = planBulkCellEdit({
      rows,
      columns,
      pkIndices: PK,
      rowIndices: [1],
      colIndices: [1],
      value: "x",
      isColEditable: allEditable,
      validate: noValidate,
    });
    expect(plan.applied[0].rowKey).toBe(rowEditKey(rows[1], PK, 1));
  });

  it("ignores out-of-range column indices without crashing", () => {
    const plan = planBulkCellEdit({
      rows,
      columns,
      pkIndices: PK,
      rowIndices: [0],
      colIndices: [99],
      value: "x",
      isColEditable: allEditable,
      validate: noValidate,
    });
    expect(plan.applied).toHaveLength(0);
    expect(plan.skippedReadonly).toBe(0);
    expect(plan.skippedInvalid).toBe(0);
  });
});
