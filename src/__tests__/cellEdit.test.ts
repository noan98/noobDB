import { describe, it, expect } from "vitest";
import { CellValue, Column, TableColumnInfo } from "../api/tauri";
import {
  buildUpdateStatements,
  countEditedCells,
  countEditedRows,
  isEditableColumnType,
  resolvePkIndices,
  rowPkKey,
  type BuildUpdateInput,
  type PendingEdits,
} from "../components/cellEdit";

function col(name: string, type_name: string): Column {
  return { name, type_name };
}

function tcol(name: string, key: string): TableColumnInfo {
  return {
    name,
    data_type: "text",
    nullable: true,
    key,
    default: null,
    extra: "",
    referenced_table: null,
    referenced_column: null,
  };
}

describe("isEditableColumnType", () => {
  it("allows ordinary column types", () => {
    expect(isEditableColumnType("VARCHAR")).toBe(true);
    expect(isEditableColumnType("INT")).toBe(true);
  });

  it("rejects BLOB-family types case-insensitively", () => {
    expect(isEditableColumnType("BLOB")).toBe(false);
    expect(isEditableColumnType("longblob")).toBe(false);
    expect(isEditableColumnType("VarBinary")).toBe(false);
  });
});

describe("resolvePkIndices", () => {
  const columns = [col("id", "INT"), col("name", "VARCHAR")];

  it("returns [] when table columns are unknown", () => {
    expect(resolvePkIndices(columns, null)).toEqual([]);
  });

  it("returns [] when there is no primary key", () => {
    expect(resolvePkIndices(columns, [tcol("id", ""), tcol("name", "")])).toEqual(
      [],
    );
  });

  it("resolves a single primary key to its result index", () => {
    expect(
      resolvePkIndices(columns, [tcol("id", "PRI"), tcol("name", "")]),
    ).toEqual([0]);
  });

  it("returns [] when a PK column is missing from the result", () => {
    expect(resolvePkIndices([col("name", "VARCHAR")], [tcol("id", "PRI")])).toEqual(
      [],
    );
  });

  it("resolves a composite PK in primary-key order", () => {
    const cols = [col("a", "INT"), col("b", "INT"), col("c", "INT")];
    expect(
      resolvePkIndices(cols, [tcol("c", "PRI"), tcol("a", "PRI")]),
    ).toEqual([2, 0]);
  });
});

// Builds a PK-keyed PendingEdits map from (pk, cells) pairs, mirroring how
// the grid records edits via `rowPkKey`.
function pendingEdits(
  ...entries: { pk: CellValue[]; cells: Record<number, string> }[]
): PendingEdits {
  const out: PendingEdits = {};
  for (const e of entries) out[rowPkKey(e.pk)] = { pk: e.pk, cells: e.cells };
  return out;
}

function baseInput(overrides: Partial<BuildUpdateInput>): BuildUpdateInput {
  return {
    driver: "mysql",
    database: "db",
    table: "tbl",
    columns: [col("id", "INT"), col("name", "VARCHAR")],
    pkIndices: [0],
    edits: {},
    ...overrides,
  };
}

describe("rowPkKey", () => {
  it("distinguishes numbers from look-alike strings", () => {
    expect(rowPkKey([1])).not.toBe(rowPkKey(["1"]));
  });

  it("is stable for equal composite keys and order-sensitive", () => {
    expect(rowPkKey([1, "a"])).toBe(rowPkKey([1, "a"]));
    expect(rowPkKey([1, "a"])).not.toBe(rowPkKey(["a", 1]));
  });
});

