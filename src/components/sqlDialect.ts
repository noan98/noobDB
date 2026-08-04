import { MySQL, PostgreSQL, SQLite, type SQLDialect } from "@codemirror/lang-sql";

/**
 * Driver-aware SQL dialect helpers shared by the query editor and builder.
 * `driver` is the profile's driver string
 * ("mysql" | "postgres" | "sqlite" | "duckdb"). Unknown values fall back to
 * MySQL behaviour. DuckDB (#709) has no dedicated CodeMirror/sql-formatter
 * dialect, so it is approximated with PostgreSQL's (DuckDB's SQL dialect is
 * deliberately close to PostgreSQL's — double-quoted identifiers, standard
 * string literals, similar keyword set).
 */

/** Identifier quoting: backticks for MySQL, double quotes for Postgres/SQLite/DuckDB. */
export function quoteIdentFor(driver: string, name: string): string {
  if (driver === "postgres" || driver === "sqlite" || driver === "duckdb") {
    return '"' + name.replace(/"/g, '""') + '"';
  }
  return "`" + name.replace(/`/g, "``") + "`";
}

const MYSQL_SYSTEM_DATABASES = new Set([
  "information_schema",
  "performance_schema",
  "mysql",
  "sys",
]);

/**
 * Whether an entry from `listDatabases` is an internal namespace that should
 * not be auto-selected as the builder's default. The Postgres backend lists
 * schemas with system ones already excluded server-side, SQLite exposes a
 * single synthetic database, and DuckDB's default schema is just `"main"`, so
 * only MySQL needs a client-side filter.
 */
export function isSystemDatabase(driver: string, name: string): boolean {
  if (driver === "postgres" || driver === "sqlite" || driver === "duckdb") return false;
  return MYSQL_SYSTEM_DATABASES.has(name.toLowerCase());
}

/** CodeMirror SQL dialect for highlighting and completion. */
export function codeMirrorSqlDialectFor(driver: string): SQLDialect {
  if (driver === "postgres" || driver === "duckdb") return PostgreSQL;
  if (driver === "sqlite") return SQLite;
  return MySQL;
}

/** `sql-formatter` language identifier. */
export function sqlFormatterLanguageFor(driver: string): "mysql" | "postgresql" | "sqlite" {
  if (driver === "postgres" || driver === "duckdb") return "postgresql";
  if (driver === "sqlite") return "sqlite";
  return "mysql";
}
