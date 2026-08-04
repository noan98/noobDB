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
