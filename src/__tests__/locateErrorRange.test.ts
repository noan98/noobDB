import { describe, expect, it } from "vitest";
import { locateErrorRange } from "../outputLog";

const slice = (sql: string, r: { from: number; to: number } | null) => (r ? sql.slice(r.from, r.to) : null);

describe("locateErrorRange (#2330)", () => {
  describe("PostgreSQL", () => {
    it("position の位置から始まるトークンに線を引く", () => {
      const sql = "SELECT foo FROM t";
      const r = locateErrorRange('column "foo" does not exist (position 8)', sql, "postgres");
      expect(slice(sql, r)).toBe("foo");
      expect(r?.precise).toBe(true);
    });
    it("CRLF でも文字オフセットのまま数える", () => {
      const sql = "SELECT 1\r\nFROM x\r\nWHERE bad = 1";
      const at = sql.indexOf("bad") + 1;
      expect(
        slice(sql, locateErrorRange(`column "bad" does not exist (position ${at})`, sql, "postgres")),
      ).toBe("bad");
    });
    it("サロゲートペアはコードポイント単位で数える", () => {
      const sql = "SELECT '😀😀', foo FROM t";
      // 😀 は 1 コードポイント (UTF-16 では 2)。foo は 15 文字目 (1 始まり)。
      const cp = Array.from(sql).indexOf("f") + 1;
      const r = locateErrorRange(`column "foo" does not exist (position ${cp})`, sql, "postgres");
      expect(slice(sql, r)).toBe("foo");
    });
    it("複数文の途中の文は、その文の先頭が基準", () => {
      const stmt = "SELECT bar FROM t";
      const script = `SELECT 1;\n${stmt};\nSELECT 2;`;
      const r = locateErrorRange('column "bar" does not exist (position 8)', stmt, "postgres");
      expect(slice(stmt, r)).toBe("bar");
      const at = script.indexOf(stmt);
      expect(script.slice(at + (r?.from ?? 0), at + (r?.to ?? 0))).toBe("bar");
    });
    it("引用識別子は閉じ引用まで", () => {
      const sql = 'SELECT "My Col" FROM t';
      expect(slice(sql, locateErrorRange("column does not exist (position 8)", sql, "postgres"))).toBe(
        '"My Col"',
      );
    });
    it("位置が文の末尾を越えたら最後のトークン", () => {
      const sql = "SELECT 1 FROM  ";
      const r = locateErrorRange("syntax error at end of input (position 99)", sql, "postgres");
      expect(slice(sql, r)).toBe("FROM");
      expect(r?.precise).toBe(true);
    });
  });

  describe("MySQL", () => {
    it("near 断片の最初のトークンに線を引く", () => {
      const sql = "SELECT *\nFORM t WHERE a = 1";
      const err =
        "You have an error in your SQL syntax; check the manual near 'FORM t WHERE a = 1' at line 2";
      expect(slice(sql, locateErrorRange(err, sql, "mysql"))).toBe("FORM");
    });
    it("断片が見つからなければ該当行 (CRLF)", () => {
      const sql = "SELECT 1\r\nSELECT 2\r\nFROM";
      const r = locateErrorRange("error near 'zzz' at line 2", sql, "mysql");
      expect(slice(sql, r)).toBe("SELECT 2");
      expect(r?.precise).toBe(false);
    });
    it("断片が空 (末尾) ならその行の最後のトークン", () => {
      const sql = "SELECT * FROM";
      expect(slice(sql, locateErrorRange("near '' at line 1", sql, "mysql"))).toBe("FROM");
    });
    it("自動 LIMIT が付いた断片でも位置が取れる", () => {
      const sql = "SELECT * FORM t";
      const r = locateErrorRange("near 'FORM t LIMIT 1000' at line 1", sql, "mysql");
      expect(slice(sql, r)).toBe("FORM");
      expect(r?.precise).toBe(true);
    });
    it("断片は文の末尾と一致する位置を優先する", () => {
      const sql = "SELECT 1 1";
      const r = locateErrorRange("near '1' at line 1", sql, "mysql");
      expect(r).toEqual({ from: 9, to: 10, precise: true });
    });
    it("Unknown column は語の境界で探す", () => {
      const sql = "SELECT uid, id FROM t";
      expect(slice(sql, locateErrorRange("Unknown column 'id' in 'field list'", sql, "mysql"))).toBe("id");
      expect(locateErrorRange("Unknown column 'id' in 'field list'", sql, "mysql")?.from).toBe(12);
    });
    it("Unknown column は列名の出現位置", () => {
      const sql = "SELECT a, b.zed FROM t b";
      expect(slice(sql, locateErrorRange("Unknown column 'b.zed' in 'field list'", sql, "mysql"))).toBe(
        "b.zed",
      );
    });
    it("複数文の途中: 行は文の先頭が 1 行目", () => {
      const stmt = "SELECT 1\nSELEC 2";
      const err = "near 'SELEC 2' at line 2";
      expect(slice(stmt, locateErrorRange(err, stmt, "mysql"))).toBe("SELEC");
    });
    it("サロゲートペアを含む行でも UTF-16 オフセットで返る", () => {
      const sql = "SELECT '😀' FORM t";
      expect(slice(sql, locateErrorRange("near 'FORM t' at line 1", sql, "mysql"))).toBe("FORM");
    });
  });

  describe("SQLite", () => {
    it('near "tok" のトークンを探す', () => {
      const sql = "SELECT * FORM t";
      expect(slice(sql, locateErrorRange('near "FORM": syntax error', sql, "sqlite"))).toBe("FORM");
    });
    it("no such column", () => {
      const sql = "SELECT nope FROM t";
      expect(slice(sql, locateErrorRange("no such column: nope", sql, "sqlite"))).toBe("nope");
    });
    it("no such table は語の境界で、末尾の t を指す", () => {
      const sql = "SELECT * FROM items JOIN t ON 1";
      const r = locateErrorRange("no such table: t", sql, "sqlite");
      expect(r).toEqual({ from: 25, to: 26, precise: true });
    });
    it("文字列リテラル・コメントの中は探さない", () => {
      const sql = "SELECT 'nope' /* nope */ FROM t WHERE nope = 1";
      expect(locateErrorRange("no such column: nope", sql, "sqlite")?.from).toBe(sql.lastIndexOf("nope"));
    });
    it("見つからなければ文の先頭行 (先頭の空白は除く)", () => {
      const sql = "\n  SELECT 1\r\nFROM t";
      const r = locateErrorRange('near "zzz": syntax error', sql, "sqlite");
      expect(slice(sql, r)).toBe("SELECT 1");
      expect(r?.precise).toBe(false);
    });
  });

  it("本文が無い / SQL が空", () => {
    expect(locateErrorRange(null, "SELECT 1", "mysql")).toEqual({ from: 0, to: 8, precise: false });
    expect(locateErrorRange("x", "  \n ", "mysql")).toBeNull();
  });
  it("driver が違っても本文の形で判別する", () => {
    const sql = "SELECT foo FROM t";
    expect(slice(sql, locateErrorRange("bad (position 8)", sql, "mysql"))).toBe("foo");
    expect(slice(sql, locateErrorRange("bad (position 8)", sql))).toBe("foo");
  });
});
