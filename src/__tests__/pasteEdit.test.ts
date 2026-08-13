import { describe, it, expect } from "vitest";
import { CellValue, Column } from "../api/tauri";
import { parseClipboardGrid, planPasteEdit } from "../components/pasteEdit";
import { buildUpdateStatements, rowEditKey, validateCellInput, type PendingEdits } from "../components/cellEdit";
import type { BulkEditTarget } from "../components/bulkEdit";

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

const allEditable = () => true;
const noValidate = () => null;

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

describe("parseClipboardGrid", () => {
  it("splits a plain TSV block into rows and columns", () => {
    expect(parseClipboardGrid("a\tb\nc\td")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("normalizes CRLF and CR line endings", () => {
    expect(parseClipboardGrid("a\tb\r\nc\td")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(parseClipboardGrid("a\tb\rc\td")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("drops a single trailing empty row (Excel/Sheets append a final newline)", () => {
    expect(parseClipboardGrid("a\tb\nc\td\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("handles a single pasted value with no delimiters", () => {
    expect(parseClipboardGrid("hello")).toEqual([["hello"]]);
  });

  it("handles an empty selection copy (single empty cell)", () => {
    expect(parseClipboardGrid("")).toEqual([[""]]);
  });

  it("unwraps a quoted field and unescapes doubled quotes", () => {
    expect(parseClipboardGrid('a\t"He said ""hi"""\nc\td')).toEqual([
      ["a", 'He said "hi"'],
      ["c", "d"],
    ]);
  });

  it("keeps an embedded tab/newline inside a quoted field intact", () => {
    expect(parseClipboardGrid('"line1\nline2"\tb')).toEqual([["line1\nline2", "b"]]);
    expect(parseClipboardGrid('"a\tb"\tc')).toEqual([["a\tb", "c"]]);
  });
});

describe("planPasteEdit", () => {
  it("returns an empty plan when the table has no resolvable PK", () => {
    const plan = planPasteEdit({
      grid: [["x"]],
      rows,
      columns,
      pkIndices: [],
      targetRowIndices: [0],
      targetColIndices: [1],
      isColEditable: allEditable,
      validate: noValidate,
    });
    expect(plan.applied).toEqual([]);
    expect(plan.rowCount).toBe(0);
  });

  it("expands a rectangular paste across rows and columns", () => {
    const plan = planPasteEdit({
      grid: [
        ["x1", "1"],
        ["x2", "2"],
      ],
      rows,
      columns,
      pkIndices: PK,
      targetRowIndices: [0, 1],
      targetColIndices: [1, 2],
      isColEditable: allEditable,
      validate: noValidate,
    });
    expect(plan.applied).toHaveLength(4);
    expect(plan.rowCount).toBe(2);
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
      "UPDATE `db`.`users` SET `name` = 'x1', `age` = 1 WHERE `id` = 1;",
      "UPDATE `db`.`users` SET `name` = 'x2', `age` = 2 WHERE `id` = 2;",
    ]);
  });

  it("skips pasted rows beyond the available target rows and counts them", () => {
    const plan = planPasteEdit({
      grid: [["a"], ["b"], ["c"]],
      rows,
      columns,
      pkIndices: PK,
      // Only 2 rows are available to paste into (e.g. paste starts near the
      // bottom of the visible rows) — the 3rd pasted row has nowhere to go.
      targetRowIndices: [0, 1],
      targetColIndices: [1],
      isColEditable: allEditable,
      validate: noValidate,
    });
    expect(plan.applied).toHaveLength(2);
    expect(plan.skippedOutOfBounds).toBe(1);
  });

  it("skips pasted columns beyond the available target columns and counts them", () => {
    const plan = planPasteEdit({
      grid: [["a", "b", "c"]],
      rows,
      columns,
      pkIndices: PK,
      targetRowIndices: [0],
      // Only 2 columns available starting at the anchor.
      targetColIndices: [1, 2],
      isColEditable: allEditable,
      validate: noValidate,
    });
    expect(plan.applied).toHaveLength(2);
    expect(plan.skippedOutOfBounds).toBe(1);
  });

  it("skips non-editable columns and counts them", () => {
    const cols = [col("id", "INT"), col("data", "BLOB")];
    const blobRows: CellValue[][] = [[1, "deadbeef"]];
    const plan = planPasteEdit({
      grid: [["xx"]],
      rows: blobRows,
      columns: cols,
      pkIndices: PK,
      targetRowIndices: [0],
      targetColIndices: [1],
      isColEditable: (c) => c !== 1,
      validate: noValidate,
    });
    expect(plan.applied).toHaveLength(0);
    expect(plan.skippedReadonly).toBe(1);
  });

  it("skips cells whose pasted value is invalid for the column type", () => {
    const plan = planPasteEdit({
      grid: [["not-a-number"]],
      rows,
      columns,
      pkIndices: PK,
      targetRowIndices: [0],
      targetColIndices: [2], // age INT
      isColEditable: allEditable,
      validate: (colIdx, value) => validateCellInput(value, columns[colIdx].type_name, true),
    });
    expect(plan.applied).toHaveLength(0);
    expect(plan.skippedInvalid).toBe(1);
  });

  it("routes cells that already hold the pasted value to `unchanged`", () => {
    const plan = planPasteEdit({
      grid: [["alice"], ["bob"]],
      rows,
      columns,
      pkIndices: PK,
      targetRowIndices: [0, 1],
      targetColIndices: [1],
      isColEditable: allEditable,
      validate: noValidate,
    });
    expect(plan.applied).toEqual([]);
    expect(plan.unchanged).toEqual([
      { rowKey: rowEditKey(rows[0], PK, 0), colIdx: 1, value: null },
      { rowKey: rowEditKey(rows[1], PK, 1), colIdx: 1, value: null },
    ]);
    expect(plan.rowCount).toBe(0);
  });

  it("keys edits by PK identity, not array position", () => {
    const plan = planPasteEdit({
      grid: [["x"]],
      rows,
      columns,
      pkIndices: PK,
      targetRowIndices: [1],
      targetColIndices: [1],
      isColEditable: allEditable,
      validate: noValidate,
    });
    expect(plan.applied[0].rowKey).toBe(rowEditKey(rows[1], PK, 1));
  });

  it("treats a pasted NULL keyword the same as manual NULL entry", () => {
    const plan = planPasteEdit({
      grid: [["NULL"]],
      rows,
      columns,
      pkIndices: PK,
      targetRowIndices: [0],
      targetColIndices: [1],
      isColEditable: allEditable,
      validate: (colIdx, value) => validateCellInput(value, columns[colIdx].type_name, true),
    });
    expect(plan.applied).toEqual([{ rowKey: rowEditKey(rows[0], PK, 0), colIdx: 1, value: "NULL" }]);
    const stmts = buildUpdateStatements({
      driver: "mysql",
      database: "db",
      table: "users",
      columns,
      rows,
      pkIndices: PK,
      edits: toPending(plan.applied),
    });
    expect(stmts).toEqual(["UPDATE `db`.`users` SET `name` = NULL WHERE `id` = 1;"]);
  });
});
