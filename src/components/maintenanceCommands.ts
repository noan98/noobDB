// テーブル保守コマンド (ANALYZE / OPTIMIZE / VACUUM / REINDEX 等) の SQL 生成
// (純ロジック)。#561。
//
// TRUNCATE/DROP/RENAME を扱う tableMaintenance.ts の延長で、統計更新・最適化・
// 再構築・整合性チェックといった「中身は変えずに手入れする」保守系コマンドを
// ドライバ別に組み立てる。実行は既存のクエリ経路 (run_query) を再利用するため、
// ここは副作用の無い純関数に徹し、Vitest でユニットテストする。

import { quoteIdentFor } from "./sqlDialect";

/** 保守コマンドの種別。UI 側で i18n ラベル・説明にマップする。 */
export type MaintenanceKind =
  | "analyze"
  | "optimize"
  | "check"
  | "repair"
  | "vacuum"
  | "vacuumAnalyze"
  | "reindex";

/** 1 つの保守コマンド: 種別と、そのまま実行できる生成済み SQL。 */
export interface MaintenanceCommand {
  kind: MaintenanceKind;
  sql: string;
}

/** 完全修飾したテーブル名 (SQLite はスキーマ非対応なので table のみ)。 */
function qualified(driver: string, database: string | null | undefined, table: string): string {
  if (driver === "sqlite" || !database) return quoteIdentFor(driver, table);
  return `${quoteIdentFor(driver, database)}.${quoteIdentFor(driver, table)}`;
}

/**
 * 指定テーブルに対して、そのドライバで利用可能な保守コマンドを生成する。
 *
 * - MySQL: `ANALYZE` / `OPTIMIZE` / `CHECK` / `REPAIR TABLE`
 * - PostgreSQL: `VACUUM` / `VACUUM (ANALYZE)` / `ANALYZE` / `REINDEX TABLE`
 * - SQLite: `ANALYZE` / `REINDEX` (テーブル単位。VACUUM は DB 全体なので
 *   [`databaseMaintenanceCommands`] 側で扱う)
 *
 * 返す順序は「日常的に使う頻度が高いものを先頭」にしている。
 */
export function tableMaintenanceCommands(
  driver: string,
  database: string | null,
  table: string,
): MaintenanceCommand[] {
  const name = qualified(driver, database, table);
  if (driver === "postgres") {
    return [
      { kind: "vacuumAnalyze", sql: `VACUUM (ANALYZE) ${name};` },
      { kind: "analyze", sql: `ANALYZE ${name};` },
      { kind: "vacuum", sql: `VACUUM ${name};` },
      { kind: "reindex", sql: `REINDEX TABLE ${name};` },
    ];
  }
  if (driver === "sqlite") {
    return [
      { kind: "analyze", sql: `ANALYZE ${name};` },
      { kind: "reindex", sql: `REINDEX ${name};` },
    ];
  }
  // MySQL (および未知ドライバは MySQL 互換として扱う)
  return [
    { kind: "analyze", sql: `ANALYZE TABLE ${name};` },
    { kind: "optimize", sql: `OPTIMIZE TABLE ${name};` },
    { kind: "check", sql: `CHECK TABLE ${name};` },
    { kind: "repair", sql: `REPAIR TABLE ${name};` },
  ];
}

/**
 * データベース (スキーマ) 全体に対する保守コマンド。SQLite の `VACUUM` /
 * `ANALYZE` / `REINDEX` は対象を取らず DB 全体に効く。PostgreSQL は対象なしの
 * `VACUUM` / `ANALYZE` が現在のデータベース全体を処理する。MySQL にはテーブルを
 * 取らないグローバル保守文が無いため空を返す。
 */
export function databaseMaintenanceCommands(driver: string): MaintenanceCommand[] {
  if (driver === "sqlite") {
    return [
      { kind: "vacuum", sql: `VACUUM;` },
      { kind: "analyze", sql: `ANALYZE;` },
      { kind: "reindex", sql: `REINDEX;` },
    ];
  }
  if (driver === "postgres") {
    return [
      { kind: "vacuumAnalyze", sql: `VACUUM (ANALYZE);` },
      { kind: "analyze", sql: `ANALYZE;` },
      { kind: "vacuum", sql: `VACUUM;` },
    ];
  }
  return [];
}
