// 実行結果を新規テーブルへ保存 (CREATE TABLE ... AS SELECT、#821) の純ロジック。
//
// エディタで実行した「結果セットを返す単一クエリ」から、同一接続内で完結する
// `CREATE TABLE <名前> AS <クエリ>` を組み立てる。3 方言 (MySQL/PostgreSQL/SQLite)
// とも標準 CTAS 構文をサポートするため、識別子クオート以外の方言差は無い
// (`tableMaintenance.ts` / `createTable.ts` と同じ `qualified` パターン)。
//
// 対象クエリの判定はベストエフォート (パーサではない) で、`dangerousSql.ts` と
// 同じ「コメント/文字列リテラルをマスクしてから先頭キーワードを見る」方式を踏襲する。
// バックエンドの `is_read_only_sql` が実行時に最終防波堤として効くため、ここでの
// 判定をすり抜けても書き込みが素通りすることはない — 目的は UI 上で無意味な
// 導線 (非 SELECT・複数文) を早めに隠すこと。

import { maskLiterals } from "../dangerousSql";
import { quoteIdentFor } from "./sqlDialect";

/**
 * `sql` が単一の `SELECT` / `WITH ...` 文であり、CTAS のソースとして妥当かを判定する。
 * `SHOW` / `DESCRIBE` / `EXPLAIN` は読み取り専用だが `CREATE TABLE ... AS` の
 * ソースにはなれないため対象外。スタック文 (末尾以外に `;` を含む) も拒否する。
 *
 * `driver` は `maskLiterals` の文字列エスケープ規則を選ぶ (#852、#1004)。省略時は
 * 保守的な非 MySQL 解釈になる。
 */
export function isCtasEligibleSql(sql: string, driver?: string): boolean {
  const masked = maskLiterals(sql, driver);
  const body = masked.trim().replace(/;\s*$/, "");
  if (!body) return false;
  // 末尾の 1 個を剥がした後にまだ `;` が残っていれば、隠れた 2 文目がある。
  if (body.includes(";")) return false;
  const lower = body.toLowerCase();
  return /^select\b/.test(lower) || /^with\b/.test(lower);
}

/** 完全修飾したテーブル名 (SQLite はスキーマ非対応なので table のみ)。 */
function qualified(driver: string, database: string | null | undefined, table: string): string {
  if (driver === "sqlite" || !database) return quoteIdentFor(driver, table);
  return `${quoteIdentFor(driver, database)}.${quoteIdentFor(driver, table)}`;
}

/**
 * `CREATE TABLE <name> AS <sourceSql>` 文を生成する。`sourceSql` 末尾の
 * セミコロン/空白は剥がし、生成した文の末尾にだけ 1 つ付与する
 * (呼び出し元の SQL をそのまま連結して二重セミコロンにならないようにする)。
 */
export function buildCreateTableAsSql(
  driver: string,
  database: string | null,
  table: string,
  sourceSql: string,
): string {
  const name = qualified(driver, database, table);
  const query = sourceSql.trim().replace(/;\s*$/, "");
  return `CREATE TABLE ${name} AS\n${query};`;
}

/**
 * `name` (トリム後) が `existingTables` のいずれかと大小無視で一致するか。
 * 空文字は「未入力」であって衝突ではないので false を返す。
 */
export function tableNameCollides(existingTables: string[], name: string): boolean {
  const trimmed = name.trim().toLowerCase();
  if (!trimmed) return false;
  return existingTables.some((t) => t.toLowerCase() === trimmed);
}
