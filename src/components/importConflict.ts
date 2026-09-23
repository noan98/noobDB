import type { ImportConflictMode, TableColumnInfo } from "../api/tauri";

/**
 * インポートの競合モード (UPSERT, #972) の UI 側純ロジック。
 *
 * バックエンド (`db/upsert.rs` の `ImportConflict::validate`) と同じ規則で
 * キー列を検証し、実行ボタンを押す前に理由を表示できるようにする。SQL の生成は
 * バックエンドだけが持つ (フロントは方言を再実装しない)。
 */

/** キー列設定の検証結果。`null` なら実行可能。 */
export type ConflictKeyError = "keysRequired" | "keyNotMapped" | null;

/**
 * 既定のキー列: 主キー (`key === "PRI"`) のうち、実際にマッピングされている列。
 * テーブル定義の列順を保つ。主キーがマッピングされていなければ空 (ユーザに選ばせる)。
 */
export function defaultKeyColumns(
  tableColumns: Pick<TableColumnInfo, "name" | "key">[],
  mappedColumns: readonly string[],
): string[] {
  return tableColumns
    .filter((c) => c.key === "PRI" && mappedColumns.includes(c.name))
    .map((c) => c.name);
}

/**
 * マッピングが変わった後もキー列として有効なものだけを残す
 * (マッピングを外した列がキーに残ると、バックエンドが拒否するため)。
 */
export function pruneKeyColumns(
  keyColumns: readonly string[],
  mappedColumns: readonly string[],
): string[] {
  return keyColumns.filter((k) => mappedColumns.includes(k));
}

/** キー列のチェックボックスを切り替える。順序はマッピング列の並びに揃える。 */
export function toggleKeyColumn(
  keyColumns: readonly string[],
  column: string,
  mappedColumns: readonly string[],
): string[] {
  const next = keyColumns.includes(column)
    ? keyColumns.filter((k) => k !== column)
    : [...keyColumns, column];
  return mappedColumns.filter((c) => next.includes(c));
}

/** バックエンドの `ImportConflict::validate` と同じ規則でキー列を検証する。 */
export function validateConflictKeys(
  mode: ImportConflictMode,
  keyColumns: readonly string[],
  mappedColumns: readonly string[],
): ConflictKeyError {
  if (mode === "insert") return null;
  if (keyColumns.length === 0) return "keysRequired";
  if (keyColumns.some((k) => !mappedColumns.includes(k))) return "keyNotMapped";
  return null;
}
