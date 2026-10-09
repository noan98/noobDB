import { describe, it, expect } from "vitest";
import type { ForeignKey } from "../api/tauri";
import { joinCompletions } from "../components/sqlJoinCompletion";

const fk = (
  table: string,
  column: string,
  referenced_table: string,
  referenced_column: string | null,
  constraint_name: string | null = null,
): ForeignKey => ({ table, column, referenced_table, referenced_column, constraint_name });

const FKS = [
  fk("orders", "customer_id", "customers", "id", "fk_oc"),
  fk("order_items", "order_id", "orders", "id", "fk_io"),
  fk("order_items", "product_id", "products", "id", "fk_ip"),
];

const run = (text: string, driver = "mysql", fks = FKS) => joinCompletions({ driver, text, fks });

describe("joinCompletions: JOIN の相手テーブル", () => {
  it("FROM 済みテーブルと FK で繋がる相手を ON 付きで返す", () => {
    const text = "SELECT * FROM orders JOIN ";
    const r = run(text);
    expect(r?.from).toBe(text.length);
    expect(r?.options).toEqual([
      {
        label: "customers",
        apply: "customers ON customers.id = orders.customer_id",
        detail: "ON customers.id = orders.customer_id",
      },
      {
        label: "order_items",
        apply: "order_items ON order_items.order_id = orders.id",
        detail: "ON order_items.order_id = orders.id",
      },
    ]);
  });

  it("別名を使い、入力途中の語の位置を from にする", () => {
    const text = "select * from orders as o left join cus";
    const r = run(text);
    expect(r?.from).toBe(text.length - 3);
    expect(r?.options[0]?.apply).toBe("customers ON customers.id = o.customer_id");
  });

  it("複数テーブルを JOIN 済みなら全部を起点にする", () => {
    const r = run("SELECT * FROM order_items i JOIN orders o ON o.id = i.order_id JOIN ");
    const applies = r?.options.map((o) => o.apply);
    expect(applies).toContain("products ON products.id = i.product_id");
    expect(applies).toContain("customers ON customers.id = o.customer_id");
  });

  it("自己参照は別名を付ける", () => {
    const r = run("SELECT * FROM emp JOIN ", "mysql", [fk("emp", "boss_id", "emp", "id", "fk")]);
    expect(r?.options[0]?.apply).toBe("emp emp_2 ON emp_2.id = emp.boss_id");
  });

  it("複合キーは AND で繋ぐ", () => {
    const fks = [fk("b", "x", "a", "x", "c"), fk("b", "y", "a", "y", "c")];
    const r = run("SELECT * FROM a JOIN ", "mysql", fks);
    expect(r?.options[0]?.apply).toBe("b ON b.x = a.x AND b.y = a.y");
  });

  it("PostgreSQL の交差積で返る複合 FK は候補にしない", () => {
    const fks = [
      fk("t", "a", "u", "x", "c"),
      fk("t", "a", "u", "y", "c"),
      fk("t", "b", "u", "x", "c"),
      fk("t", "b", "u", "y", "c"),
    ];
    expect(run("SELECT * FROM t JOIN ", "postgres", fks)).toBeNull();
  });

  it("NATURAL / CROSS JOIN の直後は候補にしない", () => {
    expect(run("SELECT * FROM orders NATURAL JOIN ")).toBeNull();
    expect(run("SELECT * FROM orders CROSS JOIN ")).toBeNull();
    expect(run("SELECT * FROM orders NATURAL LEFT OUTER JOIN ")).toBeNull();
    expect(run("SELECT * FROM orders NATURAL INNER JOIN ")).toBeNull();
  });

  it("予約語はクォートし、id / value などの一般語はクォートしない", () => {
    const fks = [fk("a", "to", "b", "end", "c"), fk("a", "value", "b", "id", "d")];
    const o = run("SELECT * FROM a JOIN ", "mysql", fks)?.options.map((x) => x.apply);
    expect(o).toEqual(["b ON b.`end` = a.`to`", "b ON b.id = a.value"]);
    expect(run("SELECT * FROM a JOIN ", "postgres", fks)?.options[1]?.apply).toBe(
      "b ON b.id = a.value",
    );
  });

  it("方言ごとにクォートする (予約語・大文字)", () => {
    const fks = [fk("Order", "UserId", "user", "id", "c")];
    expect(run("SELECT * FROM `Order` JOIN ", "mysql", fks)?.options[0]?.apply).toBe(
      "`user` ON `user`.id = `Order`.UserId",
    );
    expect(run('SELECT * FROM "Order" JOIN ', "postgres", fks)?.options[0]?.apply).toBe(
      '"user" ON "user".id = "Order"."UserId"',
    );
    expect(run('SELECT * FROM "Order" JOIN ', "sqlite", fks)?.options[0]?.apply).toBe(
      '"user" ON "user".id = "Order".UserId',
    );
  });

  it("referenced_column が null の FK は無視する", () => {
    expect(run("SELECT * FROM a JOIN ", "mysql", [fk("a", "x", "b", null)])).toBeNull();
  });
});

describe("joinCompletions: ON 条件", () => {
  it("結合したテーブルと先行テーブルの FK 条件を返す", () => {
    const text = "SELECT * FROM orders o JOIN customers c ON ";
    const r = run(text);
    expect(r?.from).toBe(text.length);
    expect(r?.options).toEqual([{ label: "c.id = o.customer_id", apply: "c.id = o.customer_id" }]);
  });

  it("入力途中の語を置換対象にする", () => {
    const text = "SELECT * FROM orders JOIN order_items ON or";
    const r = run(text);
    expect(r?.from).toBe(text.length - 2);
    expect(r?.options[0]?.apply).toBe("order_items.order_id = orders.id");
  });
});

describe("joinCompletions: 対象外", () => {
  it("JOIN 文脈でなければ null", () => {
    expect(run("SELECT * FROM orders WHERE ")).toBeNull();
    expect(run("SELECT * FROM orders ")).toBeNull();
  });
  it("文字列内・前の文は無視する", () => {
    expect(run("SELECT 'FROM orders JOIN ")).toBeNull();
    expect(run("SELECT * FROM orders; SELECT 1 JOIN ")).toBeNull();
    expect(
      run("SELECT * FROM orders -- x\n; SELECT * FROM customers JOIN ")?.options[0]?.apply,
    ).toBe("orders ON orders.customer_id = customers.id");
  });
  it("FK が無ければ null", () => {
    expect(run("SELECT * FROM orders JOIN ", "mysql", [])).toBeNull();
  });
});
