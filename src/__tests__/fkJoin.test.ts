import { describe, expect, it } from "vitest";
import type { ForeignKey } from "../api/tauri";
import { fkJoinSnippets } from "../components/fkJoin";
import { qualifiedTableName, qualifiedTableSql } from "../components/sqlDialect";

function fk(
  table: string,
  column: string,
  referencedTable: string,
  referencedColumn: string | null = "id",
  constraintName: string | null = null,
): ForeignKey {
  return {
    table,
    column,
    referenced_table: referencedTable,
    referenced_column: referencedColumn,
    constraint_name: constraintName,
  };
}

const run = (driver: string, fks: ForeignKey[], table = "orders", column = "user_id") =>
  fkJoinSnippets({ driver, database: "shop", table, column, fks }).map((s) => s.text);

describe("fkJoinSnippets (#1540)", () => {
  const fks = [fk("orders", "user_id", "users", "id", "fk_orders_user")];

  it("3 ドライバでスキーマ修飾とクォートが方言に揃う", () => {
    expect(run("mysql", fks)).toEqual(["JOIN `shop`.`users` ON users.id = orders.user_id"]);
    expect(run("postgres", fks)).toEqual(['JOIN "shop"."users" ON users.id = orders.user_id']);
    // SQLite は DB 修飾なし。
    expect(run("sqlite", fks)).toEqual(['JOIN "users" ON users.id = orders.user_id']);
  });

  it("予約語・大文字を含む名前は ON 側でもクォートする", () => {
    const f = [fk("order", "UserId", "user", "Id")];
    expect(run("mysql", f, "order", "UserId")).toEqual(["JOIN `shop`.`user` ON `user`.Id = `order`.UserId"]);
    // PostgreSQL は小文字以外の識別子もクォートする。
    expect(run("postgres", f, "order", "UserId")).toEqual([
      'JOIN "shop"."user" ON "user"."Id" = "order"."UserId"',
    ]);
  });

  it("複合 FK は同じ制約の列を AND でまとめる", () => {
    const f = [
      fk("items", "order_id", "orders", "id", "fk_items_order"),
      fk("items", "shop_id", "orders", "shop_id", "fk_items_order"),
    ];
    expect(run("mysql", f, "items", "order_id")).toEqual([
      "JOIN `shop`.`orders` ON orders.id = items.order_id AND orders.shop_id = items.shop_id",
    ]);
  });

  it("PostgreSQL の交差積のような複合 FK (列の重複) は雛形を出さない", () => {
    const f = [
      fk("items", "a", "p", "x", "c"),
      fk("items", "a", "p", "y", "c"),
      fk("items", "b", "p", "x", "c"),
      fk("items", "b", "p", "y", "c"),
    ];
    expect(run("postgres", f, "items", "a")).toEqual([]);
  });

  it("自己参照には別名 <table>_2 を付ける", () => {
    const f = [fk("employees", "manager_id", "employees", "id")];
    expect(run("mysql", f, "employees", "manager_id")).toEqual([
      "JOIN `shop`.`employees` employees_2 ON employees_2.id = employees.manager_id",
    ]);
  });

  it("同じ列が複数の FK を持てば参照先ごとに 1 件ずつ、重複は除く", () => {
    const f = [fk("t", "c", "a", "id", "k1"), fk("t", "c", "b", "id", "k2"), fk("t", "c", "b", "id", "k3")];
    expect(run("sqlite", f, "t", "c")).toEqual(['JOIN "a" ON a.id = t.c', 'JOIN "b" ON b.id = t.c']);
  });

  it("FK でない列・参照列不明・大文字小文字の違い", () => {
    expect(run("mysql", fks, "orders", "note")).toEqual([]);
    expect(run("mysql", [fk("orders", "user_id", "users", null)])).toEqual([]);
    expect(run("mysql", fks, "ORDERS", "USER_ID")).toHaveLength(1);
  });
});

describe("qualifiedTableName (#1540)", () => {
  it("qualifiedTableSql と同じ修飾規則", () => {
    expect(qualifiedTableName("mysql", "d", "t")).toBe("`d`.`t`");
    expect(qualifiedTableName("sqlite", "d", "t")).toBe('"t"');
    expect(qualifiedTableSql("postgres", "d", "t")).toBe('SELECT * FROM "d"."t"');
    expect(qualifiedTableSql("sqlite", "d", "t", "rowid")).toBe('SELECT *, rowid FROM "t"');
  });
});
