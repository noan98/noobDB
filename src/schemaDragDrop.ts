// スキーマツリーのテーブル / 列を SQL エディタへドラッグ&ドロップ挿入する (#1414) ための
// 純ロジック。ドラッグ元 (ConnectionList) は「何を掴んだか」だけをペイロードに載せ、
// ドロップ先 (QueryEditor) が自分のドライバで整形する — ツリー側にドライバ依存の整形を
// 持ち込まない。接続 / グループの並べ替え D&D は Motion の pointer ドラッグで
// HTML5 の dataTransfer を使わない (内部 MIME で区別できる)。ただし Reorder.Item は子孫の
// 押下でも発火するため、ツリー行側 (SchemaRowList) でネイティブ pointerdown を止めて分離する。

import { qualifiedTableSql } from "./components/sqlDialect";
import { columnInsertText, qualifiedColumnInsertText, tableInsertText } from "./schemaInsertText";

/** 内部 MIME。他アプリ / OS ファイルのドロップと区別する。 */
export const SCHEMA_DRAG_MIME = "application/x-noobdb-schema-item";

export type SchemaDragItem =
  | { kind: "table"; database: string; table: string }
  | { kind: "column"; database: string; table: string; column: string };

/** 内部 MIME に載せる文字列。 */
export function serializeSchemaDragItem(item: SchemaDragItem): string {
  return JSON.stringify(item);
}

/** 内部 MIME の文字列を検証付きで復元する。壊れた / 想定外の形は null。 */
export function parseSchemaDragItem(raw: string): SchemaDragItem | null {
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

/** 他アプリ (エディタ以外) へ落とすとき用の text/plain。ドライバ非依存の素の名前。 */
export function schemaDragPlainText(item: SchemaDragItem): string {
  return item.kind === "table" ? item.table : `${item.table}.${item.column}`;
}

export interface SchemaDropContext {
  driver: string;
  /** 修飾キー (Alt / Option) 押下中か。 */
  alt: boolean;
  /** エディタの全文が空白のみか (空のエディタへのテーブルドロップは雛形にする)。 */
  editorBlank: boolean;
}

/**
 * ドロップで挿入するテキストを決める。
 * - テーブル: 既定は修飾テーブル名。Alt 押下、または空のエディタなら `SELECT * FROM ...` 雛形
 *   (コンテキストメニューの「SELECT を挿入」と同じ整形)。
 * - 列: 既定は列名。Alt 押下なら `table.column`。
 */
export function schemaDropText(item: SchemaDragItem, ctx: SchemaDropContext): string {
  if (item.kind === "table") {
    return ctx.alt || ctx.editorBlank
      ? qualifiedTableSql(ctx.driver, item.database, item.table)
      : tableInsertText(ctx.driver, item.database, item.table);
  }
  return ctx.alt
    ? qualifiedColumnInsertText(ctx.driver, item.table, item.column)
    : columnInsertText(ctx.driver, item.column);
}

/** `dragstart` で dataTransfer に内部 MIME と text/plain (他アプリ向け) を載せる。 */
export function fillSchemaDragData(dt: DataTransfer, item: SchemaDragItem): void {
  dt.setData(SCHEMA_DRAG_MIME, serializeSchemaDragItem(item));
  dt.setData("text/plain", schemaDragPlainText(item));
  dt.effectAllowed = "copy";
}

/** dragover / drop 時点で内部 MIME を持つドラッグか (中身は drop まで読めない)。 */
export function hasSchemaDragData(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types).includes(SCHEMA_DRAG_MIME);
}
