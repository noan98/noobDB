import { describe, expect, it } from "vitest";
import type { TableSchema } from "../api/tauri";
import { identifierChainAt, resolveSchemaJump, tableRefsInStatement } from "../components/identifierJump";

/** SQL エディタの識別子 Ctrl/Cmd+クリックからスキーマツリーへ移動する純ロジック (#1629)。 */

const tables: TableSchema[] = [
  { name: "users", columns: ["id", "user_name", "email"] },
  { name: "orders", columns: ["id", "user_id", "total"] },
  { name: "Order Items", columns: ["order_id", "sku"] },
];

/** `|` の位置をクリック位置として、`|` を除いた SQL と位置を返す。 */
function at(sqlWithCaret: string): { text: string; pos: number } {
  const pos = sqlWithCaret.indexOf("|");
  return { text: sqlWithCaret.replace("|", ""), pos };
}

const jump = (sql: string, defaultDatabase: string | null = "shop") => {
  const { text, pos } = at(sql);
  return resolveSchemaJump({ text, pos, tables, defaultDatabase });
};

describe("identifierChainAt", () => {
  it("単語の連なりと、クリックされた要素を返す", () => {
    const { text, pos } = at("SELECT u.na|me FROM users u");
    expect(identifierChainAt(text, pos)).toEqual({ parts: ["u", "name"], index: 1 });
    const a = at("SELECT u|.name FROM users u");
    expect(identifierChainAt(a.text, a.pos)).toEqual({ parts: ["u", "name"], index: 0 });
  });

  it("バッククォート / ダブルクォート / 角括弧の引用を 1 要素として読む", () => {
    const a = at("SELECT * FROM `shop`.`Order It|ems`");
    expect(identifierChainAt(a.text, a.pos)).toEqual({ parts: ["shop", "Order Items"], index: 1 });
    const b = at('SELECT * FROM "Order Items|"');
    expect(identifierChainAt(b.text, b.pos)?.parts).toEqual(["Order Items"]);
    const c = at("SELECT * FROM [dbo].[ord|ers]");
    expect(identifierChainAt(c.text, c.pos)).toEqual({ parts: ["dbo", "orders"], index: 1 });
  });

  it("識別子の上でなければ null (空白・記号・文字列リテラル・行コメント)", () => {
    const a = at("SELECT |  1");
    expect(identifierChainAt(a.text, a.pos)).toBeNull();
    const s = at("SELECT 'us|ers' FROM users");
    expect(identifierChainAt(s.text, s.pos)).toBeNull();
    const c = at("SELECT 1 -- users|\nFROM users");
    expect(identifierChainAt(c.text, c.pos)).toBeNull();
    const d = at("SELECT 'a' FROM us|ers");
    expect(identifierChainAt(d.text, d.pos)?.parts).toEqual(["users"]);
  });

  it("行頭・行末・複数行でも位置を取り違えない", () => {
    expect(identifierChainAt("users", 0)?.parts).toEqual(["users"]);
    expect(identifierChainAt("users", 5)?.parts).toEqual(["users"]);
    const m = at("SELECT *\nFROM or|ders");
    expect(identifierChainAt(m.text, m.pos)?.parts).toEqual(["orders"]);
  });
});

describe("tableRefsInStatement", () => {
  it("FROM / JOIN / UPDATE / INTO のテーブルと別名を拾う (キーワードは別名にしない)", () => {
    const { text, pos } = at("SELECT | FROM users u JOIN orders AS o ON o.user_id = u.id WHERE 1");
    const refs = tableRefsInStatement(text, pos);
    expect(refs.get("u")).toBe("users");
    expect(refs.get("o")).toBe("orders");
    expect(refs.get("users")).toBe("users");
    expect(refs.has("on")).toBe(false);
    expect(refs.has("where")).toBe(false);
  });

  it("別の文のテーブルは含めない", () => {
    const { text, pos } = at("SELECT 1 FROM orders; SELECT | FROM users");
    expect([...tableRefsInStatement(text, pos).values()]).toEqual(["users"]);
  });
});

describe("resolveSchemaJump", () => {
  it("FROM のテーブル名はテーブル行へ (大小無視)", () => {
    expect(jump("SELECT * FROM us|ers")).toEqual({ database: "shop", table: "users" });
    expect(jump("SELECT * FROM US|ERS")).toEqual({ database: "shop", table: "users" });
  });

  it("別名はそのテーブルへ、別名.列は列へ", () => {
    expect(jump("SELECT 1 FROM users u WHERE |u.id = 1")).toEqual({ database: "shop", table: "users" });
    expect(jump("SELECT u.em|ail FROM users u")).toEqual({
      database: "shop",
      table: "users",
      column: "email",
    });
  });

  it("db.table.column の db 修飾はエディタのデータベースと同じときだけ解決する", () => {
    expect(jump("SELECT * FROM shop.ord|ers")).toEqual({ database: "shop", table: "orders" });
    expect(jump("SELECT `shop`.`orders`.`to|tal` FROM orders")).toEqual({
      database: "shop",
      table: "orders",
      column: "total",
    });
    expect(jump("SELECT * FROM other.ord|ers")).toBeNull();
    // db 要素そのものをクリックしても移動しない。
    expect(jump("SELECT * FROM sh|op.orders")).toBeNull();
  });

  it("修飾の無い列名は、同じ文で参照しているテーブルから探す", () => {
    expect(jump("SELECT user_n|ame FROM users")).toEqual({
      database: "shop",
      table: "users",
      column: "user_name",
    });
    // 参照していないテーブルの列は対象外。
    expect(jump("SELECT tot|al FROM users")).toBeNull();
    // 複数テーブルで同名なら FROM の先頭側 (参照順) を選ぶ。
    expect(jump("SELECT i|d FROM orders o JOIN users u ON u.id = o.user_id")?.table).toBe("orders");
  });

  it("引用符つきの空白入りテーブル名も解決する", () => {
    expect(jump("SELECT * FROM `Order It|ems`")).toEqual({ database: "shop", table: "Order Items" });
  });

  it("一致しない識別子・キーワード・スキーマ未取得・DB 不明は null", () => {
    expect(jump("SELECT * FROM missi|ng")).toBeNull();
    expect(jump("SEL|ECT * FROM users")).toBeNull();
    expect(jump("SELECT * FROM us|ers", null)).toBeNull();
    const { text, pos } = at("SELECT * FROM us|ers");
    expect(resolveSchemaJump({ text, pos, tables: null, defaultDatabase: "shop" })).toBeNull();
    expect(resolveSchemaJump({ text, pos, tables: [], defaultDatabase: "shop" })).toBeNull();
  });
});
