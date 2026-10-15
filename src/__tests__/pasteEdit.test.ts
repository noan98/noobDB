import { describe, it, expect } from "vitest";
import type { CellValue, Column, TableColumnInfo } from "../api/tauri";
import {
  detectPasteHeader,
  parseInsertPaste,
  parseClipboardGrid,
  planPasteEdit,
  planPasteInsertRows,
} from "../components/pasteEdit";
import {
  buildInsertStatements,
  buildUpdateStatements,
  rowEditKey,
  validateCellInput,
  type PendingEdits,
} from "../components/cellEdit";
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

describe("planPasteInsertRows (#1539)", () => {
  const meta = (name: string, over: Partial<TableColumnInfo> = {}): TableColumnInfo => ({
    name,
    data_type: "int",
    nullable: true,
    key: "",
    default: null,
    extra: "",
    referenced_table: null,
    referenced_column: null,
    ...over,
  });
  const tableColumns = [
    meta("id", { key: "PRI", extra: "auto_increment" }),
    meta("name", { data_type: "varchar(20)" }),
    meta("age"),
    meta("total", { extra: "VIRTUAL GENERATED" }),
  ];
  const cols = [col("id", "INT"), col("name", "VARCHAR"), col("age", "INT"), col("total", "INT")];
  const base = {
    columns: cols,
    driver: "mysql",
    tableColumns,
    targetColIndices: [0, 1, 2, 3],
    validate: noValidate as (c: number, v: string) => unknown,
  };

  it("空欄は省き、NULL 表記と値はそのまま PendingInsertRow にする", () => {
    const plan = planPasteInsertRows({
      ...base,
      grid: [
        ["", "dave", "NULL"],
        ["", "erin", ""],
      ],
    });
    expect(plan.rows).toEqual([{ 1: "dave", 2: "NULL" }, { 1: "erin" }]);
    expect(plan.cells).toBe(3);
  });

  it("生成列は外し、自動採番列は明示値ならそのまま入れる", () => {
    const plan = planPasteInsertRows({ ...base, grid: [["10", "dave", "5", "999"]] });
    expect(plan.rows).toEqual([{ 0: "10", 1: "dave", 2: "5" }]);
    expect(plan.skippedGenerated).toBe(1);
  });

  it("BLOB 列は外して数える", () => {
    const columns = [col("id", "INT"), col("name", "VARCHAR"), col("data", "BLOB")];
    const plan = planPasteInsertRows({
      ...base,
      columns,
      tableColumns: null,
      targetColIndices: [0, 1, 2],
      grid: [
        ["1", "a", "deadbeef"],
        ["", "", "cafe"],
      ],
    });
    expect(plan.rows).toEqual([{ 0: "1", 1: "a" }]);
    expect(plan.skippedBinary).toBe(2);
    expect(plan.skippedBlankRows).toBe(1);
  });

  it("不正な値のセルだけを外し、値が残らない行は積まない", () => {
    const validate = (c: number, v: string) => (c === 2 && v === "abc" ? "bad" : null);
    const plan = planPasteInsertRows({
      ...base,
      validate,
      grid: [
        ["", "frank", "abc"],
        ["", "", "abc"],
        ["", "", ""],
      ],
    });
    expect(plan.rows).toEqual([{ 1: "frank" }]);
    expect(plan.skippedInvalid).toBe(2);
    expect(plan.skippedBlankRows).toBe(2);
  });

  it("表示列を超えたセルは数えて捨てる", () => {
    const plan = planPasteInsertRows({ ...base, targetColIndices: [1, 2], grid: [["x", "1", "y", "z"]] });
    expect(plan.rows).toEqual([{ 1: "x", 2: "1" }]);
    expect(plan.skippedOutOfBounds).toBe(2);
  });

  it("積んだ行は既存の buildInsertStatements でそのまま INSERT 文になる", () => {
    const plan = planPasteInsertRows({ ...base, grid: [["", "dave", "7"]] });
    expect(
      buildInsertStatements({
        driver: "mysql",
        database: "d",
        table: "t",
        columns: cols,
        inserts: plan.rows,
      }),
    ).toEqual(["INSERT INTO `d`.`t` (`name`, `age`) VALUES ('dave', 7);"]);
  });

  it("列メタが無くても動く (生成列の判定だけ省く)", () => {
    const plan = planPasteInsertRows({ ...base, tableColumns: null, grid: [["", "a", "", "9"]] });
    expect(plan.rows).toEqual([{ 1: "a", 3: "9" }]);
  });
});

