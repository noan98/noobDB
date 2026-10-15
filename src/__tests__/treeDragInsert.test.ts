import { describe, expect, it } from "vitest";
import {
  tableSelectWithColumnsText,
  treeDragLabel,
  treeItemInsertText,
  type TreeDragItem,
} from "../components/treeDragInsert";

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

  it("列名つき SELECT 雛形は列を 1 行ずつ並べ、予約語はクォートする (#1627)", () => {
    expect(tableSelectWithColumnsText("mysql", "shop", "orders", ["id", "group", "name"])).toBe(
      "SELECT\n  id,\n  `group`,\n  name\nFROM `shop`.`orders`",
    );
    expect(tableSelectWithColumnsText("postgres", "public", "orders", ["id", "UserId"])).toBe(
      'SELECT\n  id,\n  "UserId"\nFROM "public"."orders"',
    );
    expect(tableSelectWithColumnsText("sqlite", "main", "orders", ["id"])).toBe(
      'SELECT\n  id\nFROM "orders"',
    );
  });

  it("列が空なら SELECT * に退避する (#1627)", () => {
    expect(tableSelectWithColumnsText("mysql", "shop", "orders", [])).toBe("SELECT * FROM `shop`.`orders`");
  });
});
