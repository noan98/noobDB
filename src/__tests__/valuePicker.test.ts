import { describe, expect, it } from "vitest";
import type { TableColumnInfo } from "../api/tauri";
import { isReadOnlySql } from "../dangerousSql";
import {
  allowedValuesFromCheck,
  allowedValuesFromType,
  buildAllowedValuesQueries,
  buildFkCandidatesSql,
  candidatesFromResult,
  collectAllowedValues,
  fkSearchTerm,
  pickerKindFor,
} from "../components/valuePicker";

const DRIVERS = ["mysql", "postgres", "sqlite", "duckdb", "mssql"] as const;

function col(name: string, dataType: string, fk?: [string, string]): TableColumnInfo {
  return {
    name,
    data_type: dataType,
    nullable: true,
    key: "",
    default: null,
    extra: "",
    referenced_table: fk?.[0] ?? null,
    referenced_column: fk?.[1] ?? null,
  };
}

describe("buildFkCandidatesSql (#1067)", () => {
  it("MySQL: backtick-quoted, qualified, DISTINCT + NOT NULL + LIMIT", () => {
    expect(
      buildFkCandidatesSql({ driver: "mysql", database: "shop", refTable: "users", refColumn: "id" }),
    ).toBe(
      "SELECT DISTINCT `id` FROM `shop`.`users` WHERE `id` IS NOT NULL ORDER BY `id` LIMIT 50",
    );
  });

  it("MSSQL uses TOP instead of LIMIT and the dbo-qualified 3-part name", () => {
    expect(
      buildFkCandidatesSql({
        driver: "mssql",
        database: "app",
        refTable: "users",
        refColumn: "id",
        limit: 10,
      }),
    ).toBe(
      "SELECT DISTINCT TOP (10) [id] FROM [app].[dbo].[users] WHERE [id] IS NOT NULL ORDER BY [id]",
    );
  });

  it("SQLite ignores the synthetic database label", () => {
    expect(
      buildFkCandidatesSql({ driver: "sqlite", database: "main", refTable: "t", refColumn: "c" }),
    ).toBe('SELECT DISTINCT "c" FROM "t" WHERE "c" IS NOT NULL ORDER BY "c" LIMIT 50');
  });

  it("prefix search escapes LIKE wildcards and quotes per dialect", () => {
    const pg = buildFkCandidatesSql({
      driver: "postgres",
      database: "public",
      refTable: "users",
      refColumn: "code",
      search: "a_b%'c",
    });
    expect(pg).toContain(`CAST("code" AS TEXT) LIKE 'a\\_b\\%''c%' ESCAPE '\\'`);
    // MySQL は文字列内のバックスラッシュ自体もエスケープする (quoteString の規約)。
    const my = buildFkCandidatesSql({
      driver: "mysql",
      refTable: "users",
      refColumn: "code",
      search: "a_b",
    });
    expect(my).toContain("CAST(`code` AS CHAR) LIKE 'a\\\\_b%' ESCAPE '\\\\'");
    expect(my).toContain("FROM `users`");
    const ms = buildFkCandidatesSql({
      driver: "mssql",
      refTable: "users",
      refColumn: "code",
      search: "x",
    });
    expect(ms).toContain("CAST([code] AS NVARCHAR(4000)) LIKE N'x%' ESCAPE N'\\'");
    const duck = buildFkCandidatesSql({ driver: "duckdb", refTable: "t", refColumn: "c", search: "1" });
    expect(duck).toContain(`CAST("c" AS VARCHAR) LIKE '1%'`);
  });

  it("clamps the limit to at least 1 and quotes hostile identifiers", () => {
    const sql = buildFkCandidatesSql({
      driver: "postgres",
      refTable: 'we"ird',
      refColumn: "i d",
      limit: 0,
    });
    expect(sql).toBe(
      'SELECT DISTINCT "i d" FROM "we""ird" WHERE "i d" IS NOT NULL ORDER BY "i d" LIMIT 1',
    );
  });

  it("is always classified read-only (backend lookup guard would reject otherwise)", () => {
    for (const driver of DRIVERS) {
      const sql = buildFkCandidatesSql({
        driver,
        database: "db",
        refTable: "users",
        refColumn: "id",
        search: "x'; DROP TABLE users; --",
      });
      expect(isReadOnlySql(sql, driver)).toBe(true);
    }
  });
});

