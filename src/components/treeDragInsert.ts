import { columnInsertText, qualifiedColumnInsertText } from "./columnInsert";
import { qualifiedTableSql } from "./sqlDialect";

/**
 * スキーマツリーのテーブル / 列行を SQL エディタへドラッグ挿入する (#1414)。
 * ここは「挿入文字列の決定」だけを持つ純モジュールで、ポインタ操作によるドラッグ
 * (`treeDragStore.ts`) と右クリック / ダブルクリック挿入 (`App.tsx`) が同じ整形を共有する。
 *
 * HTML5 の Drag and Drop (`draggable` / `dataTransfer`) は使わない。Tauri は Windows の
 * WebView2 で OS ファイルのドロップ (`webview.onDragDropEvent`) を有効にしている間
 * HTML5 の D&D が働かないため、ポインタイベントだけで実装している。
 */

export type TreeDragItem =
  | { kind: "table"; database: string; table: string }
  | { kind: "column"; database: string; table: string; column: string };

/**
 * エディタへ挿入する文字列。テーブルは `SELECT * FROM <修飾名>` の雛形
 * (右クリックの「SELECT を挿入」と同じ)、列は `qualified` なら `表.列`、そうでなければ列名のみ。
 */
export function treeItemInsertText(driver: string, item: TreeDragItem, qualified = true): string {
  if (item.kind === "table") return qualifiedTableSql(driver, item.database, item.table);
  return qualified
    ? qualifiedColumnInsertText(driver, item.table, item.column)
    : columnInsertText(driver, item.column);
}

/** ドラッグ中のゴーストに出すラベル (何を掴んでいるか)。 */
export function treeDragLabel(item: TreeDragItem): string {
  return item.kind === "table" ? item.table : `${item.table}.${item.column}`;
}
