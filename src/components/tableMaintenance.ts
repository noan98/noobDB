// スキーマツリーからのテーブル保守操作の SQL 生成 (純ロジック)。
//
// TRUNCATE / DROP / RENAME のドライバ別 DDL を組み立てる。識別子クオートは
// sqlDialect.ts を流用。副作用が無いので Vitest でユニットテストする。

import { quoteIdentFor } from "./sqlDialect";

/** 完全修飾したテーブル名 (SQLite はスキーマ非対応なので table のみ)。 */
function qualified(driver: string, database: string | null | undefined, table: string): string {
  if (driver === "sqlite" || !database) return quoteIdentFor(driver, table);
  // MSSQL (#729): 導入は `dbo` スキーマ限定 (`db/mssql.rs` のモジュール doc 参照)
  // のため 3 部構成 `database.dbo.table` が必要 — 無修飾の `database.table` は
  // 不正/曖昧な T-SQL になる。
  if (driver === "mssql") {
    return `${quoteIdentFor(driver, database)}.[dbo].${quoteIdentFor(driver, table)}`;
  }
  return `${quoteIdentFor(driver, database)}.${quoteIdentFor(driver, table)}`;
}

/**
 * TRUNCATE 文。SQLite には TRUNCATE が無いので、等価な `DELETE FROM`
 * (WHERE なし全削除) を生成する。MSSQL は `TRUNCATE TABLE` をそのまま使える。
 */
export function buildTruncateSql(driver: string, database: string | null, table: string): string {
  const name = qualified(driver, database, table);
  if (driver === "sqlite") return `DELETE FROM ${name};`;
  return `TRUNCATE TABLE ${name};`;
}

/** DROP TABLE 文。 */
export function buildDropTableSql(driver: string, database: string | null, table: string): string {
  return `DROP TABLE ${qualified(driver, database, table)};`;
}

/**
 * RENAME 文。`ALTER TABLE ... RENAME TO ...` は MySQL 8 / PostgreSQL / SQLite の
 * すべてで使える。新しい名前はスキーマ非修飾 (同じスキーマ内での改名)。
 *
 * MSSQL には `RENAME TO` が無く、代わりに `sp_rename` システムストアド
 * プロシージャを使う。第 1 引数はオブジェクト名の文字列 (現在のデータベース
 * コンテキスト内で解決されるため `dbo.table` の 2 部構成、データベース名は
 * 含めない) で、第 2 引数は非修飾の新テーブル名。
 */
export function buildRenameTableSql(
  driver: string,
  database: string | null,
  table: string,
  newName: string,
): string {
  if (driver === "mssql") {
    const objName = `dbo.${table}`.replace(/'/g, "''");
    const to = newName.replace(/'/g, "''");
    return `EXEC sp_rename '${objName}', '${to}';`;
  }
  const from = qualified(driver, database, table);
  const to = quoteIdentFor(driver, newName);
  return `ALTER TABLE ${from} RENAME TO ${to};`;
}

/**
 * インデックス名候補から、識別子として扱いづらい文字を `_` に畳む。クオートは
 * 呼び出し側が行うので、ここでは可読性のための正規化のみ。バックエンドの
 * `db/advisor.rs::sanitize_index_name` (アドバイザの自動修正 DDL が使う) と同じ規則。
 */
function sanitizeIndexName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "_");
}

/**
 * `CREATE [UNIQUE] INDEX` 文を生成する (#850)。方言差は `db/advisor.rs::create_index_ddl`
 * の移植。インデックス名を指定しなければ `idx_<table>_<col1>_<col2>...` を自動生成する。
 * 空の列名は無視する。
 */
export function buildCreateIndexSql(
  driver: string,
  database: string | null,
  table: string,
  columns: string[],
  opts: { name?: string; unique?: boolean } = {},
): string {
  const cols = columns.map((c) => c.trim()).filter((c) => c.length > 0);
  const rawName = opts.name?.trim() || `idx_${table}_${cols.join("_")}`;
  const idxName = sanitizeIndexName(rawName);
  const colList = cols.map((c) => quoteIdentFor(driver, c)).join(", ");
  const keyword = opts.unique ? "CREATE UNIQUE INDEX" : "CREATE INDEX";
  return `${keyword} ${quoteIdentFor(driver, idxName)} ON ${qualified(driver, database, table)} (${colList});`;
}

/**
 * 方言別の `DROP INDEX` (#850)。MySQL / MSSQL は `DROP INDEX <name> ON <table>`
 * (テーブル修飾が必須)、PostgreSQL / SQLite / DuckDB は `DROP INDEX <name>`
 * (テーブル指定不可)。`db/advisor.rs::drop_index_ddl` と同じ方言分岐の移植。
 */
export function buildDropIndexSql(
  driver: string,
  database: string | null,
  table: string,
  indexName: string,
): string {
  if (driver === "mysql" || driver === "mssql") {
    return `DROP INDEX ${quoteIdentFor(driver, indexName)} ON ${qualified(driver, database, table)};`;
  }
  return `DROP INDEX ${quoteIdentFor(driver, indexName)};`;
}
