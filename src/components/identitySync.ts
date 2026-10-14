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
 * SQLite 用: 対象表が AUTOINCREMENT 付きで作られているか (= `sqlite_sequence` に行を持ち得るか)
 * を調べる SELECT。行が返れば同期可能、0 行なら同期対象外。
 */
export function sqliteHasAutoincrementSql(table: string): string {
  return `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${sqlString(table)} AND UPPER(sql) LIKE '%AUTOINCREMENT%'`;
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
 * - SQLite: `UPDATE sqlite_sequence SET seq = MAX(seq, 実データの最大 rowid) WHERE name = 'table'`
 *   (AUTOINCREMENT の表のみ。呼び出し側が `sqliteHasAutoincrementSql` で確認する)。
 */
export function buildIdentitySyncSql(
  driver: string,
  database: string | null,
  table: string,
  column: string,
  maxValue?: string | null,
  opts: IdentitySyncOptions = {},
): string | null {
  const name = qualified(driver, database, table);
  const col = quoteIdentFor(driver, column);
  if (driver === "postgres") {
    const seq = `pg_get_serial_sequence(${sqlString(name)}, ${sqlString(column)})`;
    if (opts.lower) {
      return `SELECT setval(${seq}, COALESCE(MAX(${col}), 1), MAX(${col}) IS NOT NULL) FROM ${name};`;
    }
    // 既定は採番値を下げない: 現在値 (`pg_sequence_last_value`。未使用なら NULL)・実データの最大値・
    // シーケンスの開始値 (`pg_sequence.seqstart`。未使用のシーケンスの下限) の最大へ進める。
    // 次の採番が開始値より手前にならないよう、`is_called` は最大値が開始値以上か、使用済みのときだけ立てる。
    const last = `pg_sequence_last_value(${seq}::regclass)`;
    const start = `COALESCE((SELECT seqstart FROM pg_sequence WHERE seqrelid = ${seq}::regclass), 1)`;
    return (
      `SELECT setval(${seq}, GREATEST(COALESCE(MAX(${col}), 0), COALESCE(${last}, 0), ${start}), ` +
      `COALESCE(MAX(${col}), 0) >= ${start} OR ${last} IS NOT NULL) FROM ${name};`
    );
  }
  if (driver === "sqlite") {
    return (
      // 採番値は下げない (MAX(seq, …))。下げると AUTOINCREMENT の「削除済み ID を再利用しない」
      // 保証が壊れる。
      `UPDATE sqlite_sequence SET seq = MAX(seq, (SELECT COALESCE(MAX(rowid), 0) FROM ${name})) ` +
      `WHERE name = ${sqlString(table)};`
    );
  }
  const max = parseMaxValue(maxValue);
  if (max === null) return null;
  // 現在値が読めなかったときは、黙って下げないために「下げる」を選ばない限り SQL を作らない。
  if (!opts.lower && opts.currentUnknown) return null;
  let next = BigInt(max) < 0n ? 1n : BigInt(max) + 1n;
  if (!opts.lower) {
    const cur = parseMaxValue(opts.currentNext);
    // 現在の AUTO_INCREMENT の方が大きければそれを保つ (下げない)。
    if (cur !== null && opts.currentNext != null && BigInt(cur) > next) next = BigInt(cur);
  }
  return `ALTER TABLE ${name} AUTO_INCREMENT = ${next.toString()};`;
}

/** 採番同期の挙動オプション。 */
export interface IdentitySyncOptions {
  /** true なら現在値より小さくなっても実データの最大値 + 1 にそろえる (従来の挙動)。既定は下げない。 */
  lower?: boolean;
  /** MySQL: 現在の AUTO_INCREMENT (`mysqlShowCreateTableSql` の結果を `parseAutoIncrementFromShowCreate` で読んだもの)。取得できなければ未指定。 */
  currentNext?: string | null;
  /** MySQL: 現在の AUTO_INCREMENT を読めなかった。`lower` でなければ SQL を作らない (`null`)。 */
  currentUnknown?: boolean;
}

/** MySQL 用: 現在の AUTO_INCREMENT を読むための文 (`run_lookup_query` で実行する)。 */
export function mysqlShowCreateTableSql(database: string | null, table: string): string {
  return `SHOW CREATE TABLE ${qualified("mysql", database, table)}`;
}

/**
 * `SHOW CREATE TABLE` の DDL から、表オプションの `AUTO_INCREMENT=N` (= 次に採番される値) を取り出す。
 * `information_schema.TABLES.AUTO_INCREMENT` は統計キャッシュで古いことがあるため、エンジンが返す
 * こちらを使う。次の値が 1 のとき MySQL はこのオプションを出さないので `"1"` を返す。
 * DDL が空・非文字列なら `null` (読めなかった)。
 */
export function parseAutoIncrementFromShowCreate(ddl: unknown): string | null {
  if (typeof ddl !== "string" || ddl.trim() === "") return null;
  // 列定義の `AUTO_INCREMENT` (値なし) とは区別し、`=` つきの最後の出現 (表オプション) を採る。
  const all = [...ddl.matchAll(/\bAUTO_INCREMENT\s*=\s*(\d+)/gi)];
  const last = all[all.length - 1];
  return last ? last[1] : "1";
}
