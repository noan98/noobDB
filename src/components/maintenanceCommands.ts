// テーブル保守コマンド (ANALYZE / OPTIMIZE / VACUUM / REINDEX 等) の SQL 生成
// (純ロジック)。#561。
//
// TRUNCATE/DROP/RENAME を扱う tableMaintenance.ts の延長で、統計更新・最適化・
// 再構築・整合性チェックといった「中身は変えずに手入れする」保守系コマンドを
// ドライバ別に組み立てる。実行は既存のクエリ経路 (run_query) を再利用するため、
// ここは副作用の無い純関数に徹し、Vitest でユニットテストする。

import type { I18nKey } from "../i18n";
import { quoteIdentFor } from "./sqlDialect";

/** 保守コマンドの種別。UI 側で i18n ラベル・説明にマップする。 */
export type MaintenanceKind =
  | "analyze"
  | "optimize"
  | "check"
  | "repair"
  | "vacuum"
  | "vacuumAnalyze"
  | "reindex"
  | "refreshMatview"
  | "refreshMatviewConcurrently";

/** 保守種別の表示ラベル (i18n キー)。メニューと確認ダイアログで共有する。 */
export const MAINTENANCE_LABEL_KEYS: Record<MaintenanceKind, I18nKey> = {
  analyze: "maintenanceAnalyze",
  optimize: "maintenanceOptimize",
  check: "maintenanceCheck",
  repair: "maintenanceRepair",
  vacuum: "maintenanceVacuum",
  vacuumAnalyze: "maintenanceVacuumAnalyze",
  reindex: "maintenanceReindex",
  refreshMatview: "maintenanceRefreshMatview",
  refreshMatviewConcurrently: "maintenanceRefreshMatviewConcurrently",
};

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
 * パーティション単位の保守コマンド (#1868)。
 *
 * - PostgreSQL: 子パーティションは通常のテーブルなので `VACUUM (ANALYZE)` / `ANALYZE` / `VACUUM` /
 *   `REINDEX TABLE` を子の完全修飾名に対して流す (サブパーティションの親にも同じ)。
 * - MySQL: `ALTER TABLE <t> ANALYZE | OPTIMIZE | CHECK | REPAIR PARTITION <p>`。
 * - SQLite: パーティション非対応なので空。
 */
export function partitionMaintenanceCommands(
  driver: string,
  database: string | null,
  table: string,
  partition: { name: string; schema?: string | null },
): MaintenanceCommand[] {
  if (driver === "sqlite") return [];
  if (driver === "postgres") {
    return tableMaintenanceCommands(driver, partition.schema ?? database, partition.name);
  }
  const t = qualified(driver, database, table);
  const p = quoteIdentFor(driver, partition.name);
  return [
    { kind: "analyze", sql: `ALTER TABLE ${t} ANALYZE PARTITION ${p};` },
    { kind: "optimize", sql: `ALTER TABLE ${t} OPTIMIZE PARTITION ${p};` },
    { kind: "check", sql: `ALTER TABLE ${t} CHECK PARTITION ${p};` },
    { kind: "repair", sql: `ALTER TABLE ${t} REPAIR PARTITION ${p};` },
  ];
}

/**
 * 複数テーブルへ一括で流せる保守種別 (#1629)。単一テーブルの保守と同じ種別を同じ順序で返す。
 */
export function batchMaintenanceKinds(driver: string): MaintenanceKind[] {
  return tableMaintenanceCommands(driver, null, "t").map((c) => c.kind);
}

/**
 * 複数テーブルへ同じ保守コマンドを流す SQL (#1629)。テーブルごとに 1 文ずつ生成する
 * (失敗したテーブルを特定でき、`VACUUM` のようにトランザクション内で流せない文も
 * 1 文ずつなら実行できる)。ドライバがその種別を持たなければ空配列。
 */
export function batchMaintenanceCommands(
  driver: string,
  database: string | null,
  tables: readonly string[],
  kind: MaintenanceKind,
): { table: string; command: MaintenanceCommand }[] {
  const out: { table: string; command: MaintenanceCommand }[] = [];
  for (const table of tables) {
    const command = tableMaintenanceCommands(driver, database, table).find((c) => c.kind === kind);
    if (!command) return [];
    out.push({ table, command });
  }
  return out;
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

/**
 * PostgreSQL マテリアライズドビューの REFRESH (#1241)。PostgreSQL 以外には
 * マテビューが無いので空を返す。`CONCURRENTLY` はユニークインデックスが前提で、
 * トランザクションブロック内では実行できない。実行経路 (`run_query`) は単文を
 * トランザクションで包まないため、そのまま実行できる。
 */
export function matviewRefreshCommands(
  driver: string,
  database: string | null,
  name: string,
): MaintenanceCommand[] {
  if (driver !== "postgres") return [];
  const target = qualified(driver, database, name);
  return [
    { kind: "refreshMatview", sql: `REFRESH MATERIALIZED VIEW ${target};` },
    { kind: "refreshMatviewConcurrently", sql: `REFRESH MATERIALIZED VIEW CONCURRENTLY ${target};` },
  ];
}
