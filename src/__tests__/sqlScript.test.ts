import { describe, expect, it } from "vitest";
import {
  isMultiStatement,
  splitSqlStatementRanges,
  splitSqlStatements,
  statementAtOffset,
} from "../sqlScript";

describe("splitSqlStatements", () => {
  it("splits simple statements and drops empties", () => {
    expect(splitSqlStatements("SELECT 1; SELECT 2;")).toEqual(["SELECT 1", "SELECT 2"]);
    expect(splitSqlStatements("SELECT 1;;; SELECT 2")).toEqual(["SELECT 1", "SELECT 2"]);
    expect(splitSqlStatements("   ")).toEqual([]);
  });

  it("does not split on a semicolon inside a string literal", () => {
    expect(splitSqlStatements("SELECT ';' AS s; SELECT 2")).toEqual([
      "SELECT ';' AS s",
      "SELECT 2",
    ]);
  });

  it("handles doubled-quote escapes inside strings", () => {
    expect(splitSqlStatements("SELECT 'a;''b'; SELECT 2")).toEqual([
      "SELECT 'a;''b'",
      "SELECT 2",
    ]);
  });

  it("ignores semicolons in identifiers and backticks", () => {
    expect(splitSqlStatements('SELECT "a;b"; SELECT `c;d`')).toEqual([
      'SELECT "a;b"',
      "SELECT `c;d`",
    ]);
  });

  it("ignores semicolons inside line and block comments", () => {
    expect(splitSqlStatements("SELECT 1 -- a; b\n; SELECT 2")).toEqual([
      "SELECT 1 -- a; b",
      "SELECT 2",
    ]);
    expect(splitSqlStatements("SELECT 1 /* x; y */; SELECT 2")).toEqual([
      "SELECT 1 /* x; y */",
      "SELECT 2",
    ]);
  });

  it("treats `#` as a line comment, matching dangerousSql.ts's maskLiterals (#J3)", () => {
    // A `;` after `#` is inside the (now-recognized) comment, so it is not a
    // statement boundary.
    expect(splitSqlStatements("SELECT 1 # a; b\n; SELECT 2")).toEqual([
      "SELECT 1 # a; b",
      "SELECT 2",
    ]);
    // Regression: this is the exact input from #J3 — PostgreSQL's `#>>`
    // operator followed by a stacked DELETE. Before the fix, `splitSqlStatements`
    // did not treat `#` as a comment, so it saw two statements here
    // (`SELECT data #>> '{a}' FROM t` and `DELETE FROM t`), while
    // `analyzeDangerousSql`/`isReadOnlySql` (which do treat `#` as a comment)
    // saw one statement with the DELETE masked away as "comment" text — the
    // mismatch meant the dangerous-write confirmation could be skipped. Both
    // now agree it is a single statement.
    expect(
      splitSqlStatements("SELECT data #>> '{a}' FROM t; DELETE FROM t"),
    ).toEqual(["SELECT data #>> '{a}' FROM t; DELETE FROM t"]);
  });

  it("drops a trailing `#`-comment-only fragment", () => {
    expect(splitSqlStatements("SELECT 1; # note")).toEqual(["SELECT 1"]);
  });

  it("keeps a dollar-quoted function body as a single statement", () => {
    const sql =
      "CREATE FUNCTION f() RETURNS int AS $$ BEGIN; RETURN 1; END; $$ LANGUAGE plpgsql; SELECT f()";
    expect(splitSqlStatements(sql)).toEqual([
      "CREATE FUNCTION f() RETURNS int AS $$ BEGIN; RETURN 1; END; $$ LANGUAGE plpgsql",
      "SELECT f()",
    ]);
  });

  it("supports tagged dollar quotes", () => {
    const sql = "SELECT $tag$ a; b $tag$; SELECT 2";
    expect(splitSqlStatements(sql)).toEqual(["SELECT $tag$ a; b $tag$", "SELECT 2"]);
  });

  it("does not mistake parameter placeholders for dollar-quote tags", () => {
    // `$1$ ... $1$` のような数字始まりタグは PostgreSQL では無効 ($1 はパラメータ)。
    // 文字列とみなして 2 文目を飲み込まないこと。
    expect(splitSqlStatements("SELECT $1; SELECT $1")).toEqual([
      "SELECT $1",
      "SELECT $1",
    ]);
  });

  it("does not treat `$` inside an identifier as a dollar-quote opener", () => {
    // MySQL は識別子に `$` を許す。`a$tag$` ... `b$tag$` で挟まれた `;` を
    // ドル引用の内側と誤認して分割を失わないこと。
    expect(splitSqlStatements("SELECT a$tag$; SELECT b$tag$")).toEqual([
      "SELECT a$tag$",
      "SELECT b$tag$",
    ]);
  });

  it("returns the whole input when there is a single statement", () => {
    expect(splitSqlStatements("SELECT 1")).toEqual(["SELECT 1"]);
  });

  it("drops a trailing comment-only fragment", () => {
    expect(splitSqlStatements("SELECT 1; -- note")).toEqual(["SELECT 1"]);
    expect(splitSqlStatements("SELECT 1; /* x */")).toEqual(["SELECT 1"]);
  });
});

