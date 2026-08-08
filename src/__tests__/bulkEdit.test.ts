import { describe, it, expect } from "vitest";
import { CellValue, Column } from "../api/tauri";
import { planBulkCellEdit, type BulkEditTarget } from "../components/bulkEdit";
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
// `value === null` は「そのセルの保留編集を解除する」意味 (App の
// setBulkCellEditsForTab と同じ扱い)。
function toPending(applied: BulkEditTarget[]): PendingEdits {
  const out: PendingEdits = {};
  for (const e of applied) {
    const row = { ...(out[e.rowKey] ?? {}) };
    if (e.value === null) delete row[e.colIdx];
    else row[e.colIdx] = e.value;
    if (Object.keys(row).length === 0) delete out[e.rowKey];
    else out[e.rowKey] = row;
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

  // すでにその値を持つセルは編集を積まず、代わりに「保留編集を解除する」
  // エントリ (value: null) を返す。単一セル編集の no-op 判定と挙動を揃えるため。
  it("routes cells that already hold the value to `unchanged`", () => {
    const plan = planBulkCellEdit({
      rows,
      columns,
      pkIndices: PK,
      rowIndices: [0, 1],
      colIndices: [1],
      value: "alice", // row 0 はすでに "alice"、row 1 は "bob"
      isColEditable: allEditable,
      validate: noValidate,
    });
    expect(plan.applied).toEqual([
      { rowKey: rowEditKey(rows[1], PK, 1), colIdx: 1, value: "alice" },
    ]);
    expect(plan.unchanged).toEqual([
      { rowKey: rowEditKey(rows[0], PK, 0), colIdx: 1, value: null },
    ]);
    // 無変更の行は編集行数に数えない。
    expect(plan.rowCount).toBe(1);
  });

  it("does not emit a same-value UPDATE for an unchanged cell", () => {
    const plan = planBulkCellEdit({
      rows,
      columns,
      pkIndices: PK,
      rowIndices: [0],
      colIndices: [2], // age は 30、同じ値をセット
      value: "30",
      isColEditable: allEditable,
      validate: noValidate,
    });
    expect(plan.applied).toHaveLength(0);
    expect(plan.unchanged).toHaveLength(1);
    expect(
      buildUpdateStatements({
        driver: "mysql",
        database: "db",
        table: "users",
        columns,
        rows,
        pkIndices: PK,
        edits: toPending([...plan.applied, ...plan.unchanged]),
      }),
    ).toEqual([]);
  });

  it("clears an existing pending edit on a cell that already holds the value", () => {
    const rowKey = rowEditKey(rows[0], PK, 0);
    const plan = planBulkCellEdit({
      rows,
      columns,
      pkIndices: PK,
      rowIndices: [0],
      colIndices: [1],
      value: "alice",
      isColEditable: allEditable,
      validate: noValidate,
    });
    // 先に別の値の保留編集があっても、無変更セットで解除される。
    const before: PendingEdits = { [rowKey]: { 1: "typo" } };
    const after = { ...before };
    for (const e of [...plan.applied, ...plan.unchanged]) {
      const row = { ...(after[e.rowKey] ?? {}) };
      if (e.value === null) delete row[e.colIdx];
      else row[e.colIdx] = e.value;
      if (Object.keys(row).length === 0) delete after[e.rowKey];
      else after[e.rowKey] = row;
    }
    expect(after).toEqual({});
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
