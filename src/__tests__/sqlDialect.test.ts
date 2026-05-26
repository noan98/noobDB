import { describe, it, expect } from "vitest";
import { MySQL, PostgreSQL, SQLite } from "@codemirror/lang-sql";
import {
  codeMirrorSqlDialectFor,
  isSystemDatabase,
  quoteIdentFor,
  sqlFormatterLanguageFor,
} from "../components/sqlDialect";

describe("quoteIdentFor", () => {
  it("uses backticks for MySQL and unknown drivers", () => {
    expect(quoteIdentFor("mysql", "col")).toBe("`col`");
    expect(quoteIdentFor("weird", "col")).toBe("`col`");
  });

  it("uses double quotes for Postgres and SQLite", () => {
    expect(quoteIdentFor("postgres", "col")).toBe('"col"');
    expect(quoteIdentFor("sqlite", "col")).toBe('"col"');
  });

  it("escapes the quoting character by doubling it", () => {
    expect(quoteIdentFor("mysql", "a`b")).toBe("`a``b`");
    expect(quoteIdentFor("postgres", 'a"b')).toBe('"a""b"');
  });
});

describe("isSystemDatabase", () => {
  it("flags MySQL system schemas case-insensitively", () => {
    expect(isSystemDatabase("mysql", "information_schema")).toBe(true);
    expect(isSystemDatabase("mysql", "MySQL")).toBe(true);
    expect(isSystemDatabase("mysql", "sys")).toBe(true);
  });

  it("does not flag ordinary MySQL databases", () => {
    expect(isSystemDatabase("mysql", "app_db")).toBe(false);
  });

  it("never flags Postgres or SQLite (filtered elsewhere)", () => {
    expect(isSystemDatabase("postgres", "information_schema")).toBe(false);
    expect(isSystemDatabase("sqlite", "main")).toBe(false);
  });
});

describe("sqlFormatterLanguageFor", () => {
  it("maps drivers to sql-formatter language ids", () => {
    expect(sqlFormatterLanguageFor("postgres")).toBe("postgresql");
    expect(sqlFormatterLanguageFor("sqlite")).toBe("sqlite");
    expect(sqlFormatterLanguageFor("mysql")).toBe("mysql");
    expect(sqlFormatterLanguageFor("unknown")).toBe("mysql");
  });
});

describe("codeMirrorSqlDialectFor", () => {
  it("selects the matching CodeMirror dialect, defaulting to MySQL", () => {
    expect(codeMirrorSqlDialectFor("postgres")).toBe(PostgreSQL);
    expect(codeMirrorSqlDialectFor("sqlite")).toBe(SQLite);
    expect(codeMirrorSqlDialectFor("mysql")).toBe(MySQL);
    expect(codeMirrorSqlDialectFor("unknown")).toBe(MySQL);
  });
});
