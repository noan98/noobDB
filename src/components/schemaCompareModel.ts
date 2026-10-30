import type { DiffStatus, SyncPlan, SyncStatement, TableDiff } from "../api/tauri";

/**
 * スキーマ比較画面の純ロジック (一覧の絞り込み・グループ分け・テーブルごとの SQL)。
 *
 * 比較は「更新先 (target) を基準 (source) に合わせる」向きで読む。`DiffStatus` を
 * 更新先で起きる操作に読み替えると、`source_only` = 追加 / `different` = 変更 /
 * `target_only` = 削除 / `same` = 何もしない。画面の並び順・色・記号はすべてこの対応に揃える。
 */

/** 一覧と絞り込みチップの並び順 (変更 → 追加 → 削除 → 同一)。 */
export const DIFF_ACTION_ORDER: readonly DiffStatus[] = ["different", "source_only", "target_only", "same"];

/** 状態ごとの記号。色に頼らずに区別できるよう、色と一緒に必ず出す。 */
export const DIFF_ACTION_GLYPH: Record<DiffStatus, string> = {
  source_only: "+",
  different: "~",
  target_only: "−",
  same: "=",
};

export type DiffFilters = Record<DiffStatus, boolean>;

/** 既定の絞り込み。同一のテーブルだけは隠す (差分を探しに来る画面なので)。 */
export const DEFAULT_DIFF_FILTERS: DiffFilters = {
  different: true,
  source_only: true,
  target_only: true,
  same: false,
};

/** 状態の絞り込みとテーブル名の部分一致 (大小無視) で一覧を絞る。 */
export function filterTables(tables: readonly TableDiff[], filters: DiffFilters, query: string): TableDiff[] {
  const q = query.trim().toLowerCase();
  return tables.filter((tbl) => filters[tbl.status] && (q === "" || tbl.name.toLowerCase().includes(q)));
}

export interface TableGroup {
  status: DiffStatus;
  tables: TableDiff[];
}

/** 状態ごとのグループに分ける (`DIFF_ACTION_ORDER` 順、空のグループは除く)。グループ内は元の順序を保つ。 */
export function groupTables(tables: readonly TableDiff[]): TableGroup[] {
  return DIFF_ACTION_ORDER.map((status) => ({
    status,
    tables: tables.filter((tbl) => tbl.status === status),
  })).filter((g) => g.tables.length > 0);
}

/**
 * 選択中のテーブル名を、表示中の一覧に合わせて解決する。選択が一覧から消えた
 * (絞り込みで隠れた / 再比較で無くなった) ときは先頭のテーブルへ移す。
 */
export function resolveSelectedTable(tables: readonly TableDiff[], selected: string | null): string | null {
  if (selected !== null && tables.some((tbl) => tbl.name === selected)) return selected;
  return tables[0]?.name ?? null;
}

/** テーブル 1 つ分の中の項目 (カラム・インデックス・制約・生成列) を状態ごとに数える。 */
export function countTableItems(table: TableDiff): Record<DiffStatus, number> {
  const c: Record<DiffStatus, number> = { source_only: 0, target_only: 0, different: 0, same: 0 };
  const items: { status: DiffStatus }[] = [
    ...table.columns,
    ...(table.indexes ?? []),
    ...(table.fk_changes ?? []),
    ...(table.check_changes ?? []),
    ...(table.generated_changes ?? []),
  ];
  for (const it of items) c[it.status] += 1;
  return c;
}

/** 生成済みのスキーマ同期 SQL のうち、指定テーブルに対する文 (元の並び順のまま)。 */
export function statementsForTable(plan: SyncPlan | null, table: string): SyncStatement[] {
  if (!plan) return [];
  return plan.statements.filter((s) => s.table === table);
}