describe("buildAllowedValuesQueries (#1067)", () => {
  it("emits a read-only query set for every driver", () => {
    for (const driver of DRIVERS) {
      const qs = buildAllowedValuesQueries(driver, "db", "t'x");
      expect(qs.length).toBeGreaterThan(0);
      for (const q of qs) expect(isReadOnlySql(q.sql, driver)).toBe(true);
    }
  });

  it("PostgreSQL fetches user-defined ENUM labels and CHECK definitions", () => {
    const qs = buildAllowedValuesQueries("postgres", "public", "orders");
    expect(qs.map((q) => q.purpose)).toEqual(["pgEnum", "check"]);
    expect(qs[0].sql).toContain("pg_catalog.pg_enum");
    expect(qs[0].sql).toContain("n.nspname = 'public' AND c.relname = 'orders'");
    expect(qs[1].sql).toContain("pg_get_constraintdef");
  });

  it("falls back to the session's current schema / database when none is given", () => {
    expect(buildAllowedValuesQueries("postgres", null, "t")[0].sql).toContain("current_schema()");
    expect(buildAllowedValuesQueries("mysql", null, "t")[0].sql).toContain("DATABASE()");
    expect(buildAllowedValuesQueries("mssql", null, "t")[0].sql).toContain("FROM sys.check_constraints");
  });

  it("escapes names as string literals (no injection through table names)", () => {
    const sql = buildAllowedValuesQueries("sqlite", "main", "a'b")[0].sql;
    expect(sql).toBe("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'a''b'");
    const ms = buildAllowedValuesQueries("mssql", "my]db", "t")[0].sql;
    expect(ms).toContain("[my]]db].sys.check_constraints");
  });

  it("unknown drivers produce no queries", () => {
    expect(buildAllowedValuesQueries("oracle", "x", "t")).toEqual([]);
  });
});

describe("allowedValuesFromType (#1067)", () => {
  it("parses MySQL ENUM / SET including doubled quotes and commas", () => {
    expect(allowedValuesFromType("mysql", "enum('a','b''c','x,y')")).toEqual({
      kind: "enum",
      values: ["a", "b'c", "x,y"],
    });
    expect(allowedValuesFromType("mysql", "set('r','w','x')")).toEqual({
      kind: "set",
      values: ["r", "w", "x"],
    });
  });

  it("parses DuckDB ENUM types", () => {
    expect(allowedValuesFromType("duckdb", "ENUM('sad', 'ok', 'happy')")).toEqual({
      kind: "enum",
      values: ["sad", "ok", "happy"],
    });
  });

  it("ignores ordinary types and SET outside MySQL", () => {
    expect(allowedValuesFromType("mysql", "varchar(20)")).toBeNull();
    expect(allowedValuesFromType("postgres", "USER-DEFINED")).toBeNull();
    expect(allowedValuesFromType("duckdb", "set('a')")).toBeNull();
    expect(allowedValuesFromType("mysql", "enum()")).toBeNull();
  });
});