describe("detectPasteHeader (#1628)", () => {
  const cols = ["id", "Name", "email"].map((name) => ({ name, type_name: "TEXT" })) as Column[];
  it("1 行目が列名と一致すれば、列順が違っても名前で対応付ける", () => {
    const m = detectPasteHeader(
      [
        ["email", "id"],
        ["a@x", "1"],
      ],
      cols,
    );
    expect(m).toEqual({ dataGrid: [["a@x", "1"]], targetColIndices: [2, 0], matched: 2 });
  });
  it("大小・前後空白を無視し、一致しない見出しの列は -1 で省く", () => {
    const m = detectPasteHeader(
      [
        [" NAME ", "id", "memo"],
        ["x", "1", "z"],
      ],
      cols,
    );
    expect(m?.targetColIndices).toEqual([1, 0, -1]);
    expect(m?.matched).toBe(2);
  });
  it("半数未満しか一致しない・1 行だけ・一致なしは null (従来どおりデータとして貼る)", () => {
    expect(
      detectPasteHeader(
        [
          ["id", "a", "b", "c"],
          ["1", "2", "3", "4"],
        ],
        cols,
      ),
    ).toBeNull();
    expect(detectPasteHeader([["id", "Name"]], cols)).toBeNull();
    expect(
      detectPasteHeader(
        [
          ["1", "2"],
          ["3", "4"],
        ],
        cols,
      ),
    ).toBeNull();
  });
  it("同名の列が複数ある結果は左から順に割り当てる", () => {
    const dup = ["id", "id"].map((name) => ({ name, type_name: "INT" })) as Column[];
    const m = detectPasteHeader(
      [
        ["id", "id"],
        ["1", "2"],
      ],
      dup,
    );
    expect(m?.targetColIndices).toEqual([0, 1]);
  });
  it("planPasteEdit に渡すと対応した列だけに適用される", () => {
    const m = detectPasteHeader(
      [
        ["email", "memo"],
        ["a@x", "ignored"],
      ],
      cols,
    );
    if (!m) throw new Error("header expected");
    const plan = planPasteEdit({
      grid: m.dataGrid,
      rows: [[1, "n", "old"]],
      columns: cols,
      pkIndices: [0],
      targetRowIndices: [0],
      targetColIndices: m.targetColIndices,
      isColEditable: () => true,
      validate: () => null,
    });
    expect(plan.applied.map((a) => [a.colIdx, a.value])).toEqual([[2, "a@x"]]);
  });
});

describe("parseInsertPaste (#1628)", () => {
  const cols = ["id", "name", "memo"].map((name) => ({ name, type_name: "TEXT" })) as Column[];
  it("タブ区切り 1 行を先頭の列から順に展開し、空欄は省く", () => {
    const r = parseInsertPaste("1\t\tnote", cols);
    expect(r?.values).toEqual({ 0: "1", 2: "note" });
    expect(r?.count).toBe(2);
    expect(r?.headerMapped).toBe(false);
  });
  it("startCol から展開し、範囲外の列は skipped に数える", () => {
    const r = parseInsertPaste("a\tb\tc", cols, { startCol: 2 });
    expect(r?.values).toEqual({ 2: "a" });
    expect(r?.skipped).toBe(2);
  });
  it("skip 対象の列 (生成列など) には入れない", () => {
    const r = parseInsertPaste("1\tx\ty", cols, { skip: (i) => i === 0 });
    expect(r?.values).toEqual({ 1: "x", 2: "y" });
    expect(r?.skipped).toBe(1);
  });
  it("1 行目が列名なら名前で対応付け、次の行を値にする。余った行数を返す", () => {
    const r = parseInsertPaste("memo\tid\nM\t7\nM2\t8", cols);
    expect(r?.values).toEqual({ 2: "M", 0: "7" });
    expect(r?.headerMapped).toBe(true);
    expect(r?.ignoredRows).toBe(1);
  });
  it("空のクリップボードは null", () => {
    expect(parseInsertPaste("", cols)?.count ?? 0).toBe(0);
  });
});