describe("splitSqlStatements — driver-aware backslash escaping (#852, #1004)", () => {
  // `SELECT '\' AS x; DROP TABLE t` — a `'` string containing a single
  // backslash, followed by a second statement. Only MySQL/MariaDB reads `\`
  // as an escape character inside `'...'`; every other supported driver reads
  // it as an ordinary character, so the `'` right after it closes the string
  // and the trailing `; DROP TABLE t` is a real second statement. This must
  // match `dangerousSql.ts`'s `driverBackslashEscapes` exactly — a mismatch
  // here means `statementAtOffset` (the #555 "run statement under cursor"
  // feature) can silently fold a later DROP into the statement under the
  // cursor and run it too.
  const sql = "SELECT '\\' AS x; DROP TABLE t";

  it.each(["postgres", "sqlite", "duckdb", "mssql"])(
    "splits into two statements on %s (backslash is not an escape)",
    (driver) => {
      expect(splitSqlStatements(sql, driver)).toEqual([
        "SELECT '\\' AS x",
        "DROP TABLE t",
      ]);
    },
  );

  it("splits into two statements when no driver is given (conservative fallback)", () => {
    expect(splitSqlStatements(sql)).toEqual(["SELECT '\\' AS x", "DROP TABLE t"]);
  });

  it("keeps it as a single statement on mysql (backslash escapes the quote)", () => {
    // On MySQL, `\'` inside the string does not close it, so the `'` that
    // actually closes the literal is the one right before `; DROP TABLE t`,
    // and the whole thing is one statement (a SELECT whose alias is
    // `'; DROP TABLE t` textually, but syntactically unterminated until EOF —
    // in real MySQL this string never closes and the statement errors, but
    // for the purposes of statement *splitting* what matters is that the
    // masking-agreeing behavior does not treat `; DROP TABLE t` as a second
    // statement).
    expect(splitSqlStatements(sql, "mysql")).toEqual([sql]);
  });

  it("statementAtOffset does not fold a following DROP into the cursor statement on non-MySQL drivers", () => {
    // Cursor sits inside "SELECT '\' AS x" (offset 5). On a non-MySQL driver
    // the range returned must stop before `; DROP TABLE t`.
    for (const driver of ["postgres", "sqlite", "duckdb", "mssql"] as const) {
      expect(statementAtOffset(sql, 5, driver)?.text).toBe("SELECT '\\' AS x");
    }
    expect(statementAtOffset(sql, 5)?.text).toBe("SELECT '\\' AS x");
  });

  it("isMultiStatement agrees with splitSqlStatements across drivers", () => {
    for (const driver of ["postgres", "sqlite", "duckdb", "mssql"] as const) {
      expect(isMultiStatement(sql, driver)).toBe(true);
    }
    expect(isMultiStatement(sql)).toBe(true);
    expect(isMultiStatement(sql, "mysql")).toBe(false);
  });
});

describe("splitSqlStatementRanges", () => {
  it("returns trimmed-body offsets for each statement", () => {
    const sql = "SELECT 1;  SELECT 2 ;";
    const ranges = splitSqlStatementRanges(sql);
    expect(ranges.map((r) => r.text)).toEqual(["SELECT 1", "SELECT 2"]);
    // 各 from/to が元 SQL のトリム済み本文を指す。
    expect(ranges.map((r) => sql.slice(r.from, r.to))).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("does not split inside strings/comments when ranging", () => {
    const sql = "SELECT ';' -- x;y\n; SELECT 2";
    const ranges = splitSqlStatementRanges(sql);
    expect(ranges.map((r) => r.text)).toEqual(["SELECT ';' -- x;y", "SELECT 2"]);
  });
});

describe("statementAtOffset", () => {
  const sql = "SELECT 1;\nSELECT 2;\nSELECT 3";

  it("returns null for empty / comment-only input", () => {
    expect(statementAtOffset("   ", 1)).toBeNull();
    expect(statementAtOffset("-- just a comment", 3)).toBeNull();
  });

  it("returns the single statement regardless of cursor", () => {
    expect(statementAtOffset("SELECT 42", 0)?.text).toBe("SELECT 42");
    expect(statementAtOffset("SELECT 42", 9)?.text).toBe("SELECT 42");
  });

  it("picks the statement the cursor sits within", () => {
    // 1 文目の途中。
    expect(statementAtOffset(sql, 3)?.text).toBe("SELECT 1");
    // 2 文目の途中 ("SELECT 2" は index 10..18)。
    expect(statementAtOffset(sql, 14)?.text).toBe("SELECT 2");
    // 3 文目 (末尾)。
    expect(statementAtOffset(sql, sql.length)?.text).toBe("SELECT 3");
  });

  it("attributes the cursor right after a semicolon to the next statement", () => {
    // index 9 は 1 文目の ';' の直後 (改行)。次の文へ送る。
    expect(statementAtOffset(sql, 9)?.text).toBe("SELECT 2");
  });

  it("does not split on a semicolon inside a string", () => {
    const s = "SELECT ';' AS a; SELECT 2";
    expect(statementAtOffset(s, 5)?.text).toBe("SELECT ';' AS a");
  });
});

describe("isMultiStatement", () => {
  it("is true only for more than one statement", () => {
    expect(isMultiStatement("SELECT 1")).toBe(false);
    expect(isMultiStatement("SELECT 1; SELECT 2")).toBe(true);
    expect(isMultiStatement("SELECT ';'")).toBe(false);
    // 末尾のコメントだけの断片は 2 文目として数えない。
    expect(isMultiStatement("SELECT 1; -- note")).toBe(false);
  });
});
