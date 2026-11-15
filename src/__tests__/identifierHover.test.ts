import { describe, expect, it } from "vitest";
import type { TableColumnInfo, TableSchema } from "../api/tauri";
import { describeTableCard, jumpableRanges, resolveIdentifierHover } from "../components/identifierHover";

/** SQL エディタの識別子ホバーカード / Ctrl・Cmd 押下中のジャンプ下線の純ロジック (#2352)。 */

const tables: TableSchema[] = [
  { name: "users", columns: ["id", "user_name", "email"] },
  { name: "orders", columns: ["id", "user_id", "total"] },
];

const at = (sqlWithCaret: string) => {
  const pos = sqlWithCaret.indexOf("|");
  return { text: sqlWithCaret.slice(0, pos) + sqlWithCaret.slice(pos + 1), pos };
};

const hover = (sql: string, side = 1, db: string | null = "shop") => {
  const { text, pos } = at(sql);
  return resolveIdentifierHover({ text, pos, side, tables, defaultDatabase: db });
};

describe("resolveIdentifierHover", () => {
  it("テーブル名・別名にホバーすると範囲と移動先を返す", () => {
    expect(hover("SELECT * FROM us|ers u")).toEqual({
      from: 14,
      to: 19,
      target: { database: "shop", table: "users" },
    });
    expect(hover("SELECT * FROM users |u")).toMatchObject({ target: { table: "users" } });
  });

  it("別名.列 は列要素なら列、別名要素ならテーブル", () => {
    expect(hover("SELECT u.na|me FROM users u")).toBeNull();
    expect(hover("SELECT u.user_na|me FROM users u")).toMatchObject({
      from: 9,
      to: 18,
      target: { table: "users", column: "user_name" },
    });
    expect(hover("SELECT |u.user_name FROM users u")?.target).toEqual({ database: "shop", table: "users" });
  });

  it("未修飾の列名は同じ文の FROM / JOIN から解決する", () => {
    expect(hover("SELECT tot|al FROM orders")?.target).toEqual({
      database: "shop",
      table: "orders",
      column: "total",
    });
    expect(hover("SELECT tot|al FROM users")).toBeNull();
  });

  it("解決できない語・文字列リテラル・コメントの中は null", () => {
    expect(hover("SELECT * FROM missi|ng")).toBeNull();
    expect(hover("SELECT 'us|ers' FROM users")).toBeNull();
    expect(hover("SELECT 1 -- us|ers\nFROM users")).toBeNull();
    expect(hover("SELECT * FROM users WHERE x = |")).toBeNull();
  });

  it("db 修飾そのものは null、テーブル要素は解決する", () => {
    expect(hover("SELECT * FROM sh|op.users")).toBeNull();
    expect(hover("SELECT * FROM shop.us|ers")?.target).toEqual({ database: "shop", table: "users" });
  });

  it("識別子の右端は side が負のときだけ手前の要素とみなす", () => {
    expect(hover("SELECT * FROM users|", -1)).not.toBeNull();
    expect(hover("SELECT * FROM users|", 1)).toBeNull();
  });

  it("スキーマ未取得・データベース名なしは null", () => {
    const { text, pos } = at("SELECT * FROM us|ers");
    expect(resolveIdentifierHover({ text, pos, tables: null, defaultDatabase: "shop" })).toBeNull();
    expect(resolveIdentifierHover({ text, pos, tables, defaultDatabase: null })).toBeNull();
  });
});

