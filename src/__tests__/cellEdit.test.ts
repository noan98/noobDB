import { describe, it, expect } from "vitest";
import { CellValue, Column, TableColumnInfo } from "../api/tauri";
import {
  applyEditsToRows,
  buildDeleteStatements,
  buildInsertStatements,
  buildRowSql,
  buildUpdateStatements,
  cellValueFromInput,
  countEditedCells,
  countEditedRows,
  isEditableColumnType,
  resolvePkIndices,
  rowEditKey,
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
    // later page — even if the edited row's array index shifts. (Edits
    // survive pagination because they are PK-keyed.)
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
      expect(
        buildRowSql(baseRowSql({ columns, rows: [[1, true, null]] }), "insert"),
      ).toEqual(["INSERT INTO `db`.`tbl` (`id`, `flag`, `note`) VALUES (1, TRUE, NULL);"]);
      expect(
        buildRowSql(baseRowSql({ columns, rows: [[2, false, "O'Brien"]] }), "insert"),
      ).toEqual([
        "INSERT INTO `db`.`tbl` (`id`, `flag`, `note`) VALUES (2, FALSE, 'O''Brien');",
      ]);
    });

    it("keeps a precision-preserving numeric string unquoted for numeric columns", () => {
      // BIGINT beyond 2^53 arrives as a string to avoid precision loss; it must
      // still emit as a bare numeral, not a quoted string.
      const columns = [col("id", "BIGINT"), col("amount", "DECIMAL")];
      expect(
        buildRowSql(
          baseRowSql({ columns, rows: [["9007199254740993", "12.50"]] }),
          "insert",
        ),
      ).toEqual([
        "INSERT INTO `db`.`tbl` (`id`, `amount`) VALUES (9007199254740993, 12.50);",
      ]);
    });

    it("emits driver-specific BLOB literals", () => {
      const columns = [col("id", "INT"), col("data", "BLOB")];
      const rows: CellValue[][] = [[1, "deadbeef"]];
      expect(buildRowSql(baseRowSql({ columns, rows }), "insert")).toEqual([
        "INSERT INTO `db`.`tbl` (`id`, `data`) VALUES (1, 0xdeadbeef);",
      ]);
      expect(
        buildRowSql(baseRowSql({ driver: "postgres", columns, rows }), "insert"),
      ).toEqual(['INSERT INTO "db"."tbl" ("id", "data") VALUES (1, \'\\xdeadbeef\');']);
      expect(
        buildRowSql(baseRowSql({ driver: "sqlite", columns, rows }), "insert"),
      ).toEqual(['INSERT INTO "tbl" ("id", "data") VALUES (1, X\'deadbeef\');']);
    });

    it("treats PostgreSQL BYTEA as a BLOB-family column (regression: #修正4)", () => {
      const columns = [col("id", "INT"), col("data", "BYTEA")];
      const rows: CellValue[][] = [[1, "deadbeef"]];
      expect(
        buildRowSql(baseRowSql({ driver: "postgres", columns, rows }), "insert"),
      ).toEqual(['INSERT INTO "db"."tbl" ("id", "data") VALUES (1, \'\\xdeadbeef\');']);
    });

    it("emits one statement per row", () => {
      expect(
        buildRowSql(baseRowSql({ rows: [[1, "a"], [2, "b"]] }), "insert"),
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
      expect(
        buildRowSql(
          baseRowSql({ columns, rows: [[1, 2, "x"]], pkIndices: [0, 1] }),
          "update",
        ),
      ).toEqual(["UPDATE `db`.`tbl` SET `v` = 'x' WHERE `a` = 1 AND `b` = 2;"]);
    });
  });

  describe("DELETE", () => {
    it("keys WHERE on the PK", () => {
      expect(buildRowSql(baseRowSql({}), "delete")).toEqual([
        "DELETE FROM `db`.`tbl` WHERE `id` = 1;",
      ]);
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
    expect(buildRowSql(baseRowSql({ columns: [], rows: [[]], pkIndices: [] }), "insert")).toEqual(
      [],
    );
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
    expect(stmts).toEqual([
      "INSERT INTO `shop`.`users` (`name`, `active`) VALUES ('Alice', TRUE);",
    ]);
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
      buildDeleteStatements({ driver: "mysql", database: "d", table: "t", columns, rows, pkIndices: [], deleteKeys: new Set(["x"]) }),
    ).toEqual([]);
    expect(
      buildDeleteStatements({ driver: "mysql", database: "d", table: "t", columns, rows, pkIndices, deleteKeys: new Set() }),
    ).toEqual([]);
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
