import { columnInsertText, qualifiedColumnInsertText } from "./columnInsert";
import { qualifiedTableSql } from "./sqlDialect";

/**
 * スキーマツリーのテーブル / 列行を SQL エディタへドラッグ&ドロップ挿入する (#1414)。
 * ここは「ペイロードの符号化・復号」と「挿入文字列の決定」だけを持つ純モジュールで、
 * ツリー側 (`ConnectionList`) の dragstart、エディタ側 (`QueryEditor`) の drop、
 * 右クリック / ダブルクリック挿入 (`App.tsx`) が同じ整形を共有する。
 *
 * 接続 / グループの並べ替え D&D (framer-motion の pointer ドラッグ) は HTML5 の
 * `dataTransfer` を使わないため、ここの内部 MIME で受け手が完全に分離される。
 */

/** ツリー行ドラッグの内部 MIME。これを持たないドラッグ (ファイル等) はエディタが無視する。 */
export const TREE_DRAG_MIME = "application/x-noobdb-tree-item";

export type TreeDragItem =
  | { kind: "table"; database: string; table: string }
  | { kind: "column"; database: string; table: string; column: string };

/** `DataTransfer` のうち本モジュールが触る部分 (テストで差し替えやすくする)。 */
export interface DragDataWriter {
  setData(format: string, data: string): void;
  effectAllowed: string;
}

/** ペイロードを JSON 文字列へ。 */
export function encodeTreeDragItem(item: TreeDragItem): string {
  return JSON.stringify(item);
}

/** 内部 MIME の文字列を復号する。形が合わない / 空文字は null (誤ったドロップを黙って無視する)。 */
export function parseTreeDragItem(raw: string): TreeDragItem | null {
  if (raw === "") return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.database !== "string" || typeof o.table !== "string") return null;
  if (o.kind === "table") return { kind: "table", database: o.database, table: o.table };
  if (o.kind === "column" && typeof o.column === "string") {
    return { kind: "column", database: o.database, table: o.table, column: o.column };
  }
  return null;
}

/** ドラッグ中の `dataTransfer.types` にツリー行のペイロードが含まれるか (dragover の受理判定)。 */
export function hasTreeDragItem(types: ReadonlyArray<string> | null | undefined): boolean {
  return !!types && Array.from(types).includes(TREE_DRAG_MIME);
}

/** 外部アプリへ落とされたときのフォールバック用プレーンテキスト (名前のみ)。 */
export function treeDragPlainText(item: TreeDragItem): string {
  return item.kind === "table" ? item.table : item.column;
}

/** dragstart で `dataTransfer` を埋める。 */
export function writeTreeDragData(dt: DragDataWriter, item: TreeDragItem): void {
  dt.setData(TREE_DRAG_MIME, encodeTreeDragItem(item));
  dt.setData("text/plain", treeDragPlainText(item));
  dt.effectAllowed = "copy";
}

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
 * ドロップイベントの `dataTransfer` から挿入文字列を決める。ツリー行のペイロードが無ければ null。
 * 列は既定で修飾名 (`表.列`)、Alt を押しながらなら列名のみ (ダブルクリック挿入と同じ)。
 */
export function dropInsertText(
  driver: string,
  getData: (format: string) => string,
  altKey: boolean,
): string | null {
  const item = parseTreeDragItem(getData(TREE_DRAG_MIME));
  return item ? treeItemInsertText(driver, item, !altKey) : null;
}
