import { describe, it, expect } from "vitest";
import { CellValue, Column, TableColumnInfo, TableRowIdentity } from "../api/tauri";
import {
  applyEditsToRows,
  buildDeleteStatements,
  buildInsertClipboard,
  buildInsertStatements,
  buildRowSql,
  buildUpdateGroups,
  buildUpdateStatements,
  cellValueFromInput,
  countEditedCells,
  countEditedRows,
  FALLBACK_INSERT_TABLE,
  hasAmbiguousIdentity,
  isEditableColumnType,
  isBinaryColumnType,
  isIntegerColumnType,
  classifyEditType,
  isInsertEmptyStringValue,
  isInsertFunctionValue,
  isEmptyInsertValue,
  editIsNoop,
  buildBlobUpdateStatement,
  buildRowWhere,
  previewSavedValue,
  literalFromCellValue,
  oldValueForLock,
  literalFromInput,
  resolvePkIndices,
  setValueFromInput,
  resolveRowIdentity,
  rowEditKey,
  parseBooleanInput,
  validateCellInput,
  type BuildRowSqlInput,
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

  it("rejects PostgreSQL BYTEA case-insensitively (regression: #修正4)", () => {
    // db/postgres.rs は bytea 列を type_name = "BYTEA" として報告する。ここが
    // false を返さないと編集不可の防御をすり抜け、hex 文字列がテキストとして
    // 書き込まれて元のバイナリ値を破壊してしまう。
    expect(isEditableColumnType("BYTEA")).toBe(false);
    expect(isEditableColumnType("bytea")).toBe(false);
  });
});

describe("resolvePkIndices", () => {
  const columns = [col("id", "INT"), col("name", "VARCHAR")];

  it("returns [] when table columns are unknown", () => {
    expect(resolvePkIndices(columns, null)).toEqual([]);
  });

  it("returns [] when there is no primary key", () => {
    expect(resolvePkIndices(columns, [tcol("id", ""), tcol("name", "")])).toEqual([]);
  });

  it("resolves a single primary key to its result index", () => {
    expect(resolvePkIndices(columns, [tcol("id", "PRI"), tcol("name", "")])).toEqual([0]);
  });

  it("returns [] when a PK column is missing from the result", () => {
    expect(resolvePkIndices([col("name", "VARCHAR")], [tcol("id", "PRI")])).toEqual([]);
  });

  it("resolves a composite PK in primary-key order", () => {
    const cols = [col("a", "INT"), col("b", "INT"), col("c", "INT")];
    expect(resolvePkIndices(cols, [tcol("c", "PRI"), tcol("a", "PRI")])).toEqual([2, 0]);
  });
});

function rowIdentity(strategy: string, hidden_column: string | null = null): TableRowIdentity {
  return { strategy, hidden_column };
}

describe("resolveRowIdentity", () => {
  const columns = [col("id", "INT"), col("name", "VARCHAR")];

  it("prefers a real primary key over any rowIdentity fallback", () => {
    expect(
      resolveRowIdentity(columns, [tcol("id", "PRI"), tcol("name", "")], rowIdentity("all_columns")),
    ).toEqual({ indices: [0], strategy: "primary_key" });
  });

  it("resolves a unique_key identity from key_columns, in key order (#1776)", () => {
    const cols = [col("id", "INT"), col("a", "VARCHAR"), col("b", "VARCHAR")];
    const tcols = [tcol("id", ""), tcol("a", ""), tcol("b", "")];
    expect(
      resolveRowIdentity(cols, tcols, { ...rowIdentity("unique_key"), key_columns: ["b", "a"] }),
    ).toEqual({ indices: [2, 1], strategy: "unique_key" });
  });

  it("returns none for unique_key when a key column is missing from the result or key_columns is empty", () => {
    const cols = [col("id", "INT"), col("a", "VARCHAR")];
    const tcols = [tcol("id", ""), tcol("a", ""), tcol("b", "")];
    const none = { indices: [], strategy: "none" };
    expect(
      resolveRowIdentity(cols, tcols, { ...rowIdentity("unique_key"), key_columns: ["a", "b"] }),
    ).toEqual(none);
    expect(resolveRowIdentity(cols, tcols, rowIdentity("unique_key"))).toEqual(none);
  });

  it("returns none when there is no PK and no rowIdentity", () => {
    expect(resolveRowIdentity(columns, [tcol("id", ""), tcol("name", "")], null)).toEqual({
      indices: [],
      strategy: "none",
    });
  });

  it("resolves a rowid pseudo-column by name", () => {
    const withRowid = [col("id", "INT"), col("name", "VARCHAR"), col("rowid", "INTEGER")];
    expect(
      resolveRowIdentity(withRowid, [tcol("id", ""), tcol("name", "")], rowIdentity("rowid", "rowid")),
    ).toEqual({ indices: [2], strategy: "rowid" });
  });

  it("resolves a ctid pseudo-column by name", () => {
    const withCtid = [col("id", "INT"), col("ctid", "tid")];
    expect(resolveRowIdentity(withCtid, [tcol("id", "")], rowIdentity("ctid", "ctid"))).toEqual({
      indices: [1],
      strategy: "ctid",
    });
  });

  it("falls back to none when the rowid/ctid column is missing from the result", () => {
    // e.g. the browse SQL wasn't rebuilt with the hidden column yet.
    expect(
      resolveRowIdentity(columns, [tcol("id", ""), tcol("name", "")], rowIdentity("rowid", "rowid")),
    ).toEqual({ indices: [], strategy: "none" });
  });

  it("falls back to all result columns for the all_columns strategy", () => {
    expect(
      resolveRowIdentity(columns, [tcol("id", ""), tcol("name", "")], rowIdentity("all_columns")),
    ).toEqual({ indices: [0, 1], strategy: "all_columns" });
  });

  it("returns none for an empty result", () => {
    expect(resolveRowIdentity([], null, rowIdentity("all_columns"))).toEqual({
      indices: [],
      strategy: "none",
    });
  });

  it("returns none for an unrecognized strategy", () => {
    expect(resolveRowIdentity(columns, [tcol("id", ""), tcol("name", "")], rowIdentity("none"))).toEqual({
      indices: [],
      strategy: "none",
    });
  });
});

describe("hasAmbiguousIdentity", () => {
  it("returns false when identity indices are empty", () => {
    expect(
      hasAmbiguousIdentity(
        [
          [1, "a"],
          [1, "a"],
        ],
        [],
      ),
    ).toBe(false);
  });

  it("returns false when every row has a distinct identity", () => {
    expect(
      hasAmbiguousIdentity(
        [
          [1, "a"],
          [2, "a"],
        ],
        [0],
      ),
    ).toBe(false);
  });

  it("returns true when two rows share the same identity (all-columns duplicate)", () => {
    expect(
      hasAmbiguousIdentity(
        [
          [1, "a"],
          [1, "a"],
        ],
        [0, 1],
      ),
    ).toBe(true);
  });

  it("treats NULL consistently across duplicate rows", () => {
    expect(
      hasAmbiguousIdentity(
        [
          [null, "a"],
          [null, "a"],
        ],
        [0, 1],
      ),
    ).toBe(true);
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
    expect(rowEditKey(["as", "b"], [0, 1], 0)).not.toBe(rowEditKey(["a", "sb"], [0, 1], 0));
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
    expect(buildUpdateStatements(baseInput({ edits: { [k(1)]: { 1: "new" } } }))).toEqual([
      "UPDATE `db`.`tbl` SET `name` = 'new' WHERE `id` = 1;",
    ]);
  });

  it("emits numeric input for numeric columns unquoted", () => {
    expect(buildUpdateStatements(baseInput({ edits: { [k(1)]: { 0: "5" } } }))).toEqual([
      "UPDATE `db`.`tbl` SET `id` = 5 WHERE `id` = 1;",
    ]);
  });

  it("treats the NULL keyword as SQL NULL", () => {
    expect(buildUpdateStatements(baseInput({ edits: { [k(1)]: { 1: "null" } } }))).toEqual([
      "UPDATE `db`.`tbl` SET `name` = NULL WHERE `id` = 1;",
    ]);
  });

  it("uses the original PK value in WHERE even when the PK is edited", () => {
    expect(buildUpdateStatements(baseInput({ edits: { [k(1)]: { 0: "99" } } }))).toEqual([
      "UPDATE `db`.`tbl` SET `id` = 99 WHERE `id` = 1;",
    ]);
  });

  it("keeps targeting the right row by PK after rows are appended (loadMore)", () => {
    // `loadMore` appends fetched rows. An edit keyed by the PK of the second
    // row (id 2) must still resolve to it, never to a row that arrived in a
    // later page — even if the edited row's array index shifts. (Edits
    // survive pagination because they are PK-keyed.)
    const rowsAfterLoadMore = [
      [1, "old"],
      [2, "foo"],
      [3, "page2-a"],
      [4, "page2-b"],
    ];
    expect(
      buildUpdateStatements(baseInput({ rows: rowsAfterLoadMore, edits: { [k(2)]: { 1: "edited" } } })),
    ).toEqual(["UPDATE `db`.`tbl` SET `name` = 'edited' WHERE `id` = 2;"]);
  });

  it("targets the right row even when the array order changes", () => {
    // Same PK key, but the edited row now sits at a different array index
    // (e.g. a re-sorted/re-surfaced page). PK keying makes this a no-op.
    const reordered = [
      [2, "foo"],
      [1, "old"],
    ];
    expect(buildUpdateStatements(baseInput({ rows: reordered, edits: { [k(1)]: { 1: "x" } } }))).toEqual([
      "UPDATE `db`.`tbl` SET `name` = 'x' WHERE `id` = 1;",
    ]);
  });

  it("emits a re-surfaced row only once", () => {
    // Pagination without a stable ORDER BY can return the same row twice; the
    // edit should produce a single UPDATE, not a duplicate.
    const withDup = [
      [1, "old"],
      [2, "foo"],
      [1, "old-again"],
    ];
    expect(buildUpdateStatements(baseInput({ rows: withDup, edits: { [k(1)]: { 1: "x" } } }))).toEqual([
      "UPDATE `db`.`tbl` SET `name` = 'x' WHERE `id` = 1;",
    ]);
  });

  it("quotes identifiers and qualifies for Postgres", () => {
    expect(buildUpdateStatements(baseInput({ driver: "postgres", edits: { [k(1)]: { 1: "new" } } }))).toEqual(
      ['UPDATE "db"."tbl" SET "name" = \'new\' WHERE "id" = 1;'],
    );
  });

  it("omits the database prefix for SQLite", () => {
    expect(buildUpdateStatements(baseInput({ driver: "sqlite", edits: { [k(1)]: { 1: "new" } } }))).toEqual([
      'UPDATE "tbl" SET "name" = \'new\' WHERE "id" = 1;',
    ]);
  });

  it("doubles single quotes in string literals", () => {
    expect(buildUpdateStatements(baseInput({ edits: { [k(1)]: { 1: "O'Brien" } } }))).toEqual([
      "UPDATE `db`.`tbl` SET `name` = 'O''Brien' WHERE `id` = 1;",
    ]);
  });

  it("escapes backslashes for MySQL but not Postgres", () => {
    expect(buildUpdateStatements(baseInput({ edits: { [k(1)]: { 1: "a\\b" } } }))).toEqual([
      "UPDATE `db`.`tbl` SET `name` = 'a\\\\b' WHERE `id` = 1;",
    ]);
    expect(
      buildUpdateStatements(baseInput({ driver: "postgres", edits: { [k(1)]: { 1: "a\\b" } } })),
    ).toEqual(['UPDATE "db"."tbl" SET "name" = \'a\\b\' WHERE "id" = 1;']);
  });

  it("maps boolean columns to TRUE/FALSE", () => {
    const columns = [col("id", "INT"), col("flag", "BOOLEAN")];
    expect(buildUpdateStatements(baseInput({ columns, edits: { [k(1)]: { 1: "true" } } }))).toEqual([
      "UPDATE `db`.`tbl` SET `flag` = TRUE WHERE `id` = 1;",
    ]);
    expect(buildUpdateStatements(baseInput({ columns, edits: { [k(1)]: { 1: "0" } } }))).toEqual([
      "UPDATE `db`.`tbl` SET `flag` = FALSE WHERE `id` = 1;",
    ]);
  });

  it("emits one statement per edited row in row (top-to-bottom) order", () => {
    expect(buildUpdateStatements(baseInput({ edits: { [k(2)]: { 1: "y" }, [k(1)]: { 1: "x" } } }))).toEqual([
      "UPDATE `db`.`tbl` SET `name` = 'x' WHERE `id` = 1;",
      "UPDATE `db`.`tbl` SET `name` = 'y' WHERE `id` = 2;",
    ]);
  });

  it("uses IS NULL (not = NULL) in the WHERE clause for a NULL identity value (#849 all_columns fallback)", () => {
    // A real PK is practically never NULL, but the all_columns fallback
    // routinely identifies rows by nullable columns — `col = NULL` is always
    // false in SQL, so it must become `col IS NULL`.
    const columns = [col("a", "INT"), col("b", "VARCHAR")];
    const rows: CellValue[][] = [[null, "x"]];
    const key = rowEditKey([null, "x"], [0, 1], 0);
    expect(
      buildUpdateStatements({
        driver: "mysql",
        database: "db",
        table: "tbl",
        columns,
        rows,
        pkIndices: [0, 1],
        edits: { [key]: { 1: "y" } },
      }),
    ).toEqual(["UPDATE `db`.`tbl` SET `b` = 'y' WHERE `a` IS NULL AND `b` = 'x';"]);
  });
});

