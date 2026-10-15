import { columnInsertText, qualifiedColumnInsertText } from "./columnInsert";
import { qualifiedTableName, qualifiedTableSql } from "./sqlDialect";

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

/**
 * 列名を並べた SELECT の雛形 (#1627)。`SELECT *` より列を明示した形を一手で作る。
 * 列が取れなかった (空) ときは通常の `SELECT * FROM ...` に退避する。
 * 列名は `columnInsertText` と同じクォート規則 (予約語・大文字混じりだけ引用符で囲む)。
 */
export function tableSelectWithColumnsText(
  driver: string,
  database: string,
  table: string,
  columns: readonly string[],
): string {
  if (columns.length === 0) return qualifiedTableSql(driver, database, table);
  const list = columns.map((c) => `  ${columnInsertText(driver, c)}`).join(",\n");
  return `SELECT\n${list}\nFROM ${qualifiedTableName(driver, database, table)}`;
}

/** ドラッグ中のゴーストに出すラベル (何を掴んでいるか)。 */
export function treeDragLabel(item: TreeDragItem): string {
  return item.kind === "table" ? item.table : `${item.table}.${item.column}`;
}
