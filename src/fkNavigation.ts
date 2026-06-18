// 外部キーをたどるリレーションナビゲーション (#621) の純ロジック。
//
// 結果グリッドの FK セルから「参照先テーブルの該当行」へジャンプする SQL と、
// その逆 (この行を参照している子テーブルの行一覧) を辿る SQL を、方言ごとに
// 安全にクオート・エスケープして生成する。識別子のクオートは `sqlDialect.ts`、
// 値のリテラル化は `cellEdit.ts` の既存方針を踏襲し、二重定義しない。副作用なし。

import type { CellValue, ForeignKey } from "./api/tauri";
import { literalFromCellValue } from "./components/cellEdit";
import { quoteIdentFor } from "./components/sqlDialect";

/**
 * テーブル参照を必要なら `database`.`table` で修飾する。SQLite はデータベース
 * 修飾子を持たず、`database` が空のときも修飾しない (既存のジャンプ SQL 生成と
 * 同じ判定)。
 */
function qualifiedTable(
  driver: string,
  database: string | null | undefined,
  table: string,
): string {
  if (driver === "sqlite" || !database) return quoteIdentFor(driver, table);
  return `${quoteIdentFor(driver, database)}.${quoteIdentFor(driver, table)}`;
}

/** `column` を `value` に一致させる述語を NULL 安全に生成する。 */
function matchPredicate(driver: string, column: string, value: CellValue): string {
  if (value === null || value === undefined) {
    return `${quoteIdentFor(driver, column)} IS NULL`;
  }
  return `${quoteIdentFor(driver, column)} = ${literalFromCellValue(driver, value)}`;
}

export interface FkJumpParams {
  driver: string;
  database?: string | null;
  /** 参照先テーブル。 */
  refTable: string;
  /** 参照先テーブルのカラム (通常は PK)。 */
  refColumn: string;
  /** ジャンプ元セルの値。 */
  value: CellValue;
}

/**
 * 順方向ジャンプ: FK 値で参照先テーブルを絞り込んで開く SQL を生成する。
 * 例: `user_id` のセル → `SELECT * FROM users WHERE id = 42`。
 */
export function buildFkJumpSql(p: FkJumpParams): string {
  return `SELECT * FROM ${qualifiedTable(p.driver, p.database, p.refTable)} WHERE ${matchPredicate(
    p.driver,
    p.refColumn,
    p.value,
  )}`;
}

/** 現在のテーブルを参照している子テーブル側の FK 1 件 (逆参照)。 */
export interface IncomingFk {
  /** FK を持つ子テーブル。 */
  table: string;
  /** 現在のテーブルを参照している子テーブルのカラム。 */
  column: string;
  /** 子テーブルが指す、現在 (参照先) テーブル側のカラム。 */
  referencedColumn: string;
}

/**
 * `table` を参照している外部キー (逆参照) を抽出する。参照先カラムが不明な
 * エントリは結合キーを解決できないため除外する。
 */
export function incomingForeignKeys(all: ForeignKey[], table: string): IncomingFk[] {
  const out: IncomingFk[] = [];
  for (const fk of all) {
    if (fk.referenced_table !== table || !fk.referenced_column) continue;
    out.push({
      table: fk.table,
      column: fk.column,
      referencedColumn: fk.referenced_column,
    });
  }
  return out;
}

export interface ReverseRefParams {
  driver: string;
  database?: string | null;
  /** FK を持つ子テーブル。 */
  childTable: string;
  /** この行を参照している子テーブルのカラム。 */
  childColumn: string;
  /** 現在の行が持つ、参照されているキー値。 */
  value: CellValue;
}

/**
 * 逆方向ジャンプ: この行のキー値を参照している子テーブルの行一覧を出す SQL を
 * 生成する。例: `users.id = 42` の行 → `SELECT * FROM orders WHERE user_id = 42`。
 */
export function buildReverseRefSql(p: ReverseRefParams): string {
  return `SELECT * FROM ${qualifiedTable(p.driver, p.database, p.childTable)} WHERE ${matchPredicate(
    p.driver,
    p.childColumn,
    p.value,
  )}`;
}
