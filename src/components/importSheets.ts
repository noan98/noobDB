// xlsx の複数シート一括取り込み (#1623) の純ロジック。シートごとの取り込み先テーブル名の
// 提案と、実行前の検証 (空・長さ・既存テーブルとの衝突・シート間の重複)。

import type { DriverKind, ImportOptions, NewTableColumn, ColumnMapping } from "../api/tauri";
import {
  newTableRequest,
  validateNewTable,
  type NewColumnDraft,
  type NewTableError,
} from "./newTableInference";

/** シート名からテーブル名を提案する。英数字・`_` 以外は `_` にまとめ、使用済みなら連番を付ける。 */
export function suggestSheetTableName(sheet: string, used: ReadonlySet<string>): string {
  const cleaned = sheet.replace(/[^\p{L}\p{N}_]+/gu, "_").replace(/^_+|_+$/g, "");
  const base = cleaned || "sheet";
  let name = base;
  let n = 2;
  while (used.has(name.toLowerCase())) {
    name = `${base}_${n}`;
    n += 1;
  }
  return name;
}

export interface SheetPlanEntry {
  sheet: string;
  include: boolean;
  tableName: string;
  drafts: readonly NewColumnDraft[];
}

export type SheetIssue =
  | { kind: "table"; error: NonNullable<NewTableError> }
  | { kind: "exists"; name: string }
  | { kind: "duplicate"; name: string };

/**
 * 取り込む各シートの問題を調べる。問題が無いシートは `null`、取り込まないシートも `null`。
 * 既存テーブルとの衝突は大小を区別しない (MySQL / SQLite の既定の照合に合わせた安全側)。
 */
export function checkSheetPlan(
  driver: DriverKind,
  entries: readonly SheetPlanEntry[],
  existingTables: readonly string[],
): (SheetIssue | null)[] {
  const existing = new Set(existingTables.map((t) => t.toLowerCase()));
  const firstUse = new Map<string, number>();
  entries.forEach((e, i) => {
    if (!e.include) return;
    const key = e.tableName.trim().toLowerCase();
    if (key && !firstUse.has(key)) firstUse.set(key, i);
  });
  return entries.map((e, i) => {
    if (!e.include) return null;
    const err = validateNewTable(driver, e.tableName, e.drafts);
    if (err) return { kind: "table", error: err };
    const key = e.tableName.toLowerCase();
    if (existing.has(key)) return { kind: "exists", name: e.tableName };
    if (firstUse.get(key) !== i) return { kind: "duplicate", name: e.tableName };
    return null;
  });
}

export interface SheetImportRequest {
  sheet: string;
  table: string;
  mapping: ColumnMapping[];
  createTable: NewTableColumn[];
}

/** 実行する指定を作る (取り込むシートだけ、ブック順)。 */
export function buildSheetRequests(entries: readonly SheetPlanEntry[]): SheetImportRequest[] {
  return entries
    .filter((e) => e.include)
    .map((e) => {
      const req = newTableRequest(e.drafts);
      return { sheet: e.sheet, table: e.tableName, mapping: req.mapping, createTable: req.columns };
    });
}

/** 全シート共通の取り込みオプション。新規テーブルへの取り込みなので重複キーの扱いは INSERT 固定。 */
export function sheetImportOptions(base: ImportOptions): ImportOptions {
  return { ...base, format: "xlsx", sheet: null, conflictMode: "insert", keyColumns: [] };
}