function baseRowSql(overrides: Partial<BuildRowSqlInput>): BuildRowSqlInput {
  return {
    driver: "mysql",
    database: "db",
    table: "tbl",
    columns: [col("id", "INT"), col("name", "VARCHAR")],
    rows: [[1, "old"]],
    pkIndices: [0],
    ...overrides,
  };
}

describe("単精度 float 列の行識別 WHERE (#1534)", () => {
  it("PG FLOAT4 / MySQL FLOAT は = ではなく相対許容差で比較する", () => {
    const sqls = buildRowSql(
      {
        driver: "postgres",
        database: "public",
        table: "t",
        columns: [col("a", "FLOAT4"), col("b", "TEXT")],
        rows: [[0.1, "x"]],
        pkIndices: [0, 1],
      },
      "delete",
    );
    expect(sqls).toHaveLength(1);
    expect(sqls[0]).toContain('ABS("a" - (0.1)) <= ABS((0.1)) * 0.000001');
    expect(sqls[0]).toContain(`"b" = 'x'`);
    expect(sqls[0]).not.toContain('"a" = 0.1');

    const my = buildRowSql(
      {
        ...baseRowSql({}),
        columns: [col("f", "FLOAT"), col("n", "INT")],
        rows: [[-2.5, 3]],
        pkIndices: [0, 1],
      },
      "delete",
    );
    expect(my[0]).toContain("ABS(`f` - (-2.5)) <= ABS((-2.5)) * 0.000001");
    expect(my[0]).toContain("`n` = 3");
  });

  it("倍精度 (DOUBLE / SQLite REAL) と NULL は従来どおり", () => {
    const dbl = buildRowSql(
      { ...baseRowSql({}), columns: [col("d", "DOUBLE")], rows: [[0.1]], pkIndices: [0] },
      "delete",
    );
    expect(dbl[0]).toContain("`d` = 0.1");
    const lite = buildRowSql(
      { ...baseRowSql({}), driver: "sqlite", columns: [col("r", "REAL")], rows: [[0.1]], pkIndices: [0] },
      "delete",
    );
    expect(lite[0]).toContain('"r" = 0.1');
    const nul = buildRowSql(
      { ...baseRowSql({}), columns: [col("f", "FLOAT")], rows: [[null]], pkIndices: [0] },
      "delete",
    );
    expect(nul[0]).toContain("`f` IS NULL");
  });
});

describe("buildRowSql", () => {
  describe("INSERT", () => {
    it("lists every column with quoted, qualified MySQL syntax", () => {
      expect(buildRowSql(baseRowSql({}), "insert")).toEqual([
        "INSERT INTO `db`.`tbl` (`id`, `name`) VALUES (1, 'old');",
      ]);
    });

    it("does not require a primary key", () => {
      expect(buildRowSql(baseRowSql({ pkIndices: [] }), "insert")).toEqual([
        "INSERT INTO `db`.`tbl` (`id`, `name`) VALUES (1, 'old');",
      ]);
    });

    it("quotes identifiers and qualifies for Postgres", () => {
      expect(buildRowSql(baseRowSql({ driver: "postgres" }), "insert")).toEqual([
        'INSERT INTO "db"."tbl" ("id", "name") VALUES (1, \'old\');',
      ]);
    });

    it("omits the database prefix for SQLite", () => {
      expect(buildRowSql(baseRowSql({ driver: "sqlite" }), "insert")).toEqual([
        'INSERT INTO "tbl" ("id", "name") VALUES (1, \'old\');',
      ]);
    });

    it("renders NULL, booleans and escaped strings", () => {
      const columns = [col("id", "INT"), col("flag", "BOOLEAN"), col("note", "VARCHAR")];
      expect(buildRowSql(baseRowSql({ columns, rows: [[1, true, null]] }), "insert")).toEqual([
        "INSERT INTO `db`.`tbl` (`id`, `flag`, `note`) VALUES (1, TRUE, NULL);",
      ]);
      expect(buildRowSql(baseRowSql({ columns, rows: [[2, false, "O'Brien"]] }), "insert")).toEqual([
        "INSERT INTO `db`.`tbl` (`id`, `flag`, `note`) VALUES (2, FALSE, 'O''Brien');",
      ]);
    });

    it("keeps a precision-preserving numeric string unquoted for numeric columns", () => {
      // BIGINT beyond 2^53 arrives as a string to avoid precision loss; it must
      // still emit as a bare numeral, not a quoted string.
      const columns = [col("id", "BIGINT"), col("amount", "DECIMAL")];
      expect(buildRowSql(baseRowSql({ columns, rows: [["9007199254740993", "12.50"]] }), "insert")).toEqual([
        "INSERT INTO `db`.`tbl` (`id`, `amount`) VALUES (9007199254740993, 12.50);",
      ]);
    });

    it("emits driver-specific BLOB literals", () => {
      const columns = [col("id", "INT"), col("data", "BLOB")];
      const rows: CellValue[][] = [[1, "deadbeef"]];
      expect(buildRowSql(baseRowSql({ columns, rows }), "insert")).toEqual([
        "INSERT INTO `db`.`tbl` (`id`, `data`) VALUES (1, 0xdeadbeef);",
      ]);
      expect(buildRowSql(baseRowSql({ driver: "postgres", columns, rows }), "insert")).toEqual([
        'INSERT INTO "db"."tbl" ("id", "data") VALUES (1, \'\\xdeadbeef\');',
      ]);
      expect(buildRowSql(baseRowSql({ driver: "sqlite", columns, rows }), "insert")).toEqual([
        'INSERT INTO "tbl" ("id", "data") VALUES (1, X\'deadbeef\');',
      ]);
    });

    it("treats PostgreSQL BYTEA as a BLOB-family column (regression: #修正4)", () => {
      const columns = [col("id", "INT"), col("data", "BYTEA")];
      const rows: CellValue[][] = [[1, "deadbeef"]];
      expect(buildRowSql(baseRowSql({ driver: "postgres", columns, rows }), "insert")).toEqual([
        'INSERT INTO "db"."tbl" ("id", "data") VALUES (1, \'\\xdeadbeef\');',
      ]);
    });

    it("emits one statement per row", () => {
      expect(
        buildRowSql(
          baseRowSql({
            rows: [
              [1, "a"],
              [2, "b"],
            ],
          }),
          "insert",
        ),
      ).toEqual([
        "INSERT INTO `db`.`tbl` (`id`, `name`) VALUES (1, 'a');",
        "INSERT INTO `db`.`tbl` (`id`, `name`) VALUES (2, 'b');",
      ]);
    });
  });

  describe("UPDATE", () => {
    it("sets non-PK columns and keys WHERE on the PK", () => {
      expect(buildRowSql(baseRowSql({}), "update")).toEqual([
        "UPDATE `db`.`tbl` SET `name` = 'old' WHERE `id` = 1;",
      ]);
    });

    it("returns [] without a resolvable primary key", () => {
      expect(buildRowSql(baseRowSql({ pkIndices: [] }), "update")).toEqual([]);
    });

    it("returns [] when every column is part of the primary key", () => {
      // A pure join table (both columns are PK) has nothing to SET.
      expect(buildRowSql(baseRowSql({ pkIndices: [0, 1] }), "update")).toEqual([]);
    });

    it("ANDs a composite primary key in the WHERE clause", () => {
      const columns = [col("a", "INT"), col("b", "INT"), col("v", "VARCHAR")];
      expect(buildRowSql(baseRowSql({ columns, rows: [[1, 2, "x"]], pkIndices: [0, 1] }), "update")).toEqual([
        "UPDATE `db`.`tbl` SET `v` = 'x' WHERE `a` = 1 AND `b` = 2;",
      ]);
    });

    it("uses IS NULL in the WHERE clause for a NULL identity value (#849 all_columns fallback)", () => {
      const columns = [col("a", "INT"), col("b", "VARCHAR"), col("v", "VARCHAR")];
      expect(
        buildRowSql(baseRowSql({ columns, rows: [[null, "k", "x"]], pkIndices: [0, 1] }), "update"),
      ).toEqual(["UPDATE `db`.`tbl` SET `v` = 'x' WHERE `a` IS NULL AND `b` = 'k';"]);
    });
  });

  describe("DELETE", () => {
    it("keys WHERE on the PK", () => {
      expect(buildRowSql(baseRowSql({}), "delete")).toEqual(["DELETE FROM `db`.`tbl` WHERE `id` = 1;"]);
    });

    it("returns [] without a resolvable primary key", () => {
      expect(buildRowSql(baseRowSql({ pkIndices: [] }), "delete")).toEqual([]);
    });

    it("ANDs a composite primary key and quotes for Postgres", () => {
      const columns = [col("a", "INT"), col("b", "VARCHAR"), col("v", "VARCHAR")];
      expect(
        buildRowSql(
          baseRowSql({
            driver: "postgres",
            columns,
            rows: [[1, "k", "x"]],
            pkIndices: [0, 1],
          }),
          "delete",
        ),
      ).toEqual(['DELETE FROM "db"."tbl" WHERE "a" = 1 AND "b" = \'k\';']);
    });
  });

  it("returns [] when there are no columns", () => {
    expect(buildRowSql(baseRowSql({ columns: [], rows: [[]], pkIndices: [] }), "insert")).toEqual([]);
  });
});

