import { describe, expect, it } from "vitest";
import { treeDragLabel, treeItemInsertText, type TreeDragItem } from "../components/treeDragInsert";

const table: TreeDragItem = { kind: "table", database: "shop", table: "orders" };
const column: TreeDragItem = { kind: "column", database: "shop", table: "orders", column: "id" };

describe("treeDragInsert", () => {
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

  it("ゴーストのラベルはテーブル名 / 表.列", () => {
    expect(treeDragLabel(table)).toBe("orders");
    expect(treeDragLabel(column)).toBe("orders.id");
  });
});