describe("コメント・複数行の文字列の中", () => {
  const ranges = (text: string, driver?: string) =>
    jumpableRanges({ text, from: 0, to: text.length, tables, defaultDatabase: "shop", driver }).map(
      (r) => `${r.from}:${text.slice(r.from, r.to)}`,
    );
  const hoverAt = (text: string, pos: number, driver?: string) =>
    resolveIdentifierHover({ text, pos, tables, defaultDatabase: "shop", driver });

  it("ブロックコメントの中は出ない", () => {
    const t = "SELECT 1 /* users */ FROM users";
    expect(hoverAt(t, 13)).toBeNull();
    expect(ranges(t)).toEqual(["26:users"]);
    const multi = "SELECT 1 /* a\n FROM users\n*/ FROM orders";
    expect(hoverAt(multi, multi.indexOf("users") + 1)).toBeNull();
    expect(ranges(multi)).toEqual([`${multi.lastIndexOf("orders")}:orders`]);
  });

  it("MySQL の # コメントの中は出ない", () => {
    const t = "SELECT 1 # users\nFROM orders";
    expect(hoverAt(t, 12, "mysql")).toBeNull();
    expect(ranges(t, "mysql")).toEqual([`${t.indexOf("orders")}:orders`]);
  });

  it("複数行の文字列の中は出ず、その後ろの本物の識別子は解決する", () => {
    const t = "SELECT 'a\nusers' FROM users";
    expect(hoverAt(t, 11)).toBeNull();
    expect(ranges(t)).toEqual([`${t.lastIndexOf("users")}:users`]);
    expect(hoverAt(t, t.lastIndexOf("users") + 1)?.target.table).toBe("users");
  });
});

describe("長い行", () => {
  it("1 万字を超える行は下線の対象外で、短い行は従来どおり", () => {
    const long = `INSERT INTO users VALUES (${"1,".repeat(20000)}1)`;
    const text = `${long}\nSELECT * FROM orders`;
    const r = jumpableRanges({ text, from: 0, to: text.length, tables, defaultDatabase: "shop" });
    expect(r.map((x) => text.slice(x.from, x.to))).toEqual(["orders"]);
  });

  it("数値リテラルの多い 1 行でも短時間で返る", () => {
    const text = `SELECT ${"1, 2, id, ".repeat(900)} 3 FROM users`;
    const t0 = Date.now();
    const r = jumpableRanges({ text, from: 0, to: text.length, tables, defaultDatabase: "shop" });
    expect(r.length).toBe(901);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("jumpableRanges", () => {
  const ranges = (text: string, from = 0, to = text.length) =>
    jumpableRanges({ text, from, to, tables, defaultDatabase: "shop" }).map((r) => text.slice(r.from, r.to));

  it("解決できる識別子だけを返す (キーワード・未知の語・リテラルは除く)", () => {
    expect(ranges("SELECT u.user_name, nope FROM users u WHERE u.id = 'users'")).toEqual([
      "u",
      "user_name",
      "users",
      "u",
      "u",
      "id",
    ]);
  });

  it("表示範囲と重ならない行は走査しない", () => {
    const text = "SELECT 1 FROM users;\nSELECT 2 FROM orders;";
    expect(ranges(text, 21, text.length)).toEqual(["orders"]);
  });

  it("スキーマが無ければ空", () => {
    expect(jumpableRanges({ text: "users", from: 0, to: 5, tables: null, defaultDatabase: "shop" })).toEqual(
      [],
    );
  });
});

describe("describeTableCard", () => {
  const col = (name: string, over: Partial<TableColumnInfo> = {}): TableColumnInfo => ({
    name,
    data_type: "int",
    nullable: false,
    key: "",
    default: null,
    extra: "",
    referenced_table: null,
    referenced_column: null,
    ...over,
  });

  it("PK / FK の印と推定行数を付ける", () => {
    const m = describeTableCard(
      [col("id", { key: "PRI" }), col("user_id", { referenced_table: "users" })],
      1200,
    );
    expect(m.columns).toEqual([
      { name: "id", type: "int", pk: true, fk: false },
      { name: "user_id", type: "int", pk: false, fk: true },
    ]);
    expect(m.rowEstimate).toBe(1200);
    expect(m.more).toBe(0);
  });

  it("上限を超えた列は省略し、PK / FK が多くても上限は守る", () => {
    const cols = Array.from({ length: 14 }, (_, i) => col(`c${i}`, { referenced_table: "x" }));
    const m = describeTableCard(cols, undefined, 10);
    expect(m.columns.map((c) => c.name)).toEqual(cols.slice(0, 10).map((c) => c.name));
    expect(m.more).toBe(4);
    expect(m.rowEstimate).toBeNull();
  });
});