describe("buildUpdateStatements", () => {
  it("returns [] when the primary key is unresolved", () => {
    expect(
      buildUpdateStatements(
        baseInput({ pkIndices: [], edits: pendingEdits({ pk: [1], cells: { 1: "new" } }) }),
      ),
    ).toEqual([]);
  });

  it("builds a quoted, qualified UPDATE for MySQL", () => {
    expect(
      buildUpdateStatements(baseInput({ edits: pendingEdits({ pk: [1], cells: { 1: "new" } }) })),
    ).toEqual(["UPDATE `db`.`tbl` SET `name` = 'new' WHERE `id` = 1;"]);
  });

  it("emits numeric input for numeric columns unquoted", () => {
    expect(
      buildUpdateStatements(baseInput({ edits: pendingEdits({ pk: [1], cells: { 0: "5" } }) })),
    ).toEqual(["UPDATE `db`.`tbl` SET `id` = 5 WHERE `id` = 1;"]);
  });

  it("treats the NULL keyword as SQL NULL", () => {
    expect(
      buildUpdateStatements(baseInput({ edits: pendingEdits({ pk: [1], cells: { 1: "null" } }) })),
    ).toEqual(["UPDATE `db`.`tbl` SET `name` = NULL WHERE `id` = 1;"]);
  });

  it("uses the row's captured PK value in WHERE", () => {
    // The WHERE clause comes from the PK captured when the edit was made, not
    // from any current row position — so it targets the right row regardless
    // of pagination / re-sort. (Issue #330 — 方針 2: PK-based identification.)
    expect(
      buildUpdateStatements(baseInput({ edits: pendingEdits({ pk: [2], cells: { 1: "edited" } }) })),
    ).toEqual(["UPDATE `db`.`tbl` SET `name` = 'edited' WHERE `id` = 2;"]);
  });

  it("drops a row whose captured PK is incomplete (composite mismatch)", () => {
    // A composite-PK table needs every PK value to form a safe WHERE; a stale
    // single-value capture is skipped rather than producing a too-broad UPDATE.
    const columns = [col("a", "INT"), col("b", "INT"), col("c", "VARCHAR")];
    expect(
      buildUpdateStatements(
        baseInput({
          columns,
          pkIndices: [0, 1],
          edits: pendingEdits({ pk: [1], cells: { 2: "x" } }),
        }),
      ),
    ).toEqual([]);
  });

  it("builds a composite-PK WHERE in primary-key order", () => {
    const columns = [col("a", "INT"), col("b", "INT"), col("c", "VARCHAR")];
    expect(
      buildUpdateStatements(
        baseInput({
          columns,
          pkIndices: [0, 1],
          edits: pendingEdits({ pk: [1, 2], cells: { 2: "x" } }),
        }),
      ),
    ).toEqual(["UPDATE `db`.`tbl` SET `c` = 'x' WHERE `a` = 1 AND `b` = 2;"]);
  });

  it("quotes identifiers and qualifies for Postgres", () => {
    expect(
      buildUpdateStatements(
        baseInput({ driver: "postgres", edits: pendingEdits({ pk: [1], cells: { 1: "new" } }) }),
      ),
    ).toEqual(['UPDATE "db"."tbl" SET "name" = \'new\' WHERE "id" = 1;']);
  });

  it("omits the database prefix for SQLite", () => {
    expect(
      buildUpdateStatements(
        baseInput({ driver: "sqlite", edits: pendingEdits({ pk: [1], cells: { 1: "new" } }) }),
      ),
    ).toEqual(['UPDATE "tbl" SET "name" = \'new\' WHERE "id" = 1;']);
  });

  it("doubles single quotes in string literals", () => {
    expect(
      buildUpdateStatements(baseInput({ edits: pendingEdits({ pk: [1], cells: { 1: "O'Brien" } }) })),
    ).toEqual(["UPDATE `db`.`tbl` SET `name` = 'O''Brien' WHERE `id` = 1;"]);
  });

  it("escapes backslashes for MySQL but not Postgres", () => {
    expect(
      buildUpdateStatements(baseInput({ edits: pendingEdits({ pk: [1], cells: { 1: "a\\b" } }) })),
    ).toEqual(["UPDATE `db`.`tbl` SET `name` = 'a\\\\b' WHERE `id` = 1;"]);
    expect(
      buildUpdateStatements(
        baseInput({ driver: "postgres", edits: pendingEdits({ pk: [1], cells: { 1: "a\\b" } }) }),
      ),
    ).toEqual(['UPDATE "db"."tbl" SET "name" = \'a\\b\' WHERE "id" = 1;']);
  });

  it("maps boolean columns to TRUE/FALSE", () => {
    const columns = [col("id", "INT"), col("flag", "BOOLEAN")];
    expect(
      buildUpdateStatements(
        baseInput({ columns, edits: pendingEdits({ pk: [1], cells: { 1: "true" } }) }),
      ),
    ).toEqual(["UPDATE `db`.`tbl` SET `flag` = TRUE WHERE `id` = 1;"]);
    expect(
      buildUpdateStatements(
        baseInput({ columns, edits: pendingEdits({ pk: [1], cells: { 1: "0" } }) }),
      ),
    ).toEqual(["UPDATE `db`.`tbl` SET `flag` = FALSE WHERE `id` = 1;"]);
  });

  it("emits one statement per edited row in a deterministic order", () => {
    expect(
      buildUpdateStatements(
        baseInput({
          edits: pendingEdits(
            { pk: [2], cells: { 1: "y" } },
            { pk: [1], cells: { 1: "x" } },
          ),
        }),
      ),
    ).toEqual([
      "UPDATE `db`.`tbl` SET `name` = 'x' WHERE `id` = 1;",
      "UPDATE `db`.`tbl` SET `name` = 'y' WHERE `id` = 2;",
    ]);
  });
});

describe("edit counters", () => {
  it("counts cells and rows independently", () => {
    const edits = pendingEdits(
      { pk: [1], cells: { 0: "a", 1: "b" } },
      { pk: [2], cells: { 0: "c" } },
    );
    expect(countEditedCells(edits)).toBe(3);
    expect(countEditedRows(edits)).toBe(2);
  });

  it("returns zero for an empty edit set", () => {
    expect(countEditedCells({})).toBe(0);
    expect(countEditedRows({})).toBe(0);
  });
});
