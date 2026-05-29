import { describe, it, expect } from "vitest";
import { Column, TableColumnInfo } from "../api/tauri";
import {
  buildUpdateStatements,
  countEditedCells,
  countEditedRows,
  isEditableColumnType,
  resolvePkIndices,
  type BuildUpdateInput,
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
      buildUpdateStatements(baseInput({ edits: { 0: { 1: "new" } } })),
    ).toEqual(["UPDATE `db`.`tbl` SET `name` = 'new' WHERE `id` = 1;"]);
  });

  it("emits numeric input for numeric columns unquoted", () => {
    expect(
      buildUpdateStatements(baseInput({ edits: { 0: { 0: "5" } } })),
    ).toEqual(["UPDATE `db`.`tbl` SET `id` = 5 WHERE `id` = 1;"]);
  });

  it("treats the NULL keyword as SQL NULL", () => {
    expect(
      buildUpdateStatements(baseInput({ edits: { 0: { 1: "null" } } })),
    ).toEqual(["UPDATE `db`.`tbl` SET `name` = NULL WHERE `id` = 1;"]);
  });

  it("uses the original PK value in WHERE even when the PK is edited", () => {
    expect(
      buildUpdateStatements(baseInput({ edits: { 0: { 0: "99" } } })),
    ).toEqual(["UPDATE `db`.`tbl` SET `id` = 99 WHERE `id` = 1;"]);
  });

  it("keeps targeting the right row by PK after rows are appended (loadMore)", () => {
    // `loadMore` appends fetched rows, leaving existing rows at their original
    // indices. An edit keyed by index 1 must still resolve to that row's PK (2),
    // never to a row that arrived in a later page. (Issue #330 — App.tsx clears
    // pending edits on loadMore as the safe-side guard, but the targeting must
    // also be correct should an edit ever survive an append.)
    const rowsAfterLoadMore = [
      [1, "old"],
      [2, "foo"],
      [3, "page2-a"],
      [4, "page2-b"],
    ];
    expect(
      buildUpdateStatements(
        baseInput({ rows: rowsAfterLoadMore, edits: { 1: { 1: "edited" } } }),
      ),
    ).toEqual(["UPDATE `db`.`tbl` SET `name` = 'edited' WHERE `id` = 2;"]);
  });

  it("quotes identifiers and qualifies for Postgres", () => {
    expect(
      buildUpdateStatements(
        baseInput({ driver: "postgres", edits: { 0: { 1: "new" } } }),
      ),
    ).toEqual(['UPDATE "db"."tbl" SET "name" = \'new\' WHERE "id" = 1;']);
  });

  it("omits the database prefix for SQLite", () => {
    expect(
      buildUpdateStatements(
        baseInput({ driver: "sqlite", edits: { 0: { 1: "new" } } }),
      ),
    ).toEqual(['UPDATE "tbl" SET "name" = \'new\' WHERE "id" = 1;']);
  });

  it("doubles single quotes in string literals", () => {
    expect(
      buildUpdateStatements(baseInput({ edits: { 0: { 1: "O'Brien" } } })),
    ).toEqual(["UPDATE `db`.`tbl` SET `name` = 'O''Brien' WHERE `id` = 1;"]);
  });

  it("escapes backslashes for MySQL but not Postgres", () => {
    expect(
      buildUpdateStatements(baseInput({ edits: { 0: { 1: "a\\b" } } })),
    ).toEqual(["UPDATE `db`.`tbl` SET `name` = 'a\\\\b' WHERE `id` = 1;"]);
    expect(
      buildUpdateStatements(
        baseInput({ driver: "postgres", edits: { 0: { 1: "a\\b" } } }),
      ),
    ).toEqual(['UPDATE "db"."tbl" SET "name" = \'a\\b\' WHERE "id" = 1;']);
  });

  it("maps boolean columns to TRUE/FALSE", () => {
    const columns = [col("id", "INT"), col("flag", "BOOLEAN")];
    expect(
      buildUpdateStatements(
        baseInput({ columns, edits: { 0: { 1: "true" } } }),
      ),
    ).toEqual(["UPDATE `db`.`tbl` SET `flag` = TRUE WHERE `id` = 1;"]);
    expect(
      buildUpdateStatements(baseInput({ columns, edits: { 0: { 1: "0" } } })),
    ).toEqual(["UPDATE `db`.`tbl` SET `flag` = FALSE WHERE `id` = 1;"]);
  });

  it("emits one statement per edited row in ascending row order", () => {
    expect(
      buildUpdateStatements(
        baseInput({ edits: { 1: { 1: "y" }, 0: { 1: "x" } } }),
      ),
    ).toEqual([
      "UPDATE `db`.`tbl` SET `name` = 'x' WHERE `id` = 1;",
      "UPDATE `db`.`tbl` SET `name` = 'y' WHERE `id` = 2;",
    ]);
  });
});

describe("edit counters", () => {
  it("counts cells and rows independently", () => {
    const edits = { 0: { 0: "a", 1: "b" }, 1: { 0: "c" } };
    expect(countEditedCells(edits)).toBe(3);
    expect(countEditedRows(edits)).toBe(2);
  });

  it("returns zero for an empty edit set", () => {
    expect(countEditedCells({})).toBe(0);
    expect(countEditedRows({})).toBe(0);
  });
});