describe("buildInsertClipboard", () => {
  const columns = [col("id", "INT"), col("flag", "BOOLEAN"), col("note", "VARCHAR")];
  const rows: CellValue[][] = [
    [1, true, null],
    [2, false, "O'Brien"],
  ];

  it("one-statement-per-row mode matches buildRowSql and reports the table resolved", () => {
    const result = buildInsertClipboard(
      { driver: "mysql", database: "db", table: "tbl", columns, rows },
      false,
    );
    expect(result.tableResolved).toBe(true);
    expect(result.sql).toBe(
      [
        "INSERT INTO `db`.`tbl` (`id`, `flag`, `note`) VALUES (1, TRUE, NULL);",
        "INSERT INTO `db`.`tbl` (`id`, `flag`, `note`) VALUES (2, FALSE, 'O''Brien');",
      ].join("\n"),
    );
  });

  it("combined mode emits one statement with one VALUES tuple per row", () => {
    const result = buildInsertClipboard(
      { driver: "mysql", database: "db", table: "tbl", columns, rows },
      true,
    );
    expect(result.tableResolved).toBe(true);
    expect(result.sql).toBe(
      "INSERT INTO `db`.`tbl` (`id`, `flag`, `note`) VALUES (1, TRUE, NULL), (2, FALSE, 'O''Brien');",
    );
  });

  it("falls back to a placeholder table name and reports unresolved when table is blank/missing", () => {
    for (const table of [null, undefined, "", "   "]) {
      const result = buildInsertClipboard(
        { driver: "mysql", database: "db", table, columns, rows: [rows[0]] },
        false,
      );
      expect(result.tableResolved).toBe(false);
      expect(result.sql).toBe(
        `INSERT INTO \`db\`.\`${FALLBACK_INSERT_TABLE}\` (\`id\`, \`flag\`, \`note\`) VALUES (1, TRUE, NULL);`,
      );
    }
  });

  it("renders driver-specific BLOB literals in combined mode", () => {
    const blobCols = [col("id", "INT"), col("data", "BLOB")];
    const blobRows: CellValue[][] = [
      [1, "deadbeef"],
      [2, ""],
    ];
    const result = buildInsertClipboard(
      { driver: "mysql", database: "db", table: "tbl", columns: blobCols, rows: blobRows },
      true,
    );
    expect(result.sql).toBe("INSERT INTO `db`.`tbl` (`id`, `data`) VALUES (1, 0xdeadbeef), (2, '');");
  });

  it("keeps precision-preserving numeric strings unquoted in combined mode", () => {
    const numCols = [col("id", "BIGINT"), col("amount", "DECIMAL")];
    const numRows: CellValue[][] = [["9007199254740993", "12.50"]];
    const result = buildInsertClipboard(
      { driver: "postgres", database: "db", table: "tbl", columns: numCols, rows: numRows },
      true,
    );
    expect(result.sql).toBe('INSERT INTO "db"."tbl" ("id", "amount") VALUES (9007199254740993, 12.50);');
  });

  it("returns an empty string when there are no rows or no columns", () => {
    expect(
      buildInsertClipboard({ driver: "mysql", database: "db", table: "tbl", columns, rows: [] }, true).sql,
    ).toBe("");
    expect(
      buildInsertClipboard({ driver: "mysql", database: "db", table: "tbl", columns: [], rows }, true).sql,
    ).toBe("");
  });

  it("skips missing rows (holes) without throwing", () => {
    const sparse = [rows[0], undefined as unknown as CellValue[], rows[1]];
    const result = buildInsertClipboard(
      { driver: "mysql", database: "db", table: "tbl", columns, rows: sparse },
      true,
    );
    expect(result.sql).toBe(
      "INSERT INTO `db`.`tbl` (`id`, `flag`, `note`) VALUES (1, TRUE, NULL), (2, FALSE, 'O''Brien');",
    );
  });
});

describe("validateCellInput (整数列への小数)", () => {
  it("整数型の列は小数・指数表記を弾く", () => {
    for (const t of ["INT", "BIGINT UNSIGNED", "integer", "int4", "smallint(5)"]) {
      expect(validateCellInput("2.5", t, true)).toBe("editInvalidInteger");
      expect(validateCellInput("1e3", t, true)).toBe("editInvalidInteger");
      expect(validateCellInput("-12", t, true)).toBeNull();
    }
  });

  it("小数型の列は小数を通す", () => {
    expect(validateCellInput("2.5", "DECIMAL(10,2)", true)).toBeNull();
    expect(validateCellInput("2.5", "DOUBLE", true)).toBeNull();
  });
});

