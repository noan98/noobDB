// 採番列 (PostgreSQL の serial/identity・MySQL の AUTO_INCREMENT・SQLite の
// AUTOINCREMENT) の現在値を実データの最大値に同期する SQL 生成 (純ロジック)。#1240。
//
// 明示的な PK 値つきでインポート・転送・手動 INSERT をすると、採番カウンタが最大値より
// 小さいまま残り、次の自動採番 INSERT が重複キーエラーになる。ここでは対象列の判定と
// 同期 SQL の組み立てだけを担い、実行は既存の保守コマンド経路 (`runMaintenanceDdl`) に
// 任せる。副作用は無く Vitest でユニットテストする。

import { quoteIdentFor } from "./sqlDialect";
import type { TableColumnInfo } from "../api/tauri";

/** 完全修飾したテーブル名 (SQLite はスキーマ非対応なので table のみ)。 */
function qualified(driver: string, database: string | null | undefined, table: string): string {
  if (driver === "sqlite" || !database) return quoteIdentFor(driver, table);
  return `${quoteIdentFor(driver, database)}.${quoteIdentFor(driver, table)}`;
}

/** SQL 文字列リテラル (シングルクォートを二重化)。 */
function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const PG_INTEGER_TYPES = /^(smallint|integer|bigint|int2|int4|int8|smallserial|serial|bigserial)$/i;

/**
 * 採番同期の対象列を判定する。該当が無ければ `null` (メニューを出さない)。
 *
 * - MySQL: `extra` に `auto_increment` を含む列 (AUTO_INCREMENT は表に 1 列のみ)。
 * - PostgreSQL: 単一列 PK の整数列。serial は既定値が `nextval(...)` だが identity は
 *   既定値が空で `describe_table` からは見分けられないため、整数の単一列 PK を候補にする。
 *   実際にシーケンスが無い列でも `pg_get_serial_sequence` が NULL を返すだけで無害。
 * - SQLite: 単一列 PK の `INTEGER` 列 (rowid の別名)。AUTOINCREMENT 指定の有無は
 *   列メタから分からないが、生成する UPDATE は `sqlite_sequence` に行があるときだけ効く。
 */
export function findIdentityColumn(driver: string, columns: TableColumnInfo[]): string | null {
  if (driver === "sqlite" || driver === "postgres") {
    const pks = columns.filter((c) => c.key === "PRI");
    if (pks.length !== 1) return null;
    const pk = pks[0];
    const type = pk.data_type.trim();
    if (driver === "sqlite") return /^integer$/i.test(type) ? pk.name : null;
    const serialDefault = (pk.default ?? "").toLowerCase().startsWith("nextval(");
    return serialDefault || PG_INTEGER_TYPES.test(type) ? pk.name : null;
  }
  const auto = columns.find((c) => /auto_increment/i.test(c.extra));
  return auto ? auto.name : null;
}

/** MySQL 用: 採番列の最大値を問い合わせる SELECT (`run_lookup_query` で実行する)。 */
export function mysqlMaxValueSql(database: string | null, table: string, column: string): string {
  return `SELECT MAX(${quoteIdentFor("mysql", column)}) FROM ${qualified("mysql", database, table)}`;
}

/**
 * `run_lookup_query` が返した MAX セルを、JS の number で丸めない 10 進整数の
 * 文字列に正規化する。空テーブル (NULL) は `"0"`、整数として解釈できない値は `null`。
 */
export function parseMaxValue(cell: unknown): string | null {
  if (cell === null || cell === undefined) return "0";
  if (typeof cell === "number") return Number.isSafeInteger(cell) ? String(cell) : null;
  if (typeof cell === "string" && /^-?\d+$/.test(cell.trim())) {
    return BigInt(cell.trim()).toString();
  }
  return null;
}

/**
 * 採番同期 SQL を生成する。
 *
 * - PostgreSQL: `setval(pg_get_serial_sequence(...), COALESCE(MAX(col), 1), MAX(col) IS NOT NULL)`。
 *   空テーブルは `is_called = false` にして次の採番が 1 から始まるようにする。
 * - MySQL: `ALTER TABLE ... AUTO_INCREMENT = N`。`AUTO_INCREMENT` にサブクエリは書けない
 *   ので、`maxValue` (事前に `mysqlMaxValueSql` で取得した最大値) から N = max+1 を
 *   BigInt で計算してリテラルで埋める。`maxValue` が整数でなければ `null` を返す。
 * - SQLite: `UPDATE sqlite_sequence SET seq = ... WHERE name = 'table'`。
 */
export function buildIdentitySyncSql(
  driver: string,
  database: string | null,
  table: string,
  column: string,
  maxValue?: string | null,
): string | null {
  const name = qualified(driver, database, table);
  const col = quoteIdentFor(driver, column);
  if (driver === "postgres") {
    const seqTarget = sqlString(name);
    return (
      `SELECT setval(pg_get_serial_sequence(${seqTarget}, ${sqlString(column)}), ` +
      `COALESCE(MAX(${col}), 1), MAX(${col}) IS NOT NULL) FROM ${name};`
    );
  }
  if (driver === "sqlite") {
    return (
      `UPDATE sqlite_sequence SET seq = (SELECT COALESCE(MAX(rowid), 0) FROM ${name}) ` +
      `WHERE name = ${sqlString(table)};`
    );
  }
  const max = parseMaxValue(maxValue);
  if (max === null) return null;
  const next = BigInt(max) < 0n ? 1n : BigInt(max) + 1n;
  return `ALTER TABLE ${name} AUTO_INCREMENT = ${next.toString()};`;
}
