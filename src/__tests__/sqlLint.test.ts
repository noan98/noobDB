import { describe, expect, it } from "vitest";
import { MySQL, PostgreSQL, SQLite } from "@codemirror/lang-sql";
import {
  computeSqlDiagnostics,
  diagnosticsFromTree,
  parseSqlTree,
  type SqlLintMessages,
} from "../components/sqlLint";

const MSG: SqlLintMessages = {
  syntaxError: "syntax",
  unterminated: "unterminated",
};

function diags(sql: string, dialect = MySQL) {
  return computeSqlDiagnostics(sql, dialect, MSG);
}

describe("computeSqlDiagnostics — no false positives on valid SQL", () => {
  const valid = [
    "SELECT id, name FROM users WHERE id = 1",
    "SELECT * FROM users",
    "INSERT INTO t (a, b) VALUES (1, 2)",
    "UPDATE t SET a = 1 WHERE id = 2",
    "DELETE FROM t WHERE id = 3",
    "WITH t AS (SELECT 1 AS x) SELECT * FROM t",
    "SELECT 1; SELECT 2;",
    "SELECT 'a; b' AS s FROM t",
    "SELECT COUNT(*) FROM users",
    "SELECT * FROM a JOIN b ON a.id = b.a_id WHERE a.x IN (1, 2, 3)",
    "SELECT 'it''s ok' AS s",
    // partial / in-progress editing should not light up while typing
    "SELECT * FROM ",
    "",
    "   \n  ",
    "-- just a comment",
  ];
  for (const sql of valid) {
    it(`does not flag: ${JSON.stringify(sql)}`, () => {
      expect(diags(sql)).toEqual([]);
    });
  }
});

describe("computeSqlDiagnostics — unterminated string / quote", () => {
  it("flags an unterminated single-quoted string", () => {
    const d = diags("SELECT 'abc FROM users");
    expect(d.length).toBeGreaterThanOrEqual(1);
    expect(d.some((x) => x.message === MSG.unterminated)).toBe(true);
    // the diagnostic spans the opening quote
    const u = d.find((x) => x.message === MSG.unterminated)!;
    expect(u.from).toBe("SELECT ".length);
  });

  it("flags an unterminated double-quoted string (MySQL)", () => {
    const d = diags('SELECT "abc FROM users');
    expect(d.some((x) => x.message === MSG.unterminated)).toBe(true);
  });

  it("flags an unterminated backtick identifier", () => {
    const d = diags("SELECT `abc FROM users");
    expect(d.some((x) => x.message === MSG.unterminated)).toBe(true);
  });

  it("does not flag a properly closed string", () => {
    expect(diags("SELECT 'abc' FROM users")).toEqual([]);
  });
});

describe("computeSqlDiagnostics — bracket mismatch", () => {
  it("flags an unclosed parenthesis", () => {
    const d = diags("SELECT * FROM users WHERE (id = 1");
    expect(d.length).toBeGreaterThanOrEqual(1);
    expect(d.some((x) => x.message === MSG.syntaxError)).toBe(true);
  });

  it("flags an extra closing parenthesis", () => {
    const d = diags("SELECT * FROM users)");
    expect(d.some((x) => x.message === MSG.syntaxError)).toBe(true);
  });

  it("merges consecutive stray closers into a single diagnostic", () => {
    const d = diags("SELECT * FROM t))");
    const errs = d.filter((x) => x.message === MSG.syntaxError);
    expect(errs.length).toBe(1);
  });
});

describe("diagnosticsFromTree — diagnostic shape", () => {
  it("produces in-range, non-negative offsets with error severity", () => {
    const sql = "SELECT * FROM users WHERE (id = 1";
    const d = diagnosticsFromTree(parseSqlTree(sql, MySQL), sql, MSG);
    for (const item of d) {
      expect(item.from).toBeGreaterThanOrEqual(0);
      expect(item.to).toBeLessThanOrEqual(sql.length);
      expect(item.from).toBeLessThanOrEqual(item.to);
      expect(item.severity).toBe("error");
    }
  });

  it("carries the injected (i18n) messages verbatim", () => {
    const custom: SqlLintMessages = { syntaxError: "SYN", unterminated: "UNT" };
    const sql = "SELECT 'x";
    const d = diagnosticsFromTree(parseSqlTree(sql, MySQL), sql, custom);
    expect(d.every((x) => x.message === "SYN" || x.message === "UNT")).toBe(true);
  });
});

describe("computeSqlDiagnostics — dialect awareness", () => {
  it("accepts each driver's valid SQL without diagnostics", () => {
    expect(computeSqlDiagnostics('SELECT "c" FROM t', PostgreSQL, MSG)).toEqual([]);
    expect(computeSqlDiagnostics("SELECT `c` FROM t", MySQL, MSG)).toEqual([]);
    expect(computeSqlDiagnostics("SELECT * FROM t", SQLite, MSG)).toEqual([]);
  });

  it("flags bracket mismatch under every dialect", () => {
    for (const dialect of [MySQL, PostgreSQL, SQLite]) {
      const d = computeSqlDiagnostics("SELECT * FROM t)", dialect, MSG);
      expect(d.length).toBeGreaterThanOrEqual(1);
    }
  });
});