describe("validateCellInput", () => {
  it("rejects the NULL keyword on a NOT NULL column", () => {
    expect(validateCellInput("NULL", "VARCHAR", false)).toBe("editInvalidNotNull");
    expect(validateCellInput("null", "VARCHAR", true)).toBeNull();
  });

  // 空欄は文字列系の列では空文字リテラル `''` を意味する (literalFromInput が
  // そう組み立てる) ため、NOT NULL 制約の違反ではない。右クリックの
  // 「空文字をセット」がこの前提に乗っている。
  it("accepts an empty value on a string column even when NOT NULL", () => {
    expect(validateCellInput("", "VARCHAR", false)).toBeNull();
    expect(validateCellInput("", "TEXT", true)).toBeNull();
  });

  it("still rejects an empty value on non-string columns", () => {
    expect(validateCellInput("", "INT", false)).toBe("editInvalidNotNull");
    expect(validateCellInput("", "INT", true)).toBe("editInvalidNumber");
    expect(validateCellInput("", "DATETIME", true)).toBe("editInvalidDateTime");
  });

  it("checks the value shape per column kind", () => {
    expect(validateCellInput("12.5", "DECIMAL(10,2)", true)).toBeNull();
    expect(validateCellInput("12.5", "INT", true)).toBe("editInvalidInteger"); // 整数列への小数は弾く
    expect(validateCellInput("abc", "INT", true)).toBe("editInvalidNumber");
    expect(validateCellInput("2024-03-05", "DATE", true)).toBeNull();
    expect(validateCellInput("2024-03-05 07:08:09", "DATETIME", true)).toBeNull();
    expect(validateCellInput("07:08:09", "TIME", true)).toBeNull();
    expect(validateCellInput("true", "BOOLEAN", true)).toBeNull();
    expect(validateCellInput("yes", "BOOLEAN", true)).toBeNull(); // PostgreSQL が受理する表記
    expect(validateCellInput("maybe", "BOOLEAN", true)).toBe("editInvalidBoolean");
    // 未知の型は決して弾かない (サーバに最終判断を委ねる)。
    expect(validateCellInput("anything", "GEOMETRY", true)).toBeNull();
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

describe("buildInsertStatements", () => {
  const columns = [col("id", "INT"), col("name", "VARCHAR"), col("active", "BOOLEAN")];

  it("builds an INSERT from only the filled columns", () => {
    const stmts = buildInsertStatements({
      driver: "mysql",
      database: "shop",
      table: "users",
      columns,
      inserts: [{ 1: "Alice", 2: "true" }],
    });
    expect(stmts).toEqual(["INSERT INTO `shop`.`users` (`name`, `active`) VALUES ('Alice', TRUE);"]);
  });

  it("coerces null and numbers, and skips empty rows", () => {
    const stmts = buildInsertStatements({
      driver: "postgres",
      database: "public",
      table: "t",
      columns,
      inserts: [{ 0: "5", 1: "null" }, {}],
    });
    expect(stmts).toEqual(['INSERT INTO "public"."t" ("id", "name") VALUES (5, NULL);']);
  });

  // #1526: 空文字の明示値は '' リテラルとして出し、素の "" (既定値) とは区別する。
  it("emits '' for an explicit empty-string value but omits a plain empty cell", () => {
    for (const driver of ["mysql", "postgres", "sqlite"]) {
      const stmts = buildInsertStatements({
        driver,
        database: "d",
        table: "t",
        columns,
        inserts: [{ 0: "1", 1: { empty: true }, 2: "" }],
      });
      expect(stmts).toHaveLength(1);
      expect(stmts[0]).toMatch(/VALUES \(1, ''\);$/);
    }
  });

  // #1357: 空欄は INSERT から省き DB の既定値 / 自動採番に委ねる。
  it("omits empty cells so the database fills them (auto-increment / DEFAULT)", () => {
    const stmts = buildInsertStatements({
      driver: "mysql",
      database: "shop",
      table: "users",
      columns,
      inserts: [{ 0: "", 1: "Alice", 2: "" }],
    });
    expect(stmts).toEqual(["INSERT INTO `shop`.`users` (`name`) VALUES ('Alice');"]);
  });

  it("skips a row whose cells are all empty (nothing to insert)", () => {
    const stmts = buildInsertStatements({
      driver: "mysql",
      database: "shop",
      table: "users",
      columns,
      inserts: [{ 0: "", 1: "" }],
    });
    expect(stmts).toEqual([]);
  });

  // #1357: 関数値は引用されず式としてそのまま VALUES に入る。ユーザが打った "NOW()" は
  // 従来どおり文字列として引用される (式として解釈されない)。
  it("emits function values as bare expressions and still quotes typed text", () => {
    const stmts = buildInsertStatements({
      driver: "mysql",
      database: "shop",
      table: "events",
      columns: [col("id", "INT"), col("at", "DATETIME"), col("note", "VARCHAR")],
      inserts: [{ 1: { fn: "now" }, 2: "NOW()" }, { 1: { fn: "current_timestamp" } }],
    });
    expect(stmts).toEqual([
      "INSERT INTO `shop`.`events` (`at`, `note`) VALUES (NOW(), 'NOW()');",
      "INSERT INTO `shop`.`events` (`at`) VALUES (CURRENT_TIMESTAMP);",
    ]);
  });

  it("treats a function value as filled even though it is not text", () => {
    const stmts = buildInsertStatements({
      driver: "postgres",
      database: "public",
      table: "t",
      columns: [col("id", "UUID")],
      inserts: [{ 0: { fn: "uuid" } }],
    });
    expect(stmts).toEqual(['INSERT INTO "public"."t" ("id") VALUES (gen_random_uuid());']);
  });

  // #1357: 式は値に保存されず、毎回 driver から固定カタログで作られる。
  it("derives the expression from the driver at build time, not from stored text", () => {
    const build = (driver: string) =>
      buildInsertStatements({
        driver,
        database: "db",
        table: "t",
        columns: [col("id", "CHAR(36)")],
        inserts: [{ 0: { fn: "uuid" } }],
      });
    expect(build("mysql")).toEqual(["INSERT INTO `db`.`t` (`id`) VALUES (UUID());"]);
    expect(build("postgres")).toEqual(['INSERT INTO "db"."t" ("id") VALUES (gen_random_uuid());']);
  });

  it("excludes a row whose function the driver does not have, and keeps the others", () => {
    const stmts = buildInsertStatements({
      driver: "sqlite",
      database: "main",
      table: "t",
      columns: [col("id", "INTEGER"), col("at", "TEXT"), col("name", "TEXT")],
      inserts: [{ 1: { fn: "now" }, 2: "a" }, { 2: "b" }, { 0: { fn: "uuid" } }],
    });
    expect(stmts).toEqual(['INSERT INTO "t" ("name") VALUES (\'b\');']);
  });
});

describe("buildDeleteStatements", () => {
  const columns = [col("id", "INT"), col("name", "VARCHAR")];
  const rows: CellValue[][] = [
    [1, "Alice"],
    [2, "Bob"],
    [3, "Carol"],
  ];
  const pkIndices = [0];

  it("emits a DELETE per marked row, keyed by PK identity", () => {
    const keys = new Set([rowEditKey(rows[0], pkIndices, 0), rowEditKey(rows[2], pkIndices, 2)]);
    const stmts = buildDeleteStatements({
      driver: "mysql",
      database: "shop",
      table: "users",
      columns,
      rows,
      pkIndices,
      deleteKeys: keys,
    });
    expect(stmts).toEqual([
      "DELETE FROM `shop`.`users` WHERE `id` = 1;",
      "DELETE FROM `shop`.`users` WHERE `id` = 3;",
    ]);
  });

  it("returns empty without a PK or marks", () => {
    expect(
      buildDeleteStatements({
        driver: "mysql",
        database: "d",
        table: "t",
        columns,
        rows,
        pkIndices: [],
        deleteKeys: new Set(["x"]),
      }),
    ).toEqual([]);
    expect(
      buildDeleteStatements({
        driver: "mysql",
        database: "d",
        table: "t",
        columns,
        rows,
        pkIndices,
        deleteKeys: new Set(),
      }),
    ).toEqual([]);
  });

  it("uses IS NULL in the WHERE clause for a NULL identity value (#849 all_columns fallback)", () => {
    const allColsRows: CellValue[][] = [[null, "Alice"]];
    const key = rowEditKey(allColsRows[0], [0, 1], 0);
    expect(
      buildDeleteStatements({
        driver: "mysql",
        database: "shop",
        table: "users",
        columns,
        rows: allColsRows,
        pkIndices: [0, 1],
        deleteKeys: new Set([key]),
      }),
    ).toEqual(["DELETE FROM `shop`.`users` WHERE `id` IS NULL AND `name` = 'Alice';"]);
  });
});

describe("cellValueFromInput", () => {
  it("maps the NULL keyword to null (case-insensitive, trimmed)", () => {
    expect(cellValueFromInput("null", col("c", "VARCHAR"))).toBe(null);
    expect(cellValueFromInput("  NULL  ", col("c", "INT"))).toBe(null);
  });

  it("coerces numeric columns to numbers", () => {
    expect(cellValueFromInput("42", col("qty", "INT"))).toBe(42);
    expect(cellValueFromInput(" -3.5 ", col("p", "DECIMAL"))).toBe(-3.5);
  });

  it("keeps oversized integers as a string to preserve precision", () => {
    const big = "99999999999999999999";
    expect(cellValueFromInput(big, col("id", "BIGINT"))).toBe(big);
  });

  it("coerces boolean columns to true/false", () => {
    expect(cellValueFromInput("true", col("ok", "BOOLEAN"))).toBe(true);
    expect(cellValueFromInput("1", col("ok", "BOOL"))).toBe(true);
    expect(cellValueFromInput("false", col("ok", "BOOLEAN"))).toBe(false);
    expect(cellValueFromInput("0", col("ok", "BOOL"))).toBe(false);
  });

  it("passes string-like input through unchanged (untrimmed)", () => {
    expect(cellValueFromInput("  hello  ", col("name", "VARCHAR"))).toBe("  hello  ");
    // A non-numeric value in a numeric column is left as a string (server decides).
    expect(cellValueFromInput("abc", col("qty", "INT"))).toBe("abc");
  });
});

describe("applyEditsToRows", () => {
  const columns = [col("id", "INT"), col("name", "VARCHAR"), col("qty", "INT")];
  const pkIndices = [0];
  const rows: CellValue[][] = [
    [1, "apple", 5],
    [2, "banana", 3],
    [3, "cherry", 7],
  ];

  it("applies an edit to the matching row by PK identity, leaving others untouched", () => {
    const edits: PendingEdits = { [k(2)]: { 2: "42" } };
    const out = applyEditsToRows({ columns, rows, pkIndices, edits });
    expect(out).toEqual([
      [1, "apple", 5],
      [2, "banana", 42],
      [3, "cherry", 7],
    ]);
    // Untouched rows keep their identity (no needless re-render churn).
    expect(out[0]).toBe(rows[0]);
    expect(out[1]).not.toBe(rows[1]);
  });

  it("drops rows flagged for deletion", () => {
    const out = applyEditsToRows({
      columns,
      rows,
      pkIndices,
      edits: {},
      deleteKeys: new Set([k(1), k(3)]),
    });
    expect(out).toEqual([[2, "banana", 3]]);
  });

  it("applies edits and deletes together, matched by PK regardless of position", () => {
    const edits: PendingEdits = { [k(3)]: { 1: "CHERRY" } };
    const out = applyEditsToRows({
      columns,
      rows,
      pkIndices,
      edits,
      deleteKeys: new Set([k(1)]),
    });
    expect(out).toEqual([
      [2, "banana", 3],
      [3, "CHERRY", 7],
    ]);
  });
});

/**
 * 構造化された Apply 入力 (#1259)。`literalFromInput` と同じ分類規則で値を分類し、同じ
 * (列, 値) の行を 1 グループにまとめる。リテラル化と SQL 組み立ては Rust 側。
 */
describe("setValueFromInput (#1259)", () => {
  it("literalFromInput と同じ規則で値を分類する", () => {
    expect(setValueFromInput(" null ", col("a", "TEXT"))).toEqual({ kind: "null" });
    expect(setValueFromInput(" 12.5 ", col("a", "INT"))).toEqual({ kind: "number", text: "12.5" });
    // 数値列でも数値らしくない入力は文字列のまま (サーバ側の型強制に任せる)。
    expect(setValueFromInput("abc", col("a", "INT"))).toEqual({ kind: "text", text: "abc" });
    expect(setValueFromInput("TRUE", col("a", "BOOLEAN"))).toEqual({ kind: "bool", value: true });
    expect(setValueFromInput("0", col("a", "BOOL"))).toEqual({ kind: "bool", value: false });
    expect(setValueFromInput("true", col("a", "BIT"))).toEqual({ kind: "number", text: "1" });
    // 文字列は trim しない (引用リテラルと同じ)。
    expect(setValueFromInput(" x ", col("a", "TEXT"))).toEqual({ kind: "text", text: " x " });
  });
});

describe("buildUpdateGroups (#1259)", () => {
  const columns = [col("id", "INT"), col("name", "VARCHAR"), col("n", "INT")];
  const rows: CellValue[][] = [
    [1, "a", 10],
    [2, "b", 20],
    [3, "c", 30],
    ["9007199254740993", "d", 40],
  ];
  const input = (edits: PendingEdits, over: Partial<BuildUpdateInput> = {}): BuildUpdateInput => ({
    driver: "mysql",
    database: "db",
    table: "tbl",
    columns,
    rows,
    pkIndices: [0],
    edits,
    ...over,
  });
  const key = (id: CellValue) => rowEditKey([id, "", 0], [0], 0);

  it("PK が無ければ空", () => {
    expect(buildUpdateGroups(input({ [key(1)]: { 1: "x" } }, { pkIndices: [] }))).toEqual({
      groups: [],
      rowCount: 0,
    });
  });

  it("同じ (列, 値) の行を 1 グループにまとめ、最初に現れた順に並べる", () => {
    const { groups, rowCount } = buildUpdateGroups(
      input({
        [key(1)]: { 1: "same" },
        [key(2)]: { 1: "other" },
        [key(3)]: { 1: "same" },
      }),
    );
    expect(rowCount).toBe(3);
    expect(groups).toEqual([
      { set: [{ column: "name", value: { kind: "text", text: "same" } }], keys: [[1], [3]] },
      { set: [{ column: "name", value: { kind: "text", text: "other" } }], keys: [[2]] },
    ]);
  });

  it("複数列の編集は列の組が同じ行だけまとまる。WHERE には元の PK 値を使う", () => {
    const { groups } = buildUpdateGroups(
      input({
        [key(1)]: { 0: "99", 2: "5" },
        [key(2)]: { 0: "98", 2: "5" },
        [key(3)]: { 2: "5" },
      }),
    );
    expect(groups).toHaveLength(3);
    // 主キー自体を編集しても、キーは元の値 (1)。
    expect(groups[0].keys).toEqual([[1]]);
    expect(groups[2]).toEqual({
      set: [{ column: "n", value: { kind: "number", text: "5" } }],
      keys: [[3]],
    });
  });

  it("64bit の主キーは文字列のまま (丸めない) 渡す", () => {
    const big = "9007199254740993";
    const { groups } = buildUpdateGroups(input({ [key(big)]: { 1: "x" } }));
    expect(groups[0].keys).toEqual([[big]]);
  });

  it("再登場した行は 1 回だけ出す", () => {
    const { groups, rowCount } = buildUpdateGroups(
      input({ [key(1)]: { 1: "x" } }, { rows: [...rows, [1, "a", 10]] }),
    );
    expect(rowCount).toBe(1);
    expect(groups[0].keys).toEqual([[1]]);
  });

  it("複合 PK は全 PK 列の元の値を順に渡す", () => {
    const composite = [
      [1, "a", 10],
      [1, "b", 20],
    ];
    const k = (r: CellValue[]) => rowEditKey(r, [0, 1], 0);
    const { groups } = buildUpdateGroups(
      input(
        { [k(composite[0])]: { 2: "7" }, [k(composite[1])]: { 2: "7" } },
        { rows: composite, pkIndices: [0, 1] },
      ),
    );
    expect(groups).toEqual([
      {
        set: [{ column: "n", value: { kind: "number", text: "7" } }],
        keys: [
          [1, "a"],
          [1, "b"],
        ],
      },
    ]);
  });
});

// Stryker (#1358) の生存変異を潰す、リテラル生成・行識別の境界ケース。
describe("数値判定の境界 (インジェクション隣接のリテラル生成)", () => {
  const intCol = col("n", "INT");
  const malformed = ["1x", "x1", "1 OR 1=1", "1e", "1.", "1; DROP TABLE t", "--1", "1 2"];

  it("literalFromInput: 数値列でも数値形式でなければ引用符付きになる", () => {
    for (const raw of malformed) {
      expect(literalFromInput("mysql", raw, intCol)).toBe(`'${raw}'`);
    }
  });

  it("literalFromInput: 数値形式は trim 済みでそのまま、非数値列は引用符付き", () => {
    expect(literalFromInput("mysql", " -12.5e+3 ", intCol)).toBe("-12.5e+3");
    expect(literalFromInput("mysql", "123", col("s", "VARCHAR"))).toBe("'123'");
  });

  it("cellValueFromInput / setValueFromInput も同じ判定で数値扱いしない", () => {
    for (const raw of malformed) {
      expect(cellValueFromInput(raw, intCol)).toBe(raw);
      expect(setValueFromInput(raw, intCol)).toEqual({ kind: "text", text: raw });
    }
    expect(setValueFromInput("12", intCol)).toEqual({ kind: "number", text: "12" });
    expect(setValueFromInput("12", col("s", "VARCHAR"))).toEqual({ kind: "text", text: "12" });
  });

  it("NULL キーワードは前後に文字があると NULL にならない", () => {
    expect(literalFromInput("mysql", "nullx", intCol)).toBe("'nullx'");
    expect(literalFromInput("mysql", "xnull", intCol)).toBe("'xnull'");
    expect(literalFromInput("mysql", " NULL ", intCol)).toBe("NULL");
    expect(cellValueFromInput("nullx", intCol)).toBe("nullx");
    expect(cellValueFromInput("xnull", intCol)).toBe("xnull");
    expect(setValueFromInput("nullx", intCol)).toEqual({ kind: "text", text: "nullx" });
    expect(setValueFromInput("xnull", intCol)).toEqual({ kind: "text", text: "xnull" });
    expect(setValueFromInput("NULL", intCol)).toEqual({ kind: "null" });
  });

  describe("rowValueLiteral (buildRowSql 経由)", () => {
    const columns = [col("id", "INT"), col("code", "VARCHAR"), col("n", "INT")];
    const base = { driver: "mysql", database: "d", table: "t", columns, pkIndices: [0] };

    it("VARCHAR の先頭ゼロ付き文字列は引用符付きのまま", () => {
      const [sql] = buildRowSql({ ...base, rows: [[1, "00123", 5]] }, "insert");
      expect(sql).toContain("(1, '00123', 5)");
      const [upd] = buildRowSql({ ...base, rows: [[1, "00123", 5]] }, "update");
      expect(upd).toContain("`code` = '00123'");
    });

    it("数値列に入った非数値の文字列は引用符付きになる", () => {
      for (const v of malformed) {
        const [sql] = buildRowSql({ ...base, rows: [[1, "a", v]] }, "insert");
        expect(sql).toContain(`'${v}')`);
      }
      const [ok] = buildRowSql({ ...base, rows: [[1, "a", " 42 "]] }, "insert");
      expect(ok).toContain("'a', 42)");
    });

    it("BLOB 宣言の列に 16 進でない値が届いたら (SQLite 非 STRICT)、エスケープ済みの文字列 / 数値に戻る", () => {
      const cols = [col("k", "BLOB")];
      const b = { driver: "sqlite", database: "d", table: "t", columns: cols, pkIndices: [0] };
      const [ins] = buildRowSql({ ...b, rows: [["a' OR 1=1 --"]] }, "insert");
      expect(ins).toContain("'a'' OR 1=1 --'");
      expect(ins).not.toContain("X'");
      const [five] = buildRowSql({ ...b, rows: [[5]] }, "insert");
      expect(five).toContain("(5)");
      const [del] = buildDeleteStatements({
        ...b,
        rows: [["a'b"]],
        deleteKeys: new Set([rowEditKey(["a'b"], [0], 0)]),
      });
      expect(del).toContain("\"k\" = 'a''b'");
      const [hex] = buildRowSql({ ...b, rows: [["deadbeef"]] }, "insert");
      expect(hex).toContain("X'deadbeef'");
    });

    it("buildDeleteStatements: 文字列 PK の先頭ゼロを保つ", () => {
      const cols = [col("code", "VARCHAR")];
      const rows: CellValue[][] = [["00123"]];
      const deleteKeys = new Set([rowEditKey(rows[0], [0], 0)]);
      expect(
        buildDeleteStatements({
          driver: "mysql",
          database: "d",
          table: "t",
          columns: cols,
          rows,
          pkIndices: [0],
          deleteKeys,
        }),
      ).toEqual(["DELETE FROM `d`.`t` WHERE `code` = '00123';"]);
    });
  });
});

describe("rowEditKey / 行識別の衝突回避", () => {
  const key = (v: CellValue) => rowEditKey([v], [0], 0);

  it("型タグで値域が分かれる", () => {
    const keys = [
      key(1),
      key("1"),
      key(null),
      key(""),
      key(true),
      key("true"),
      key(false),
      key("false"),
      key(0),
      key("0"),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(key(undefined as unknown as CellValue)).toBe(key(null));
  });

  it("精度を超える文字列 BIGINT と丸められた number は衝突しない", () => {
    expect(key("9007199254740993")).not.toBe(key(9007199254740992));
  });

  it("PK 無しの行は添字ベースのキーになる", () => {
    expect(rowEditKey([1], [], 3)).toBe("i3");
    expect(rowEditKey([1], [], 3)).not.toBe(rowEditKey([1], [], 4));
  });

  it("複合キーは連結しても曖昧にならない", () => {
    expect(rowEditKey(["a", "bc"], [0, 1], 0)).not.toBe(rowEditKey(["ab", "c"], [0, 1], 0));
  });

  it("buildDeleteStatements: PK が無ければ deleteKeys があっても何も出さない", () => {
    expect(
      buildDeleteStatements({
        driver: "mysql",
        database: "d",
        table: "t",
        columns: [col("a", "INT")],
        rows: [[1]],
        pkIndices: [],
        deleteKeys: new Set(["i0"]),
      }),
    ).toEqual([]);
  });
});

describe("literalFromCellValue", () => {
  it("boolean / 非有限数 / null / undefined / 文字列", () => {
    expect(literalFromCellValue("mysql", true)).toBe("TRUE");
    expect(literalFromCellValue("mysql", false)).toBe("FALSE");
    expect(literalFromCellValue("mysql", NaN)).toBe("NULL");
    expect(literalFromCellValue("mysql", Infinity)).toBe("NULL");
    expect(literalFromCellValue("mysql", -Infinity)).toBe("NULL");
    expect(literalFromCellValue("mysql", 1.5)).toBe("1.5");
    expect(literalFromCellValue("mysql", null)).toBe("NULL");
    expect(literalFromCellValue("mysql", undefined as unknown as CellValue)).toBe("NULL");
    expect(literalFromCellValue("mysql", "a'b")).toBe("'a''b'");
  });
});

describe("BIT 列の入力", () => {
  const bit = col("b", "BIT");
  it("literalFromInput", () => {
    expect(literalFromInput("mysql", "true", bit)).toBe("1");
    expect(literalFromInput("mysql", "TRUE", bit)).toBe("1");
    expect(literalFromInput("mysql", "1", bit)).toBe("1");
    expect(literalFromInput("mysql", " false ", bit)).toBe("0");
    expect(literalFromInput("mysql", "0", bit)).toBe("0");
    expect(literalFromInput("mysql", "2", bit)).toBe("'2'");
    expect(literalFromInput("mysql", "yes", bit)).toBe("'yes'");
  });
  it("setValueFromInput", () => {
    expect(setValueFromInput("true", bit)).toEqual({ kind: "number", text: "1" });
    expect(setValueFromInput("TRUE", bit)).toEqual({ kind: "number", text: "1" });
    expect(setValueFromInput("1", bit)).toEqual({ kind: "number", text: "1" });
    expect(setValueFromInput("false", bit)).toEqual({ kind: "number", text: "0" });
    expect(setValueFromInput("0", bit)).toEqual({ kind: "number", text: "0" });
    expect(setValueFromInput("2", bit)).toEqual({ kind: "text", text: "2" });
  });
  it("BOOLEAN 列の true/false/0/1 と他の値", () => {
    const b = col("f", "BOOLEAN");
    expect(literalFromInput("postgres", "True", b)).toBe("TRUE");
    expect(literalFromInput("postgres", "0", b)).toBe("FALSE");
    expect(literalFromInput("postgres", "2", b)).toBe("'2'");
  });
});

// Stryker (#1358) 2 周目: 数値正規表現の各部品 (小数部・指数部) と BOOLEAN / BIT 分岐を、
// 入力 → リテラル / CellValue / BulkSetValue の 3 関数と rowValueLiteral で網羅する。
describe("数値形式の受理 (小数部・指数部の部品ごと)", () => {
  const intCol = col("n", "INT");
  const valid = ["0", "-7", "12.25", "-0.50", "1e5", "1E5", "1e+05", "1e-12", "3.14e+10", "100"];
  const invalid = ["1.e5", "1e+", "1e-", "1e*5", "1ee5", "1e5.5", "+5", ".5", "1..2", "1.2.3", "e5"];

  it("literalFromInput / setValueFromInput / cellValueFromInput", () => {
    for (const v of valid) {
      expect(literalFromInput("mysql", v, intCol)).toBe(v);
      expect(setValueFromInput(v, intCol)).toEqual({ kind: "number", text: v });
      expect(cellValueFromInput(v, intCol)).toBe(
        Number.isSafeInteger(Number(v)) || !Number.isInteger(Number(v)) ? Number(v) : v,
      );
    }
    for (const v of invalid) {
      expect(literalFromInput("mysql", v, intCol)).toBe(`'${v}'`);
      expect(setValueFromInput(v, intCol)).toEqual({ kind: "text", text: v });
      expect(cellValueFromInput(v, intCol)).toBe(v);
    }
  });

  it("rowValueLiteral (buildRowSql 経由) も同じ判定", () => {
    const columns = [col("id", "INT"), col("n", "DECIMAL")];
    const base = { driver: "mysql", database: "d", table: "t", columns, pkIndices: [0] };
    for (const v of valid) {
      const [sql] = buildRowSql({ ...base, rows: [[1, v]] }, "insert");
      expect(sql).toContain(`(1, ${v})`);
    }
    for (const v of invalid) {
      const [sql] = buildRowSql({ ...base, rows: [[1, v]] }, "insert");
      expect(sql).toContain(`(1, '${v}')`);
    }
  });
});

describe("BOOLEAN / BIT 列の true・false・0・1 とそれ以外", () => {
  const bool = col("f", "BOOLEAN");
  const bit = col("b", "BIT");

  it("cellValueFromInput", () => {
    expect(cellValueFromInput("true", bool)).toBe(true);
    expect(cellValueFromInput(" TRUE ", bool)).toBe(true);
    expect(cellValueFromInput("1", bool)).toBe(true);
    expect(cellValueFromInput("false", bool)).toBe(false);
    expect(cellValueFromInput("0", bool)).toBe(false);
    expect(cellValueFromInput("2", bool)).toBe("2");
    expect(cellValueFromInput("maybe", bool)).toBe("maybe");
    expect(cellValueFromInput("true", col("s", "VARCHAR"))).toBe("true");
    expect(cellValueFromInput("true", bit)).toBe("true");
  });

  it("setValueFromInput (BOOLEAN)", () => {
    expect(setValueFromInput("true", bool)).toEqual({ kind: "bool", value: true });
    expect(setValueFromInput("TRUE", bool)).toEqual({ kind: "bool", value: true });
    expect(setValueFromInput("1", bool)).toEqual({ kind: "bool", value: true });
    expect(setValueFromInput("false", bool)).toEqual({ kind: "bool", value: false });
    expect(setValueFromInput("FALSE", bool)).toEqual({ kind: "bool", value: false });
    expect(setValueFromInput("0", bool)).toEqual({ kind: "bool", value: false });
    expect(setValueFromInput("2", bool)).toEqual({ kind: "text", text: "2" });
    expect(setValueFromInput("x", col("b", "BOOL"))).toEqual({ kind: "text", text: "x" });
    expect(setValueFromInput("true", col("s", "VARCHAR"))).toEqual({ kind: "text", text: "true" });
  });

  it("literalFromInput (BOOLEAN / BIT) の大文字小文字・前後空白・非 BIT 列", () => {
    expect(literalFromInput("postgres", " FALSE ", bool)).toBe("FALSE");
    expect(literalFromInput("postgres", "1", col("f", "BOOL"))).toBe("TRUE");
    expect(literalFromInput("mysql", "FALSE", bit)).toBe("0");
    expect(literalFromInput("mysql", " TRUE ", bit)).toBe("1");
    expect(literalFromInput("mysql", "true", col("s", "VARCHAR"))).toBe("'true'");
    expect(setValueFromInput("FALSE", bit)).toEqual({ kind: "number", text: "0" });
  });

  it("NULL キーワード (大文字小文字・前後空白)", () => {
    expect(cellValueFromInput(" Null ", col("s", "VARCHAR"))).toBeNull();
    expect(setValueFromInput(" nULL ", col("s", "VARCHAR"))).toEqual({ kind: "null" });
  });
});

describe("all_columns 同定の WHERE で BLOB 列を扱う", () => {
  const columns = [col("id", "INT"), col("name", "VARCHAR"), col("data", "BLOB")];
  const rows: CellValue[][] = [[1, "a", "deadbeef"]];
  const pkIndices = [0, 1, 2];

  it.each([
    ["mysql", "`data` = 0xdeadbeef"],
    ["sqlite", "\"data\" = X'deadbeef'"],
    ["postgres", "\"data\" = '\\xdeadbeef'"],
  ])("%s: UPDATE の WHERE が 16 進文字列ではなくバイナリリテラルになる", (driver, expected) => {
    const stmts = buildUpdateStatements({
      driver,
      database: "d",
      table: "t",
      columns,
      rows,
      pkIndices,
      edits: { [rowEditKey(rows[0], pkIndices, 0)]: { 1: "b" } },
    });
    expect(stmts[0]).toContain(expected);
    expect(stmts[0]).not.toContain("= 'deadbeef'");
  });

  it("DELETE の WHERE もバイナリリテラルになる", () => {
    const stmts = buildDeleteStatements({
      driver: "mysql",
      database: "d",
      table: "t",
      columns,
      rows,
      pkIndices,
      deleteKeys: new Set([rowEditKey(rows[0], pkIndices, 0)]),
    });
    expect(stmts[0]).toContain("`data` = 0xdeadbeef");
  });
});

describe("validateCellInput: タイムゾーン付き日時と PostgreSQL の boolean 表記", () => {
  it.each([
    "2024-01-01 10:00:00+09",
    "2024-01-01 10:00:00+09:00",
    "2024-01-01T10:00:00Z",
    "2024-01-01 10:00:00.123 -0500",
  ])("timestamptz の %s を受理する", (v) => {
    expect(validateCellInput(v, "TIMESTAMPTZ", true)).toBeNull();
  });

  it("不正な日時は引き続き弾く", () => {
    expect(validateCellInput("2024-01-01 10:00:00+", "TIMESTAMP", true)).toBe("editInvalidDateTime");
    expect(validateCellInput("yesterday", "TIMESTAMP", true)).toBe("editInvalidDateTime");
  });

  it.each(["yes", "no", "on", "off", "t", "f", "Y", "N"])("boolean の %s を受理する", (v) => {
    expect(validateCellInput(v, "BOOLEAN", true)).toBeNull();
  });

  it("boolean の不正値は弾く", () => {
    expect(validateCellInput("maybe", "BOOLEAN", true)).toBe("editInvalidBoolean");
  });
});

describe("boolean 入力の正規化 (parseBooleanInput)", () => {
  const bool = col("f", "BOOLEAN");

  it.each([
    ["yes", true],
    ["Y", true],
    ["on", true],
    ["t", true],
    ["no", false],
    ["N", false],
    ["off", false],
    ["f", false],
  ])("%s は %s に正規化され、書き込み側が全部 bool になる", (raw, v) => {
    expect(parseBooleanInput(raw)).toBe(v);
    expect(setValueFromInput(raw, bool)).toEqual({ kind: "bool", value: v });
    expect(cellValueFromInput(raw, bool)).toBe(v);
    expect(literalFromInput("mysql", raw, bool)).toBe(v ? "TRUE" : "FALSE");
  });

  it("受理しない表記は null で、文字列のまま扱われる", () => {
    expect(parseBooleanInput("maybe")).toBeNull();
    expect(setValueFromInput("maybe", bool)).toEqual({ kind: "text", text: "maybe" });
  });
});

describe("previewSavedValue (#1628)", () => {
  const c = (type_name: string) => col("c", type_name);
  it("NULL と打つと NULL 化の注記", () => {
    expect(previewSavedValue(" null ", c("VARCHAR(10)"))).toEqual({ kind: "null" });
  });
  it("文字列列の空欄は空文字、数値列の空欄は注記なし", () => {
    expect(previewSavedValue("", c("VARCHAR(10)"))).toEqual({ kind: "empty" });
    expect(previewSavedValue("", c("INT"))).toBeNull();
  });
  it("真偽値の別表記は TRUE/FALSE へ正規化される", () => {
    expect(previewSavedValue("yes", c("BOOLEAN"))).toEqual({ kind: "normalized", value: "TRUE", raw: "yes" });
    expect(previewSavedValue("false", c("BOOL"))).toEqual({
      kind: "normalized",
      value: "FALSE",
      raw: "false",
    });
    expect(previewSavedValue("TRUE", c("BOOLEAN"))).toBeNull();
  });
  it("数値は桁揃いの 007 などが正規化される", () => {
    expect(previewSavedValue("007", c("INT"))).toEqual({ kind: "normalized", value: "7", raw: "007" });
    expect(previewSavedValue("7", c("INT"))).toBeNull();
  });
  it("DECIMAL/NUMERIC の 1.50 などは JS 数値への正規化注記を出さない", () => {
    expect(previewSavedValue("1.50", c("DECIMAL(10,2)"))).toBeNull();
    expect(previewSavedValue("1.50", c("numeric"))).toBeNull();
    expect(previewSavedValue("1.50", c("DOUBLE"))).toEqual({ kind: "normalized", value: "1.5", raw: "1.50" });
  });
  it("文字列の前後空白は注記、通常の文字列は注記なし", () => {
    expect(previewSavedValue(" a", c("TEXT"))).toEqual({ kind: "edgeSpace" });
    expect(previewSavedValue("abc", c("TEXT"))).toBeNull();
  });
});

// --- #1663: Stryker 生存変異の補強 -------------------------------------------------

describe("型名の分類 (#1663)", () => {
  it("BLOB / BINARY 系の型名はすべてバイナリで編集不可", () => {
    for (const t of ["BLOB", "TINYBLOB", "MEDIUMBLOB", "LONGBLOB", "BINARY", "VARBINARY", "BYTEA", "bytea"]) {
      expect(isBinaryColumnType(t), t).toBe(true);
      expect(isEditableColumnType(t), t).toBe(false);
    }
    expect(isBinaryColumnType("TEXT")).toBe(false);
  });

  it("整数型の各綴りを整数列と判定する (修飾・空白・小文字を無視)", () => {
    for (const t of [
      "TINYINT",
      "SMALLINT",
      "MEDIUMINT",
      "INT",
      "INTEGER",
      "BIGINT",
      "YEAR",
      "SERIAL",
      "BIGSERIAL",
      "SMALLSERIAL",
      "INT2",
      "INT4",
      "INT8",
      "bigint unsigned",
      "INT UNSIGNED ZEROFILL",
      "INT(11)",
      "INT (11)",
      "  int  ",
    ]) {
      expect(isIntegerColumnType(t), t).toBe(true);
    }
    for (const t of ["DECIMAL", "FLOAT", "POINT", "VARCHAR(10)", "INTERVAL"]) {
      expect(isIntegerColumnType(t), t).toBe(false);
    }
  });

  it("classifyEditType: 修飾・空白の除去と、INT で終わるだけの型名は数値にしない", () => {
    expect(classifyEditType("INT (11)")).toBe("number");
    expect(classifyEditType("  int  ")).toBe("number");
    expect(classifyEditType("INT ZEROFILL")).toBe("number");
    expect(classifyEditType("FLOAT UNSIGNED")).toBe("number");
    expect(classifyEditType("SMALLINT UNSIGNED ZEROFILL")).toBe("number");
    for (const t of ["SERIAL", "BIGSERIAL", "SMALLSERIAL", "FLOAT4", "FLOAT8", "INT2", "INT4", "INT8"]) {
      expect(classifyEditType(t), t).toBe("number");
    }
    // 末尾が INT / SERIAL なだけの型は数値ではない (前方一致のアンカー)。
    for (const t of ["POINT", "MULTIPOINT", "XSERIAL", "TINYINTX"]) {
      expect(classifyEditType(t), t).toBe("other");
    }
    expect(classifyEditType("date")).toBe("date");
    expect(classifyEditType(" time ")).toBe("time");
    expect(classifyEditType("timestamp with time zone")).toBe("datetime");
    expect(classifyEditType("bool")).toBe("boolean");
  });
});

describe("validateCellInput の正規表現の境界 (#1663)", () => {
  const v = validateCellInput;

  it("数値: 小数・指数の書式と、前後に余計な文字がある入力", () => {
    for (const ok of ["1.25", "-3", "1e10", "1E10", "1e+5", "1e-5", "12.5e+10", " 7 "]) {
      expect(v(ok, "DECIMAL", true), ok).toBeNull();
    }
    for (const bad of ["x1", "1x", "1.", ".5", "1e", "1e+", "1.2.3", "abc"]) {
      expect(v(bad, "DECIMAL", true), bad).toBe("editInvalidNumber");
    }
    // 整数列は小数を別のエラーにする。
    expect(v("1.5", "INT", true)).toBe("editInvalidInteger");
    expect(v("x1", "INT", true)).toBe("editInvalidNumber");
    expect(v("5x", "INT", true)).toBe("editInvalidNumber");
  });

  it("日付: 前後に余計な文字がある入力は不正", () => {
    expect(v("2020-01-01", "DATE", true)).toBeNull();
    expect(v("2020-1-1", "DATE", true)).toBeNull();
    expect(v("x2020-01-01", "DATE", true)).toBe("editInvalidDate");
    expect(v("2020-01-01x", "DATE", true)).toBe("editInvalidDate");
  });

  it("日時: 秒は省略可、前後に余計な文字がある入力は不正", () => {
    expect(v("2020-01-01 10:00", "DATETIME", true)).toBeNull();
    expect(v("2020-01-01T10:00:30.5", "DATETIME", true)).toBeNull();
    expect(v("2020-01-01 10:00:30", "TIMESTAMP", true)).toBeNull();
    expect(v("x2020-01-01 10:00", "DATETIME", true)).toBe("editInvalidDateTime");
    expect(v("2020-01-01 10:00x", "DATETIME", true)).toBe("editInvalidDateTime");
  });

  it("時刻: 秒・小数秒は省略可、前後に余計な文字がある入力は不正", () => {
    for (const ok of ["10:00", "10:00:30", "10:00:30.25", "-838:59:59", "10:00:30.5"]) {
      expect(v(ok, "TIME", true), ok).toBeNull();
    }
    for (const bad of ["x10:00", "10:00x", "10:0", "10:00:3", "10:00:30.", "10:00:30.x"]) {
      expect(v(bad, "TIME", true), bad).toBe("editInvalidTime");
    }
  });

  it("boolean の可否、NULL キーワードのアンカー、空欄の扱い", () => {
    expect(v("yes", "BOOLEAN", true)).toBeNull();
    expect(v("maybe", "BOOLEAN", true)).toBe("editInvalidBoolean");
    // NULL は完全一致のみ。語の一部に null を含むだけでは NULL 扱いにしない。
    expect(v("NULL", "INT", false)).toBe("editInvalidNotNull");
    expect(v(" null ", "INT", true)).toBeNull();
    expect(v("xnull", "INT", false)).toBe("editInvalidNumber");
    expect(v("nullx", "INT", false)).toBe("editInvalidNumber");
    // 前後の空白は無視して検証する。
    expect(v("  5  ", "INT", false)).toBeNull();
    // NULL 許容の空欄は型ごとのエラー、NOT NULL なら NOT NULL エラー、文字列系は常に可。
    expect(v("", "INT", true)).toBe("editInvalidNumber");
    expect(v("", "DATE", true)).toBe("editInvalidDate");
    expect(v("", "DATETIME", true)).toBe("editInvalidDateTime");
    expect(v("", "TIME", true)).toBe("editInvalidTime");
    expect(v("", "BOOLEAN", true)).toBe("editInvalidBoolean");
    expect(v("", "DATE", false)).toBe("editInvalidNotNull");
    expect(v("", "VARCHAR(10)", false)).toBeNull();
  });

  it("parseBooleanInput は前後の空白と大文字小文字を無視する", () => {
    expect(parseBooleanInput("  TRUE ")).toBe(true);
    expect(parseBooleanInput("\tOff\n")).toBe(false);
    expect(parseBooleanInput(" maybe ")).toBeNull();
  });
});

describe("行同定 (resolveRowIdentity / rowEditKey / hasAmbiguousIdentity) の境界 (#1663)", () => {
  const cols = [col("a", "INT"), col("b", "INT")];

  it("rowid / ctid: 隠し列名が無い・空のときは none、先頭列 (index 0) でも解決する", () => {
    expect(resolveRowIdentity(cols, null, { strategy: "rowid", hidden_column: null })).toEqual({
      indices: [],
      strategy: "none",
    });
    // 空文字の列名が結果にあっても、隠し列名が空なら一致させない。
    expect(resolveRowIdentity([col("", "INT")], null, { strategy: "rowid", hidden_column: "" })).toEqual({
      indices: [],
      strategy: "none",
    });
    expect(
      resolveRowIdentity([col("ctid", "TID"), col("a", "INT")], null, {
        strategy: "ctid",
        hidden_column: "ctid",
      }),
    ).toEqual({
      indices: [0],
      strategy: "ctid",
    });
    expect(resolveRowIdentity(cols, null, { strategy: "rowid", hidden_column: "zzz" })).toEqual({
      indices: [],
      strategy: "none",
    });
  });

  it("rowEditKey: 値の型ごとのタグと長さ接頭辞で衝突しない", () => {
    expect(rowEditKey([null], [0], 0)).toBe("k1:x");
    expect(rowEditKey([undefined as unknown as CellValue], [0], 0)).toBe("k1:x");
    expect(rowEditKey([true], [0], 0)).toBe("k2:b1");
    expect(rowEditKey([false], [0], 0)).toBe("k2:b0");
    expect(rowEditKey([5], [0], 0)).toBe("k2:n5");
    expect(rowEditKey(["a"], [0], 0)).toBe("k2:sa");
    expect(rowEditKey([1, "a"], [0, 1], 0)).toBe("k2:n12:sa");
    expect(rowEditKey([1], [], 7)).toBe("i7");
    // 数値 1 と文字列 "1" と真偽値 true は別の鍵。
    const keys = new Set([rowEditKey([1], [0], 0), rowEditKey(["1"], [0], 0), rowEditKey([true], [0], 0)]);
    expect(keys.size).toBe(3);
  });

  it("hasAmbiguousIdentity: 空の行 (欠損) は読み飛ばし、重複行だけを検出する", () => {
    const sparse = [undefined, [1], [2]] as unknown as CellValue[][];
    expect(hasAmbiguousIdentity(sparse, [0])).toBe(false);
    expect(hasAmbiguousIdentity([[1], undefined, [1]] as unknown as CellValue[][], [0])).toBe(true);
    expect(hasAmbiguousIdentity([[1], [1]], [])).toBe(false);
  });
});

describe("WHERE 項・リテラル生成の境界 (#1663)", () => {
  const pkCols = [col("id", "INT"), col("price", "FLOAT")];

  it("NULL / 未定義セルは IS NULL (= NULL にしない)", () => {
    const base = { driver: "mysql", database: "d", table: "t", columns: pkCols, pkIndices: [0] };
    const del = buildDeleteStatements({
      ...base,
      rows: [[undefined as unknown as CellValue, 1]],
      deleteKeys: new Set([rowEditKey([undefined as unknown as CellValue], [0], 0)]),
    });
    expect(del).toEqual(["DELETE FROM `d`.`t` WHERE `id` IS NULL;"]);
    expect(buildRowWhere("mysql", pkCols, [undefined as unknown as CellValue, 1], [0])).toBe("`id` IS NULL");
    expect(buildRowWhere("mysql", pkCols, [null, 1], [0])).toBe("`id` IS NULL");
  });

  it("単精度 float (FLOAT / REAL / FLOAT4) の WHERE は許容差比較、文字列値や SQLite は等価比較", () => {
    const f = (type: string, v: CellValue, driver = "postgres") =>
      buildDeleteStatements({
        driver,
        database: "d",
        table: "t",
        columns: [col("x", type)],
        rows: [[v]],
        pkIndices: [0],
        deleteKeys: new Set([rowEditKey([v], [0], 0)]),
      })[0];
    for (const t of ["FLOAT", "REAL", "FLOAT4", "real"]) {
      expect(f(t, 0.1), t).toContain('ABS("x" - (0.1)) <= ABS((0.1)) * 0.000001');
    }
    expect(f("FLOAT", "0.1")).toBe(`DELETE FROM "d"."t" WHERE "x" = '0.1';`);
    expect(f("FLOAT", Number.POSITIVE_INFINITY)).toBe(`DELETE FROM "d"."t" WHERE "x" = NULL;`);
    expect(f("REAL", 0.1, "sqlite")).toBe(`DELETE FROM "t" WHERE "x" = 0.1;`);
    expect(f("DOUBLE", 0.1)).toBe(`DELETE FROM "d"."t" WHERE "x" = 0.1;`);
  });

  it("複合主キーの WHERE は AND で連結する (UPDATE / DELETE / BLOB 更新 / buildRowWhere)", () => {
    const columns = [col("a", "INT"), col("b", "INT"), col("c", "TEXT"), col("img", "BLOB")];
    const rows: CellValue[][] = [[1, 2, "x", "00"]];
    const key = rowEditKey(rows[0], [0, 1], 0);
    expect(
      buildUpdateStatements({
        driver: "mysql",
        database: "d",
        table: "t",
        columns,
        rows,
        pkIndices: [0, 1],
        edits: { [key]: { 2: "y" } },
      }),
    ).toEqual(["UPDATE `d`.`t` SET `c` = 'y' WHERE `a` = 1 AND `b` = 2;"]);
    expect(
      buildDeleteStatements({
        driver: "mysql",
        database: "d",
        table: "t",
        columns,
        rows,
        pkIndices: [0, 1],
        deleteKeys: new Set([key]),
      }),
    ).toEqual(["DELETE FROM `d`.`t` WHERE `a` = 1 AND `b` = 2;"]);
    expect(
      buildBlobUpdateStatement({
        driver: "mysql",
        database: "d",
        table: "t",
        columns,
        row: rows[0],
        pkIndices: [0, 1],
        colIdx: 3,
        hex: "DEADBEEF",
      }),
    ).toBe("UPDATE `d`.`t` SET `img` = 0xdeadbeef WHERE `a` = 1 AND `b` = 2;");
    expect(buildRowWhere("mysql", columns, rows[0], [0, 1])).toBe("`a` = 1 AND `b` = 2");
    expect(buildRowWhere("mysql", columns, rows[0], [])).toBeNull();
  });

  it("buildRowSql: UPDATE / DELETE の複合キー連結、欠損行の読み飛ばし、型ごとのリテラル", () => {
    const columns = [col("a", "INT"), col("b", "INT"), col("c", "TEXT")];
    const input: BuildRowSqlInput = {
      driver: "mysql",
      database: "d",
      table: "t",
      columns,
      rows: [[1, 2, "x"]],
      pkIndices: [0, 1],
    };
    expect(buildRowSql(input, "update")).toEqual(["UPDATE `d`.`t` SET `c` = 'x' WHERE `a` = 1 AND `b` = 2;"]);
    // SET の列が複数のときはカンマで連結する。
    expect(
      buildRowSql({ ...input, columns: [...columns, col("e", "INT")], rows: [[1, 2, "x", 9]] }, "update"),
    ).toEqual(["UPDATE `d`.`t` SET `c` = 'x', `e` = 9 WHERE `a` = 1 AND `b` = 2;"]);
    expect(buildRowSql(input, "delete")).toEqual(["DELETE FROM `d`.`t` WHERE `a` = 1 AND `b` = 2;"]);
    for (const kind of ["insert", "update", "delete"] as const) {
      expect(buildRowSql({ ...input, rows: [undefined as unknown as CellValue[]] }, kind)).toEqual([]);
    }
    // 行が列より短い (未定義セル) と NULL、真偽値は TRUE/FALSE、非有限数は NULL、数値は裸の数字。
    const lits: BuildRowSqlInput = {
      driver: "postgres",
      database: "d",
      table: "t",
      columns: [col("p", "BOOLEAN"), col("q", "TEXT"), col("r", "TEXT"), col("s", "TEXT")],
      rows: [[true, 5, Number.NaN, undefined as unknown as CellValue]],
      pkIndices: [],
    };
    expect(buildRowSql(lits, "insert")).toEqual([
      `INSERT INTO "d"."t" ("p", "q", "r", "s") VALUES (TRUE, 5, NULL, NULL);`,
    ]);
    expect(buildRowSql({ ...lits, rows: [[false, "a", "b", "c"]] }, "insert")).toEqual([
      `INSERT INTO "d"."t" ("p", "q", "r", "s") VALUES (FALSE, 'a', 'b', 'c');`,
    ]);
  });

  it("buildBlobUpdateStatement: 16 進は小文字に正規化する", () => {
    const columns = [col("id", "INT"), col("img", "BLOB")];
    expect(
      buildBlobUpdateStatement({
        driver: "sqlite",
        database: "main",
        table: "t",
        columns,
        row: [1, "00"],
        pkIndices: [0],
        colIdx: 1,
        hex: "AbCd",
      }),
    ).toBe(`UPDATE "t" SET "img" = X'abcd' WHERE "id" = 1;`);
  });
});

describe("編集バッファから文を作るときの不正入力の読み飛ばし (#1663)", () => {
  const columns = [col("id", "INT"), col("name", "TEXT")];
  const rows: CellValue[][] = [[1, "a"]];
  const key = rowEditKey(rows[0], [0], 0);
  const base = { driver: "mysql", database: "d", table: "t", columns, rows, pkIndices: [0] };

  it("範囲外の列だけの編集は文もグループも作らない / applyEditsToRows は無視する", () => {
    const edits: PendingEdits = { [key]: { 99: "x" } };
    expect(buildUpdateStatements({ ...base, edits })).toEqual([]);
    expect(buildUpdateGroups({ ...base, edits })).toEqual({ groups: [], rowCount: 0 });
    expect(applyEditsToRows({ columns, rows, pkIndices: [0], edits })).toEqual([[1, "a"]]);
    // 範囲外の列が混じっても有効な列は反映する。
    expect(buildUpdateStatements({ ...base, edits: { [key]: { 99: "x", 1: "b" } } })).toEqual([
      "UPDATE `d`.`t` SET `name` = 'b' WHERE `id` = 1;",
    ]);
    expect(
      applyEditsToRows({ columns, rows, pkIndices: [0], edits: { [key]: { 99: "x", 1: "b" } } }),
    ).toEqual([[1, "b"]]);
  });

  it("主キーが解決できないときは (フォールバック鍵に編集があっても) 何も作らない", () => {
    const edits: PendingEdits = { i0: { 1: "b" } };
    expect(buildUpdateStatements({ ...base, pkIndices: [], edits })).toEqual([]);
    expect(buildUpdateGroups({ ...base, pkIndices: [], edits })).toEqual({ groups: [], rowCount: 0 });
  });

  it("欠損行 (undefined) は読み飛ばす", () => {
    const sparse = [undefined, ...rows] as unknown as CellValue[][];
    const k1 = rowEditKey(rows[0], [0], 1);
    const edits: PendingEdits = { [k1]: { 1: "b" } };
    expect(buildUpdateStatements({ ...base, rows: sparse, edits })).toHaveLength(1);
    expect(buildUpdateGroups({ ...base, rows: sparse, edits }).rowCount).toBe(1);
    expect(applyEditsToRows({ columns, rows: sparse, pkIndices: [0], edits })).toEqual([[1, "b"]]);
    expect(buildDeleteStatements({ ...base, rows: sparse, deleteKeys: new Set([k1]) })).toEqual([
      "DELETE FROM `d`.`t` WHERE `id` = 1;",
    ]);
  });

  it("同じ主キーが再掲されても DELETE は 1 回だけ出す", () => {
    const dup: CellValue[][] = [
      [1, "a"],
      [1, "a"],
    ];
    expect(buildDeleteStatements({ ...base, rows: dup, deleteKeys: new Set([key]) })).toEqual([
      "DELETE FROM `d`.`t` WHERE `id` = 1;",
    ]);
  });
});

describe("行追加バッファ (#1663)", () => {
  const columns = [col("id", "INT"), col("name", "TEXT"), col("at", "DATETIME")];

  it("関数値・空文字値の型ガードと、空欄の判定", () => {
    expect(isInsertFunctionValue({ fn: "now" })).toBe(true);
    expect(isInsertFunctionValue({ empty: true })).toBe(false);
    expect(isInsertFunctionValue("now" as never)).toBe(false);
    expect(isInsertFunctionValue(undefined)).toBe(false);
    expect(isInsertFunctionValue(null as never)).toBe(false);
    expect(isInsertEmptyStringValue({ empty: true })).toBe(true);
    expect(isInsertEmptyStringValue({ fn: "now" })).toBe(false);
    expect(isInsertEmptyStringValue("empty" as never)).toBe(false);
    expect(isInsertEmptyStringValue(undefined)).toBe(false);
    expect(isInsertEmptyStringValue(null as never)).toBe(false);
    expect(isEmptyInsertValue(undefined)).toBe(true);
    expect(isEmptyInsertValue("")).toBe(true);
    expect(isEmptyInsertValue("x")).toBe(false);
    expect(isEmptyInsertValue({ empty: true })).toBe(false);
  });

  it("範囲外の列は読み飛ばし、ドライバに無い関数を含む行は丸ごと出さない", () => {
    const base = { driver: "mysql", database: "d", table: "t", columns };
    expect(buildInsertStatements({ ...base, inserts: [{ 99: "x" }] })).toEqual([]);
    expect(buildInsertStatements({ ...base, inserts: [{ 99: "x", 1: "n" }] })).toEqual([
      "INSERT INTO `d`.`t` (`name`) VALUES ('n');",
    ]);
    // SQLite に NOW() は無い: 先に有効な列があっても行ごと除外する。
    expect(
      buildInsertStatements({
        driver: "sqlite",
        database: "main",
        table: "t",
        columns,
        inserts: [{ 1: "n", 2: { fn: "now" } }],
      }),
    ).toEqual([]);
    expect(
      buildInsertStatements({
        driver: "mysql",
        database: "d",
        table: "t",
        columns,
        inserts: [{ 1: "n", 2: { fn: "now" } }],
      }),
    ).toEqual(["INSERT INTO `d`.`t` (`name`, `at`) VALUES ('n', NOW());"]);
  });

  it("buildInsertClipboard: 表名は trim し、フォールバック名は exported_table", () => {
    const input = {
      driver: "mysql",
      database: "d",
      table: "  t  ",
      columns: [col("a", "INT")],
      rows: [[1]] as CellValue[][],
    };
    expect(buildInsertClipboard(input, true)).toEqual({
      sql: "INSERT INTO `d`.`t` (`a`) VALUES (1);",
      tableResolved: true,
    });
    expect(FALLBACK_INSERT_TABLE).toBe("exported_table");
  });
});

describe("editIsNoop / previewSavedValue の境界 (#1663)", () => {
  const text = col("name", "VARCHAR(10)");

  it("editIsNoop: NULL と非 NULL は常に変更あり、未定義の現在値も NULL 扱い", () => {
    expect(editIsNoop("NULL", text, null)).toBe(true);
    expect(editIsNoop("NULL", text, undefined as unknown as CellValue)).toBe(true);
    expect(editIsNoop("NULL", text, "null")).toBe(false);
    expect(editIsNoop("NULL", text, 5)).toBe(false);
    expect(editIsNoop("5", text, null)).toBe(false);
    // 現在値が未定義 (NULL) のとき、文字列 "undefined" への編集は変更あり。
    expect(editIsNoop("undefined", text, undefined as unknown as CellValue)).toBe(false);
    expect(editIsNoop("abc", text, "abc")).toBe(true);
  });

  it("previewSavedValue: 前後空白の注記は文字列系の列だけ", () => {
    expect(previewSavedValue(" x ", text)).toEqual({ kind: "edgeSpace" });
    expect(previewSavedValue(" 2020-01-01 ", col("d", "DATE"))).toBeNull();
    expect(previewSavedValue(" abc ", col("n", "INT"))).toBeNull();
  });
});

describe("oldValueForLock / 楽観ロックの旧値 (#1766)", () => {
  it("NULL は型を問わず IS NULL", () => {
    expect(oldValueForLock("mysql", col("a", "JSON"), null)).toEqual({ kind: "null" });
    expect(oldValueForLock("postgres", col("a", "BYTEA"), null)).toEqual({ kind: "null" });
  });

  it("数値・文字列・真偽値は等値で検査する。64bit 整数は文字列のまま渡す", () => {
    expect(oldValueForLock("mysql", col("a", "INT"), 5)).toEqual({ kind: "number", text: "5" });
    expect(oldValueForLock("mysql", col("a", "BIGINT UNSIGNED"), "18446744073709551615")).toEqual({
      kind: "number",
      text: "18446744073709551615",
    });
    expect(oldValueForLock("postgres", col("a", "INT8"), "9007199254740993")).toEqual({
      kind: "number",
      text: "9007199254740993",
    });
    expect(oldValueForLock("postgres", col("a", "NUMERIC"), "1.50")).toEqual({
      kind: "number",
      text: "1.50",
    });
    expect(oldValueForLock("sqlite", col("a", "TEXT"), "x")).toEqual({ kind: "text", text: "x" });
    expect(oldValueForLock("mysql", col("a", "VARCHAR(20)"), "x")).toEqual({ kind: "text", text: "x" });
    expect(oldValueForLock("postgres", col("a", "BOOL"), true)).toEqual({ kind: "bool", value: true });
    expect(oldValueForLock("mysql", col("a", "DATETIME"), "2020-01-02 03:04:05")).toEqual({
      kind: "text",
      text: "2020-01-02 03:04:05",
    });
  });

  it("単精度 float は許容誤差の述語 (float4)、SQLite の REAL と倍精度は厳密比較", () => {
    expect(oldValueForLock("postgres", col("a", "FLOAT4"), 0.1)).toEqual({ kind: "float4", text: "0.1" });
    expect(oldValueForLock("mysql", col("a", "FLOAT"), 0.1)).toEqual({ kind: "float4", text: "0.1" });
    expect(oldValueForLock("sqlite", col("a", "REAL"), 0.1)).toEqual({ kind: "number", text: "0.1" });
    expect(oldValueForLock("mysql", col("a", "DOUBLE"), 0.1)).toEqual({ kind: "number", text: "0.1" });
    expect(oldValueForLock("postgres", col("a", "FLOAT8"), 0.1)).toEqual({ kind: "number", text: "0.1" });
  });

  it("MySQL でデコードできず NULL になる日時 (ゼロ日付など) は IS NULL を足さない", () => {
    for (const t of ["DATE", "DATETIME", "TIMESTAMP", "TIME"]) {
      expect(oldValueForLock("mysql", col("a", t), null)).toBeNull();
    }
    // PG / SQLite の NULL や、日時でない MySQL 列の NULL は従来どおり。
    expect(oldValueForLock("postgres", col("a", "DATE"), null)).toEqual({ kind: "null" });
    expect(oldValueForLock("sqlite", col("a", "DATETIME"), null)).toEqual({ kind: "null" });
    expect(oldValueForLock("mysql", col("a", "VARCHAR"), null)).toEqual({ kind: "null" });
  });

  it("リテラルで往復できない日時 (infinity・紀元前) は検査しない", () => {
    expect(oldValueForLock("postgres", col("a", "DATE"), "2020-01-02")).toEqual({
      kind: "text",
      text: "2020-01-02",
    });
    expect(oldValueForLock("postgres", col("a", "TIME"), "12:30:00")).toEqual({
      kind: "text",
      text: "12:30:00",
    });
    for (const [t, v] of [
      ["DATE", "infinity"],
      ["DATE", "0044-03-15 BC"],
      ["TIMESTAMP", "-infinity"],
      ["TIMESTAMP", "0044-03-15 12:00:00 BC"],
      ["TIME", "24:00:00 junk"],
    ]) {
      expect(oldValueForLock("postgres", col("a", t), v)).toBeNull();
    }
  });

  it("等値比較が不安定な型・値は検査しない", () => {
    for (const t of [
      "BLOB",
      "BYTEA",
      "JSON",
      "JSONB",
      "TIMESTAMPTZ",
      "INTERVAL",
      "BIT",
      "_INT4",
      "GEOMETRY",
      "",
    ]) {
      expect(
        oldValueForLock("postgres", col("a", t), t === "BLOB" || t === "BYTEA" ? "00ff" : "v"),
      ).toBeNull();
    }
    // 非有限の数・数値でない文字列。
    expect(oldValueForLock("mysql", col("a", "DOUBLE"), Number.NaN)).toBeNull();
    expect(oldValueForLock("mysql", col("a", "INT"), "abc")).toBeNull();
    // 丸め済みかもしれない桁数の多い DECIMAL (JS の数値で持っているもの)。
    expect(oldValueForLock("mysql", col("a", "DECIMAL"), 123456789.12345679)).toBeNull();
  });
});

describe("buildUpdateGroups の楽観ロック (#1766)", () => {
  const columns = [col("id", "INT"), col("name", "VARCHAR"), col("score", "FLOAT4"), col("data", "JSON")];
  const rows: CellValue[][] = [
    [1, "a", 0.1, '{"k":1}'],
    [2, null, 0.2, null],
  ];
  const base = (edits: PendingEdits, optimisticLock?: boolean) => ({
    driver: "postgres",
    database: "db",
    table: "t",
    columns,
    rows,
    pkIndices: [0],
    edits,
    optimisticLock,
  });
  const k = (id: number) => rowEditKey([id, "", 0, null], [0], 0);

  it("オフ (既定) のときは olds を付けない", () => {
    const { groups } = buildUpdateGroups(base({ [k(1)]: { 1: "x" } }));
    expect(groups[0].olds).toBeUndefined();
    expect(buildUpdateGroups(base({ [k(1)]: { 1: "x" } }, false)).groups[0].olds).toBeUndefined();
  });

  it("オンのときは編集した列の旧値を行ごとに keys と同順で付ける (同じ SET でも旧値は行ごと)", () => {
    const { groups } = buildUpdateGroups(
      base({ [k(1)]: { 1: "x", 2: "5", 3: "{}" }, [k(2)]: { 1: "x", 2: "5", 3: "{}" } }, true),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].keys).toEqual([[1], [2]]);
    expect(groups[0].olds).toEqual([
      [{ kind: "text", text: "a" }, { kind: "float4", text: "0.1" }, null],
      [{ kind: "null" }, { kind: "float4", text: "0.2" }, { kind: "null" }],
    ]);
  });

  it("主キー列の編集には旧値を付けない (WHERE に元の値が入っている)", () => {
    const { groups } = buildUpdateGroups(base({ [k(1)]: { 0: "9" } }, true));
    expect(groups[0].olds).toEqual([[null]]);
  });
});