describe("allowedValuesFromCheck (#1067)", () => {
  it("PostgreSQL: = ANY (ARRAY[...]) with casts, including varchar casts", () => {
    expect(
      allowedValuesFromCheck(
        "postgres",
        ["CHECK ((status = ANY (ARRAY['draft'::text, 'sent'::text])))"],
        "status",
      ),
    ).toEqual(["draft", "sent"]);
    expect(
      allowedValuesFromCheck(
        "postgres",
        [
          "CHECK (((kind)::text = ANY ((ARRAY['a'::character varying, 'b''c'::character varying])::text[])))",
        ],
        "kind",
      ),
    ).toEqual(["a", "b'c"]);
  });

  it("PostgreSQL: IN list and numeric literals (negative numbers too)", () => {
    expect(allowedValuesFromCheck("postgres", ["CHECK ((prio IN (1, 2, -3)))"], "prio")).toEqual([
      "1",
      "2",
      "-3",
    ]);
  });

  it("MSSQL: OR chain of equalities with N-prefixed literals", () => {
    expect(
      allowedValuesFromCheck("mssql", ["([status]=N'b' OR [status]=N'a' OR [status]='c')"], "status"),
    ).toEqual(["b", "a", "c"]);
  });

  it("MySQL: charset introducers, and the backslash-quoted variant some 8.0 builds return", () => {
    expect(
      allowedValuesFromCheck("mysql", ["(`size` in (_utf8mb4'S',_utf8mb4'M',_utf8mb4'L'))"], "size"),
    ).toEqual(["S", "M", "L"]);
    expect(
      allowedValuesFromCheck("mysql", ["(`size` in (_utf8mb4\\'S\\',_utf8mb4\\'M\\'))"], "size"),
    ).toEqual(["S", "M"]);
    // MySQL 文字列内のバックスラッシュエスケープを解釈する。
    expect(allowedValuesFromCheck("mysql", ["(`p` in ('a\\'b','c'))"], "p")).toEqual(["a'b", "c"]);
  });

  it("SQLite: extracts column and table CHECKs from the whole CREATE TABLE", () => {
    const ddl =
      "CREATE TABLE t (id INTEGER PRIMARY KEY, color TEXT CHECK (color IN ('red','green')), " +
      "[size] TEXT, n INT CHECK (n > 0), CHECK ([size] = 'S' OR 'L' = [size]))";
    expect(allowedValuesFromCheck("sqlite", [ddl], "color")).toEqual(["red", "green"]);
    expect(allowedValuesFromCheck("sqlite", [ddl], "size")).toEqual(["S", "L"]);
    expect(allowedValuesFromCheck("sqlite", [ddl], "n")).toBeNull();
    expect(allowedValuesFromCheck("sqlite", [ddl], "id")).toBeNull();
  });

  it("DuckDB constraint_text form", () => {
    expect(allowedValuesFromCheck("duckdb", ["CHECK((mood IN ('a', 'b')))"], "mood")).toEqual([
      "a",
      "b",
    ]);
  });

  it("matches column names case-insensitively and de-duplicates", () => {
    expect(allowedValuesFromCheck("postgres", ["CHECK ((Status IN ('a','a','b')))"], "status")).toEqual([
      "a",
      "b",
    ]);
  });

  it("does not turn non-enumerations into candidates", () => {
    const cases = [
      "CHECK ((status NOT IN ('x', 'y')))",
      "CHECK ((NOT (status IN ('x'))))",
      "CHECK ((qty BETWEEN 1 AND 5))",
      "CHECK ((status = 'a' OR other = 'b'))",
      "CHECK ((status = 'a' AND status = 'b'))",
      "CHECK ((lower(status) IN ('a')))",
      "CHECK ((status IN ('a', other_col)))",
      "CHECK ((status <> 'a'))",
    ];
    for (const c of cases) {
      expect(allowedValuesFromCheck("postgres", [c], "status"), c).toBeNull();
    }
  });

  it("uses the first constraint that yields values", () => {
    expect(
      allowedValuesFromCheck(
        "postgres",
        ["CHECK ((status <> ''::text))", "CHECK ((status = ANY (ARRAY['a'::text])))"],
        "status",
      ),
    ).toEqual(["a"]);
  });
});

describe("collectAllowedValues / pickerKindFor (#1067)", () => {
  const cols = [
    col("id", "bigint"),
    col("mood", "USER-DEFINED"),
    col("state", "text"),
    col("user_id", "bigint", ["users", "id"]),
    col("kind", "enum('a','b')"),
  ];

  it("merges type-derived, pg_enum and CHECK values with type > enum > CHECK precedence", () => {
    const map = collectAllowedValues(
      "postgres",
      cols,
      [
        ["mood", "sad"],
        ["mood", "happy"],
        [null, "ignored"],
      ],
      ["CHECK ((state IN ('open','closed')))", "CHECK ((mood IN ('x')))"],
    );
    expect(map.get("mood")).toEqual({ kind: "enum", values: ["sad", "happy"] });
    expect(map.get("state")).toEqual({ kind: "check", values: ["open", "closed"] });
    expect(map.get("kind")).toEqual({ kind: "enum", values: ["a", "b"] });
    expect(map.has("id")).toBe(false);
    expect(map.has("user_id")).toBe(false);
  });

  it("degrades silently when the metadata queries failed (only type-derived values)", () => {
    const map = collectAllowedValues("mysql", [col("kind", "set('r','w')"), col("c", "int")]);
    expect([...map.keys()]).toEqual(["kind"]);
  });

  it("picker kind: allowed values win over FK, FK needs a referenced column", () => {
    expect(pickerKindFor(cols[3], undefined)).toBe("fk");
    expect(pickerKindFor(cols[3], { kind: "check", values: ["1"] })).toBe("check");
    expect(pickerKindFor(col("x", "int", ["users", ""]), undefined)).toBeNull();
    expect(pickerKindFor(cols[0], { kind: "enum", values: [] })).toBeNull();
    expect(pickerKindFor(undefined, undefined)).toBeNull();
  });
});

describe("candidatesFromResult / fkSearchTerm (#1067)", () => {
  it("stringifies the first column, drops NULL and duplicates, keeps 64-bit strings lossless", () => {
    expect(
      candidatesFromResult({
        rows: [["9007199254740993"], [null], [42], ["9007199254740993"], [true]],
      }),
    ).toEqual(["9007199254740993", "42", "true"]);
  });

  it("does not search for the NULL keyword itself", () => {
    expect(fkSearchTerm("  ab ")).toBe("ab");
    expect(fkSearchTerm("NULL")).toBe("");
    expect(fkSearchTerm("nu")).toBe("nu");
    expect(fkSearchTerm("")).toBe("");
  });
});
