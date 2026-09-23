import { describe, expect, it } from "vitest";
import {
  RELATED_CELL_MAX_CHARS,
  RELATED_ROWS_MAX,
  RELATED_ROWS_PAGE,
  buildRelatedOpenSql,
  buildRelatedRowsSql,
  clampRelatedLimit,
  formatRelatedCell,
  nextRelatedLimit,
  resolveRelatedEntries,
  splitRelatedRows,
} from "../relatedRows";
import { isReadOnlySql } from "../dangerousSql";
import type { IncomingFk } from "../fkNavigation";

describe("buildRelatedRowsSql", () => {
  const base = { childTable: "orders", childColumn: "user_id", value: 42, limit: 50 };

  it("MySQL: DB 修飾 + バッククォート + LIMIT (上限 + 1)", () => {
    expect(buildRelatedRowsSql({ ...base, driver: "mysql", database: "shop" })).toBe(
      "SELECT * FROM `shop`.`orders` WHERE `user_id` = 42 LIMIT 51",
    );
  });

  it("PostgreSQL / DuckDB: ダブルクォート + LIMIT", () => {
    expect(buildRelatedRowsSql({ ...base, driver: "postgres", database: "public" })).toBe(
      'SELECT * FROM "public"."orders" WHERE "user_id" = 42 LIMIT 51',
    );
    expect(buildRelatedRowsSql({ ...base, driver: "duckdb", database: null })).toBe(
      'SELECT * FROM "orders" WHERE "user_id" = 42 LIMIT 51',
    );
  });

  it("SQLite: DB 修飾子を付けない", () => {
    expect(buildRelatedRowsSql({ ...base, driver: "sqlite", database: "main" })).toBe(
      'SELECT * FROM "orders" WHERE "user_id" = 42 LIMIT 51',
    );
  });

  it("MSSQL: LIMIT ではなく TOP (n) を使う", () => {
    expect(buildRelatedRowsSql({ ...base, driver: "mssql", database: "shop" })).toBe(
      "SELECT TOP (51) * FROM [shop].[orders] WHERE [user_id] = 42",
    );
  });

  it("識別子のクォート文字と値の引用符をエスケープする", () => {
    expect(
      buildRelatedRowsSql({
        driver: "mysql",
        database: null,
        childTable: "we`ird",
        childColumn: "c`ol",
        value: "a'b\\c",
        limit: 10,
      }),
    ).toBe("SELECT * FROM `we``ird` WHERE `c``ol` = 'a''b\\\\c' LIMIT 11");
    expect(
      buildRelatedRowsSql({
        driver: "mssql",
        database: null,
        childTable: "od]d",
        childColumn: "k",
        value: "x'y",
        limit: 5,
      }),
    ).toBe("SELECT TOP (6) * FROM [od]]d] WHERE [k] = N'x''y'");
  });

  it("キー値が NULL なら取得しない (IS NULL で無関係な行を拾わない)", () => {
    expect(buildRelatedRowsSql({ ...base, driver: "mysql", value: null })).toBeNull();
  });

  it("上限はクランプされる (0 以下は 1、最大値超過は最大値)", () => {
    expect(buildRelatedRowsSql({ ...base, driver: "mysql", limit: 0 })).toMatch(/LIMIT 2$/);
    expect(buildRelatedRowsSql({ ...base, driver: "mysql", limit: 99999 })).toMatch(
      new RegExp(`LIMIT ${RELATED_ROWS_MAX + 1}$`),
    );
    expect(buildRelatedRowsSql({ ...base, driver: "mysql", limit: Number.NaN })).toMatch(
      new RegExp(`LIMIT ${RELATED_ROWS_PAGE + 1}$`),
    );
  });

  it("生成 SQL は全方言で読み取り専用と判定される (read_only セッションでも動く)", () => {
    for (const driver of ["mysql", "postgres", "sqlite", "duckdb", "mssql"]) {
      const sql = buildRelatedRowsSql({ ...base, driver, database: "db", value: "x; DROP TABLE t" });
      expect(sql).not.toBeNull();
      expect(isReadOnlySql(sql ?? "", driver)).toBe(true);
    }
  });
});

describe("buildRelatedOpenSql", () => {
  it("上限なしの逆参照 SQL (グリッドで開く用)", () => {
    expect(
      buildRelatedOpenSql({
        driver: "mysql",
        database: "shop",
        childTable: "orders",
        childColumn: "user_id",
        value: 1,
      }),
    ).toBe("SELECT * FROM `shop`.`orders` WHERE `user_id` = 1");
  });

  it("キー値が NULL なら null", () => {
    expect(
      buildRelatedOpenSql({ driver: "mysql", childTable: "o", childColumn: "u", value: null }),
    ).toBeNull();
  });
});

