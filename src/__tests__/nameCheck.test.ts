import { describe, expect, it } from "vitest";
import { checkSqlNames } from "../ai/nameCheck";

const tables = [
  { name: "users", columns: [{ name: "id" }, { name: "name" }, { name: "email" }] },
  { name: "orders", columns: [{ name: "id" }, { name: "user_id" }, { name: "total" }] },
];
const check = (sql: string, used: string[] = [], db: string | null = "app") =>
  checkSqlNames(sql, "mysql", tables, used, db);

describe("生成 SQL の表名・列名の照合 (#1620)", () => {
  it("存在する表・列だけなら指摘なし", () => {
    expect(
      check(
        "SELECT u.name, o.total FROM users u JOIN orders AS o ON o.user_id = u.id WHERE u.email LIKE '%x%'",
        ["users", "orders"],
      ),
    ).toEqual([]);
  });

  it("未知の表名を FROM / JOIN から見つける (大文字小文字は区別しない)", () => {
    expect(check("SELECT * FROM Users JOIN invoices i ON i.user_id = Users.id")).toEqual([
      { kind: "table", name: "invoices" },
    ]);
  });

  it("tables_used にだけ現れる未知の表も指摘し、修飾付きは最後の部分で見る", () => {
    expect(check("SELECT 1", ["app.users", "ghost"])).toEqual([{ kind: "table", name: "ghost" }]);
  });

  it("別名でも表名でも、未知の列を所属表つきで指摘する", () => {
    expect(
      check("SELECT u.nickname, orders.amount FROM users u JOIN orders ON orders.user_id = u.id"),
    ).toEqual([
      { kind: "column", name: "nickname", table: "users" },
      { kind: "column", name: "amount", table: "orders" },
    ]);
  });

  it("修飾なしの列・u.* は見ない", () => {
    expect(check("SELECT nickname, u.* FROM users u")).toEqual([]);
  });

  it("CTE 名・関数呼び出し・システムカタログ・別 DB 修飾は対象外", () => {
    expect(
      check(
        "WITH recent AS (SELECT * FROM orders) SELECT * FROM recent r JOIN generate_series(1, 3) g ON true",
      ),
    ).toEqual([]);
    expect(check("SELECT * FROM information_schema.tables")).toEqual([]);
    expect(check("SELECT * FROM other_db.things")).toEqual([]);
    expect(check("SELECT * FROM sqlite_master")).toEqual([]);
    expect(check("SELECT * FROM app.ghost")).toEqual([{ kind: "table", name: "ghost" }]);
  });

  it("文字列リテラル・EXTRACT(... FROM ...) を表名と取り違えない", () => {
    expect(check("SELECT EXTRACT(YEAR FROM created_at), 'FROM ghost' FROM users")).toEqual([]);
  });

  it("同じ別名が別の表を指すとき (スコープ違い) は列を判定しない", () => {
    expect(check("SELECT t.total FROM (SELECT t.name FROM users t) x JOIN orders t ON t.id = x.id")).toEqual(
      [],
    );
  });

  it("スキーマが空なら何も言わない", () => {
    expect(checkSqlNames("SELECT * FROM nothing", "sqlite", [], ["nothing"])).toEqual([]);
  });

  it("引用符付き識別子を外して照合する", () => {
    expect(
      checkSqlNames('SELECT "u"."id" FROM "users" "u" JOIN "ghost" g ON 1=1', "postgres", tables),
    ).toEqual([{ kind: "table", name: "ghost" }]);
  });
});
