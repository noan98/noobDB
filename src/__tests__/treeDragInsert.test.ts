import { describe, expect, it } from "vitest";
import {
  TREE_DRAG_MIME,
  dropInsertText,
  encodeTreeDragItem,
  hasTreeDragItem,
  parseTreeDragItem,
  treeDragPlainText,
  treeItemInsertText,
  writeTreeDragData,
  type TreeDragItem,
} from "../components/treeDragInsert";

const table: TreeDragItem = { kind: "table", database: "shop", table: "orders" };
const column: TreeDragItem = { kind: "column", database: "shop", table: "orders", column: "id" };

describe("treeDragInsert", () => {
  it("ペイロードは符号化 → 復号で元に戻る", () => {
    expect(parseTreeDragItem(encodeTreeDragItem(table))).toEqual(table);
    expect(parseTreeDragItem(encodeTreeDragItem(column))).toEqual(column);
  });

  it("壊れた / 形の合わないペイロードは null", () => {
    for (const raw of [
      "",
      "not json",
      "null",
      "42",
      '{"kind":"table","database":"d"}',
      '{"kind":"column","database":"d","table":"t"}',
      '{"kind":"index","database":"d","table":"t"}',
      '{"kind":"table","database":1,"table":"t"}',
    ]) {
      expect(parseTreeDragItem(raw)).toBeNull();
    }
  });

  it("hasTreeDragItem は内部 MIME の有無だけを見る (ファイル D&D は対象外)", () => {
    expect(hasTreeDragItem([TREE_DRAG_MIME, "text/plain"])).toBe(true);
    expect(hasTreeDragItem(["Files"])).toBe(false);
    expect(hasTreeDragItem(["text/plain"])).toBe(false);
    expect(hasTreeDragItem(null)).toBe(false);
    expect(hasTreeDragItem(undefined)).toBe(false);
  });

  it("writeTreeDragData は内部 MIME と名前のみの text/plain を書く", () => {
    const store: Record<string, string> = {};
    const dt = { effectAllowed: "", setData: (f: string, d: string) => void (store[f] = d) };
    writeTreeDragData(dt, column);
    expect(dt.effectAllowed).toBe("copy");
    expect(store["text/plain"]).toBe("id");
    expect(parseTreeDragItem(store[TREE_DRAG_MIME] ?? "")).toEqual(column);
    expect(treeDragPlainText(table)).toBe("orders");
  });

  it("テーブルは SELECT 雛形 (右クリックの挿入と同じ整形) になる", () => {
    expect(treeItemInsertText("mysql", table)).toBe("SELECT * FROM `shop`.`orders`");
    expect(treeItemInsertText("postgres", table)).toBe('SELECT * FROM "shop"."orders"');
    // SQLite は名前空間修飾を付けない。
    expect(treeItemInsertText("sqlite", table)).toBe('SELECT * FROM "orders"');
  });

  it("列は既定で 表.列、qualified=false で列名のみ。予約語はクォートする", () => {
    expect(treeItemInsertText("mysql", column)).toBe("orders.id");
    expect(treeItemInsertText("mysql", column, false)).toBe("id");
    const reserved: TreeDragItem = { kind: "column", database: "d", table: "order", column: "group" };
    expect(treeItemInsertText("mysql", reserved)).toBe("`order`.`group`");
    expect(treeItemInsertText("postgres", reserved, false)).toBe('"group"');
  });

  it("dropInsertText: ペイロードが無ければ null、Alt で列名のみ", () => {
    const get = (item: TreeDragItem) => (f: string) => (f === TREE_DRAG_MIME ? encodeTreeDragItem(item) : "");
    expect(dropInsertText("mysql", () => "", false)).toBeNull();
    expect(dropInsertText("mysql", get(column), false)).toBe("orders.id");
    expect(dropInsertText("mysql", get(column), true)).toBe("id");
    expect(dropInsertText("mysql", get(table), true)).toBe("SELECT * FROM `shop`.`orders`");
  });
});
