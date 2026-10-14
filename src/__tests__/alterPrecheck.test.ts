import { describe, expect, it } from "vitest";
import { buildAlterPrechecks, parseTypeSpec } from "../components/alterPrecheck";
import type { ExistingColumnBaseline, ExistingColumnEdit } from "../components/alterTable";

function base(name: string, type: string, notNull = false): ExistingColumnBaseline {
  return { name, type, notNull, defaultValue: "", extra: "" };
}
function edit(name: string, type: string, notNull = false, drop = false): ExistingColumnEdit {
  return { original: name, drop, name, type, notNull, defaultValue: "" };
}

describe("parseTypeSpec", () => {
  it("文字列型の長さを読む (MySQL / PostgreSQL の表記)", () => {
    expect(parseTypeSpec("mysql", "varchar(255)")).toEqual({ kind: "string", length: 255 });
    expect(parseTypeSpec("postgres", "character varying(50)")).toEqual({ kind: "string", length: 50 });
    expect(parseTypeSpec("postgres", "character varying")).toEqual({ kind: "string", length: null });
    expect(parseTypeSpec("postgres", "text")).toEqual({ kind: "string", length: null });
    expect(parseTypeSpec("mysql", "text")).toEqual({ kind: "string", length: 65535 });
  });
  it("整数型は範囲、unsigned は 0..max", () => {
    const small = parseTypeSpec("mysql", "smallint");
    expect(small.kind === "int" && small.range.max).toBe(BigInt(32767));
    const u = parseTypeSpec("mysql", "int unsigned");
    expect(u.kind === "int" && u.range.min).toBe(BigInt(0));
    expect(parseTypeSpec("postgres", "integer").kind).toBe("int");
  });
  it("decimal は整数部の桁数", () => {
    expect(parseTypeSpec("mysql", "decimal(10,2)")).toEqual({ kind: "decimal", integerDigits: 8, scale: 2 });
    expect(parseTypeSpec("postgres", "numeric")).toEqual({
      kind: "decimal",
      integerDigits: null,
      scale: null,
    });
    expect(parseTypeSpec("mysql", "decimal")).toEqual({ kind: "decimal", integerDigits: 10, scale: 0 });
  });
});

describe("buildAlterPrechecks", () => {
  it("VARCHAR を縮めると長さ超過の件数を数える SQL を返す", () => {
    const got = buildAlterPrechecks(
      "mysql",
      "app",
      "users",
      [base("name", "varchar(255)")],
      [edit("name", "varchar(50)")],
    );
    expect(got).toHaveLength(1);
    expect(got[0].kind).toBe("length");
    expect(got[0].sql).toBe("SELECT COUNT(*) FROM `app`.`users` WHERE CHAR_LENGTH(`name`) > 50");
  });

  it("型が同じ・拡大・削除予定の列は検査しない", () => {
    expect(
      buildAlterPrechecks("mysql", "app", "t", [base("a", "varchar(50)")], [edit("a", "varchar(255)")]),
    ).toEqual([]);
    expect(
      buildAlterPrechecks("mysql", "app", "t", [base("a", "varchar(50)")], [edit("a", "VARCHAR(50)")]),
    ).toEqual([]);
    expect(
      buildAlterPrechecks(
        "mysql",
        "app",
        "t",
        [base("a", "varchar(255)")],
        [edit("a", "varchar(5)", false, true)],
      ),
    ).toEqual([]);
  });

  it("TEXT / 無制限から長さ指定へ縮めるのも検査する", () => {
    const got = buildAlterPrechecks(
      "postgres",
      "public",
      "t",
      [base("a", "text")],
      [edit("a", "varchar(10)")],
    );
    expect(got[0].sql).toBe('SELECT COUNT(*) FROM "public"."t" WHERE CHAR_LENGTH("a") > 10');
  });

  it("INT → SMALLINT は範囲外の件数を数える", () => {
    const got = buildAlterPrechecks(
      "postgres",
      "public",
      "t",
      [base("n", "integer")],
      [edit("n", "smallint")],
    );
    expect(got[0].kind).toBe("range");
    expect(got[0].sql).toBe('SELECT COUNT(*) FROM "public"."t" WHERE "n" < -32768 OR "n" > 32767');
  });

  it("符号付き → unsigned は下限だけ、unsigned → 同幅の signed は上限だけが狭まる", () => {
    const a = buildAlterPrechecks("mysql", "d", "t", [base("n", "int")], [edit("n", "int unsigned")]);
    expect(a[0].sql).toContain("`n` < 0");
    expect(a[0].sql).not.toContain("OR");
    const b = buildAlterPrechecks("mysql", "d", "t", [base("n", "int unsigned")], [edit("n", "int")]);
    expect(b[0].sql).toContain("`n` > 2147483647");
    expect(b[0].sql).not.toContain("<");
  });

  it("DECIMAL の整数部が縮むと上限超過を数える", () => {
    const got = buildAlterPrechecks(
      "mysql",
      "d",
      "t",
      [base("p", "decimal(12,2)")],
      [edit("p", "decimal(6,2)")],
    );
    expect(got[0].kind).toBe("decimal");
    expect(got[0].sql).toContain("ABS(`p`) >= 10000");
    expect(
      buildAlterPrechecks("mysql", "d", "t", [base("p", "decimal(6,2)")], [edit("p", "decimal(12,2)")]),
    ).toEqual([]);
  });

  it("小数桁だけを縮小すると丸めで値が変わる行を数える (#1615)", () => {
    const got = buildAlterPrechecks(
      "mysql",
      "d",
      "t",
      [base("p", "decimal(10,4)")],
      [edit("p", "decimal(10,2)")],
    );
    expect(got.map((g) => g.kind)).toEqual(["scale"]);
    expect(got[0].sql).toContain("ROUND(`p`, 2) <> `p`");
    // 拡大・同じ scale では出さない
    expect(
      buildAlterPrechecks("mysql", "d", "t", [base("p", "decimal(10,2)")], [edit("p", "decimal(14,4)")]),
    ).toEqual([]);
    expect(
      buildAlterPrechecks("mysql", "d", "t", [base("p", "decimal(10,2)")], [edit("p", "decimal(12,2)")]),
    ).toEqual([]);
    // PostgreSQL の無制限 numeric → numeric(10,2) も検査する
    const pg = buildAlterPrechecks(
      "postgres",
      "public",
      "t",
      [base("p", "numeric")],
      [edit("p", "numeric(10,2)")],
    );
    expect(pg.map((g) => g.kind)).toContain("scale");
  });

  it("NOT NULL を付けると NULL 行を数える (型が同じでも)", () => {
    const got = buildAlterPrechecks(
      "postgres",
      "public",
      "t",
      [base("a", "text")],
      [edit("a", "text", true)],
    );
    expect(got).toHaveLength(1);
    expect(got[0].kind).toBe("notNull");
    expect(got[0].sql).toBe('SELECT COUNT(*) FROM "public"."t" WHERE "a" IS NULL');
  });

  it("SQLite は対象外", () => {
    expect(
      buildAlterPrechecks("sqlite", null, "t", [base("a", "varchar(255)")], [edit("a", "varchar(5)")]),
    ).toEqual([]);
  });

  it("リネームしても元の列名で数える", () => {
    const e: ExistingColumnEdit = { ...edit("a", "varchar(5)"), name: "renamed" };
    const got = buildAlterPrechecks("mysql", "d", "t", [base("a", "varchar(255)")], [e]);
    expect(got[0].sql).toContain("CHAR_LENGTH(`a`)");
  });
});