describe("limit helpers", () => {
  it("clampRelatedLimit", () => {
    expect(clampRelatedLimit(10.7)).toBe(10);
    expect(clampRelatedLimit(-3)).toBe(1);
    expect(clampRelatedLimit(RELATED_ROWS_MAX + 1)).toBe(RELATED_ROWS_MAX);
  });

  it("nextRelatedLimit はページ分増やし、最大値で止まる", () => {
    expect(nextRelatedLimit(RELATED_ROWS_PAGE)).toBe(RELATED_ROWS_PAGE * 2);
    expect(nextRelatedLimit(RELATED_ROWS_MAX - 1)).toBe(RELATED_ROWS_MAX);
    expect(nextRelatedLimit(RELATED_ROWS_MAX)).toBeNull();
  });

  it("splitRelatedRows は上限 + 1 件目で続きありを判定する", () => {
    expect(splitRelatedRows([1, 2, 3], 3)).toEqual({ rows: [1, 2, 3], hasMore: false });
    expect(splitRelatedRows([1, 2, 3, 4], 3)).toEqual({ rows: [1, 2, 3], hasMore: true });
    expect(splitRelatedRows([], 3)).toEqual({ rows: [], hasMore: false });
  });
});

describe("resolveRelatedEntries", () => {
  const incoming: IncomingFk[] = [
    { table: "orders", column: "user_id", referencedColumn: "id" },
    { table: "profiles", column: "user_email", referencedColumn: "email" },
    { table: "audit", column: "user_code", referencedColumn: "code" },
    { table: "notes", column: "owner", referencedColumn: "nick" },
    { table: "orders", column: "user_id", referencedColumn: "id" },
  ];
  const cols = ["id", "email", "code", "nick"];
  const row = [7, "a@example.com", "X1", null];

  it("たどれるもの・理由付きでたどれないものを列挙し、重複を除く", () => {
    const entries = resolveRelatedEntries(incoming, cols, row, (ci) => ci === 1);
    expect(entries.map((e) => [e.key, e.blocked, e.value])).toEqual([
      ["orders.user_id", null, 7],
      ["profiles.user_email", "masked", null],
      ["audit.user_code", null, "X1"],
      ["notes.owner", "nullKey", null],
    ]);
  });

  it("キー列が結果に無ければ missingKey", () => {
    const entries = resolveRelatedEntries(incoming.slice(0, 1), ["name"], ["x"], () => false);
    expect(entries[0]).toMatchObject({ blocked: "missingKey", refColIdx: -1 });
  });

  it("マスク中のキー値はエントリに載せない (伏せ字から実値を漏らさない)", () => {
    const entries = resolveRelatedEntries(incoming, cols, row, () => true);
    expect(entries.every((e) => e.value === null)).toBe(true);
  });
});

describe("formatRelatedCell", () => {
  it("マスク列は値に関係なく伏せ字", () => {
    expect(formatRelatedCell("secret", "string", true)).toEqual({ tone: "masked" });
    expect(formatRelatedCell(null, "string", true)).toEqual({ tone: "masked" });
  });

  it("NULL を明示する", () => {
    expect(formatRelatedCell(null, "string", false)).toEqual({ tone: "null" });
    expect(formatRelatedCell(undefined, "string", false)).toEqual({ tone: "null" });
  });

  it("BLOB は 0x 付き、改行は 1 行に畳む", () => {
    expect(formatRelatedCell("ff00", "binary", false)).toEqual({
      tone: "value",
      text: "0xff00",
      truncated: false,
    });
    expect(formatRelatedCell("a\n b", "string", false)).toEqual({
      tone: "value",
      text: "a b",
      truncated: false,
    });
  });

  it("長い値は切り詰める", () => {
    const r = formatRelatedCell("x".repeat(RELATED_CELL_MAX_CHARS + 5), "string", false);
    expect(r).toMatchObject({ tone: "value", truncated: true });
    if (r.tone === "value") expect(r.text.length).toBe(RELATED_CELL_MAX_CHARS + 1);
  });

  it("数値・真偽値", () => {
    expect(formatRelatedCell(0, "number", false)).toMatchObject({ text: "0" });
    expect(formatRelatedCell(false, "bool", false)).toMatchObject({ text: "false" });
  });
});
