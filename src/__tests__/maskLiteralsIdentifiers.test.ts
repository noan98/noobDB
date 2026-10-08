import { describe, it, expect } from "vitest";
import { maskLiterals } from "../dangerousSql";

const KEEP = { keepQuotedIdentifiers: true };

describe("maskLiterals の keepQuotedIdentifiers (#1419)", () => {
  it("未指定のときは従来どおり引用識別子の中身も潰す", () => {
    expect(maskLiterals('SELECT "col" FROM `t`', "postgres")).toBe('SELECT "   " FROM ` `');
  });

  it("指定すると引用識別子の中身を残し、区切り記号も残す", () => {
    expect(maskLiterals('SELECT "Col Name" FROM `t`', "postgres", KEEP)).toBe(
      'SELECT "Col Name" FROM `t`',
    );
  });

  it("指定しても文字列リテラルとコメントは従来どおり潰す", () => {
    const sql = `SELECT "a" FROM t WHERE c = 'x FROM y' -- note`;
    const out = maskLiterals(sql, "postgres", KEEP);
    expect(out).toHaveLength(sql.length);
    expect(out).toContain('"a"');
    expect(out).not.toContain("x FROM y");
    expect(out).not.toContain("note");
  });

  it("指定すると引用識別子の中の -- や ; を語として残す (区切りは従来どおり)", () => {
    const sql = 'SELECT "a--b;c" FROM t';
    expect(maskLiterals(sql, "postgres", KEEP)).toBe(sql);
  });

  it("キャッシュは指定の有無で別の結果を返す (混線しない)", () => {
    const sql = 'SELECT "keep" FROM t';
    const plain = maskLiterals(sql, "postgres");
    const kept = maskLiterals(sql, "postgres", KEEP);
    expect(kept).toBe(sql);
    expect(plain).not.toBe(kept);
    expect(maskLiterals(sql, "postgres")).toBe(plain);
    expect(maskLiterals(sql, "postgres", KEEP)).toBe(kept);
  });

  it("MySQL のバックスラッシュエスケープは指定の有無に関係なく効く", () => {
    const sql = "SELECT 'a\\'b' FROM `t`";
    expect(maskLiterals(sql, "mysql", KEEP)).toBe("SELECT '    ' FROM `t`");
  });
});

describe("maskLiterals の補完向けオプション (#1419 再レビュー)", () => {
  it("cache: false は結果を変えない (安全網と同じ値)", () => {
    const sql = "SELECT 'a' FROM `t` -- c";
    expect(maskLiterals(sql, "mysql", { keepQuotedIdentifiers: true, cache: false })).toBe(
      maskLiterals(sql, "mysql", KEEP),
    );
  });

  it("MySQL では \"...\" の中身を keepQuotedIdentifiers でも潰す (` は残す)", () => {
    expect(maskLiterals('SELECT "a b", `c d` FROM t', "mysql", KEEP)).toBe(
      'SELECT "   ", `c d` FROM t',
    );
  });

  it("PostgreSQL / SQLite では \"...\" の中身を残す", () => {
    const sql = 'SELECT "a b" FROM t';
    expect(maskLiterals(sql, "postgres", KEEP)).toBe(sql);
    expect(maskLiterals(sql, "sqlite", KEEP)).toBe(sql);
  });

  it("安全網の呼び出し (オプション無し) は MySQL の \"...\" も従来どおり潰す", () => {
    expect(maskLiterals('SELECT "a b" FROM t', "mysql")).toBe('SELECT "   " FROM t');
  });
});
