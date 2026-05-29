import { describe, it, expect } from "vitest";
import { CellValue, Column, TableColumnInfo } from "../api/tauri";
import {
  buildUpdateStatements,
  countEditedCells,
  countEditedRows,
  isEditableColumnType,
  resolvePkIndices,
  rowEditKey,
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

// Edit key for a row whose (single) PK column holds `pkValue`. Mirrors how the
// grid keys buffered edits: the row's array position is irrelevant.
function k(pkValue: CellValue): string {
  return rowEditKey([pkValue], [0], 0);
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

describe("rowEditKey", () => {
  it("keys by primary-key value, independent of array position", () => {
    // Same PK in two different rows/pages → same key; the index is ignored.
    expect(rowEditKey([7, "a"], [0], 0)).toBe(rowEditKey([7, "z"], [0], 9));
  });

  it("distinguishes different PK values", () => {
    expect(rowEditKey([1], [0], 0)).not.toBe(rowEditKey([2], [0], 0));
  });

  it("does not collapse a number, its string form, a boolean, or NULL", () => {
    const keys = [
      rowEditKey([1], [0], 0),
      rowEditKey(["1"], [0], 0),
      rowEditKey([true], [0], 0),
      rowEditKey([null], [0], 0),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps composite keys unambiguous regardless of value contents", () => {
    // Without length-prefixing, ["as","b"] and ["a","sb"] could collide.
    expect(rowEditKey(["as", "b"], [0, 1], 0)).not.toBe(
      rowEditKey(["a", "sb"], [0, 1], 0),
    );
  });

  it("falls back to a position key (distinct from any PK key) without a PK", () => {
    expect(rowEditKey([1, "x"], [], 3)).toBe("i3");
    expect(rowEditKey([1, "x"], [], 3)).not.toBe(rowEditKey([1, "x"], [0], 3));
  });
});

function baseInput(overrides: Partial<BuildUpdateInput>): BuildUpdateInput {
  return {
    driver: "mysql",
    database: "db",
    table: "tbl",
    columns: [col("id", "INT"), col("name", "VARCHAR")],
    rows: [
      [1, "old"],
      [2, "foo"],
    ],
    pkIndices: [0],
    edits: {},
    ...overrides,
  };
}

describe("buildUpdateStatements", () => {
  it("returns [] when the primary key is unresolved", () => {
    expect(buildUpdateStatements(baseInput({ pkIndices: [] }))).toEqual([]);
  });

  it("builds a quoted, qualified UPDATE for MySQL", () => {
    expect(
      buildUpdateStatements(baseInput({ edits: { [k(1)]: { 1: "new" } } })),
    ).toEqual(["UPDATE `db`.`tbl` SET `name` = 'new' WHERE `id` = 1;"]);
  });

  it("emits numeric input for numeric columns unquoted", () => {
    expect(
      buildUpdateStatements(baseInput({ edits: { [k(1)]: { 0: "5" } } })),
    ).toEqual(["UPDATE `db`.`tbl` SET `id` = 5 WHERE `id` = 1;"]);
  });

  it("treats the NULL keyword as SQL NULL", () => {
    expect(
      buildUpdateStatements(baseInput({ edits: { [k(1)]: { 1: "null" } } })),
    ).toEqual(["UPDATE `db`.`tbl` SET `name` = NULL WHERE `id` = 1;"]);
  });

  it("uses the original PK value in WHERE even when the PK is edited", () => {
    expect(
      buildUpdateStatements(baseInput({ edits: { [k(1)]: { 0: "99" } } })),
    ).toEqual(["UPDATE `db`.`tbl` SET `id` = 99 WHERE `id` = 1;"]);
  });

  it("keeps targeting the right row by PK after rows are appended (loadMore)", () => {
    // `loadMore` appends fetched rows. An edit keyed by the PK of the second
    // row (id 2) must still resolve to it, never to a row that arrived in a
    // later page — even if the edited row's array index shifts. (Issues
    // #330 / #352: edits now survive pagination because they are PK-keyed.)
    const rowsAfterLoadMore = [
      [1, "old"],
      [2, "foo"],
      [3, "page2-a"],
      [4, "page2-b"],
    ];
    expect(
      buildUpdateStatements(
        baseInput({ rows: rowsAfterLoadMore, edits: { [k(2)]: { 1: "edited" } } }),
      ),
    ).toEqual(["UPDATE `db`.`tbl` SET `name` = 'edited' WHERE `id` = 2;"]);
  });

  it("targets the right row even when the array order changes", () => {
    // Same PK key, but the edited row now sits at a different array index
    // (e.g. a re-sorted/re-surfaced page). PK keying makes this a no-op.
    const reordered = [
      [2, "foo"],
      [1, "old"],
    ];
    expect(
      buildUpdateStatements(
        baseInput({ rows: reordered, edits: { [k(1)]: { 1: "x" } } }),
      ),
    ).toEqual(["UPDATE `db`.`tbl` SET `name` = 'x' WHERE `id` = 1;"]);
  });

  it("emits a re-surfaced row only once", () => {
    // Pagination without a stable ORDER BY can return the same row twice; the
    // edit should produce a single UPDATE, not a duplicate.
    const withDup = [
      [1, "old"],
      [2, "foo"],
      [1, "old-again"],
    ];
    expect(
      buildUpdateStatements(
        baseInput({ rows: withDup, edits: { [k(1)]: { 1: "x" } } }),
      ),
    ).toEqual(["UPDATE `db`.`tbl` SET `name` = 'x' WHERE `id` = 1;"]);
  });

  it("quotes identifiers and qualifies for Postgres", () => {
    expect(
      buildUpdateStatements(
        baseInput({ driver: "postgres", edits: { [k(1)]: { 1: "new" } } }),
      ),
    ).toEqual(['UPDATE "db"."tbl" SET "name" = \'new\' WHERE "id" = 1;']);
  });

  it("omits the database prefix for SQLite", () => {
    expect(
      buildUpdateStatements(
        baseInput({ driver: "sqlite", edits: { [k(1)]: { 1: "new" } } }),
      ),
    ).toEqual(['UPDATE "tbl" SET "name" = \'new\' WHERE "id" = 1;']);
  });

  it("doubles single quotes in string literals", () => {
    expect(
      buildUpdateStatements(baseInput({ edits: { [k(1)]: { 1: "O'Brien" } } })),
    ).toEqual(["UPDATE `db`.`tbl` SET `name` = 'O''Brien' WHERE `id` = 1;"]);
  });

  it("escapes backslashes for MySQL but not Postgres", () => {
    expect(
      buildUpdateStatements(baseInput({ edits: { [k(1)]: { 1: "a\\b" } } })),
    ).toEqual(["UPDATE `db`.`tbl` SET `name` = 'a\\\\b' WHERE `id` = 1;"]);
    expect(
      buildUpdateStatements(
        baseInput({ driver: "postgres", edits: { [k(1)]: { 1: "a\\b" } } }),
      ),
    ).toEqual(['UPDATE "db"."tbl" SET "name" = \'a\\b\' WHERE "id" = 1;']);
  });

  it("maps boolean columns to TRUE/FALSE", () => {
    const columns = [col("id", "INT"), col("flag", "BOOLEAN")];
    expect(
      buildUpdateStatements(
        baseInput({ columns, edits: { [k(1)]: { 1: "true" } } }),
      ),
    ).toEqual(["UPDATE `db`.`tbl` SET `flag` = TRUE WHERE `id` = 1;"]);
    expect(
      buildUpdateStatements(baseInput({ columns, edits: { [k(1)]: { 1: "0" } } })),
    ).toEqual(["UPDATE `db`.`tbl` SET `flag` = FALSE WHERE `id` = 1;"]);
  });

  it("emits one statement per edited row in row (top-to-bottom) order", () => {
    expect(
      buildUpdateStatements(
        baseInput({ edits: { [k(2)]: { 1: "y" }, [k(1)]: { 1: "x" } } }),
      ),
    ).toEqual([
      "UPDATE `db`.`tbl` SET `name` = 'x' WHERE `id` = 1;",
      "UPDATE `db`.`tbl` SET `name` = 'y' WHERE `id` = 2;",
    ]);
  });
});

describe("edit counters", () => {
  it("counts cells and rows independently", () => {
    const edits: PendingEdits = { [k(1)]: { 0: "a", 1: "b" }, [k(2)]: { 0: "c" } };
    expect(countEditedCells(edits)).toBe(3);
    expect(countEditedRows(edits)).toBe(2);
  });

  it("returns zero for an empty edit set", () => {
    expect(countEditedCells({})).toBe(0);
    expect(countEditedRows({})).toBe(0);
  });
});
