import { describe, expect, it } from "vitest";
import {
  buildAlterPrechecks,
  buildConstraintPrechecks,
  isConstraintPrecheck,
  parseTypeSpec,
  precheckRowsSql,
} from "../components/alterPrecheck";
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

describe("precheckRowsSql (#1626)", () => {
  it("件数 SQL を同じ条件の SELECT * に変換する", () => {
    expect(precheckRowsSql("SELECT COUNT(*) FROM `app`.`t` WHERE CHAR_LENGTH(`name`) > 10")).toBe(
      "SELECT * FROM `app`.`t` WHERE CHAR_LENGTH(`name`) > 10 LIMIT 1000;",
    );
    expect(precheckRowsSql('SELECT COUNT(*) FROM "t" WHERE "c" IS NULL', 5)).toBe(
      'SELECT * FROM "t" WHERE "c" IS NULL LIMIT 5;',
    );
  });

  it("全ての検査の SQL が変換できる", () => {
    const checks = buildAlterPrechecks(
      "mysql",
      "app",
      "t",
      [base("c", "varchar(100)")],
      [edit("c", "varchar(10)", true)],
    );
    expect(checks.length).toBeGreaterThan(0);
    for (const c of checks)
      expect(precheckRowsSql(c.sql)).toMatch(/^SELECT \* FROM .* WHERE .* LIMIT 1000;$/);
  });

  it("件数 SQL の形でなければ null", () => {
    expect(precheckRowsSql("SELECT 1")).toBeNull();
  });
});

describe("buildConstraintPrechecks (#1757)", () => {
  const fk = (columns: string[], refTable: string, refColumns: string[], name = "") => ({
    name,
    columns,
    refTable,
    refColumns,
    onDelete: "" as const,
    onUpdate: "" as const,
  });

  it("MySQL: 複合 FK は全列が非 NULL の行だけ孤立判定する (NULL を含む行は対象外)", () => {
    const got = buildConstraintPrechecks("mysql", "app", "items", {
      addedForeignKeys: [fk(["o_id", "o_rev"], "orders", ["id", "rev"], "fk_o")],
    });
    expect(got).toHaveLength(1);
    expect(got[0].kind).toBe("orphanFk");
    expect(got[0].column).toBe("fk_o");
    expect(got[0].sql).toBe(
      "SELECT COUNT(*) FROM `app`.`items` AS a_src WHERE a_src.`o_id` IS NOT NULL AND a_src.`o_rev` IS NOT NULL " +
        "AND NOT EXISTS (SELECT 1 FROM `app`.`orders` AS a_ref WHERE a_ref.`id` = a_src.`o_id` AND a_ref.`rev` = a_src.`o_rev`)",
    );
  });

  it("PostgreSQL: 単一列 FK は二重引用符で修飾する", () => {
    const got = buildConstraintPrechecks("postgres", "public", "t", {
      addedForeignKeys: [fk(["pid"], "p", ["id"])],
    });
    expect(got[0].sql).toBe(
      'SELECT COUNT(*) FROM "public"."t" AS a_src WHERE a_src."pid" IS NOT NULL ' +
        'AND NOT EXISTS (SELECT 1 FROM "public"."p" AS a_ref WHERE a_ref."id" = a_src."pid")',
    );
  });

  it("SQLite: FK / CHECK は検査しない (ALTER で追加できない)", () => {
    expect(
      buildConstraintPrechecks("sqlite", null, "t", {
        addedForeignKeys: [fk(["pid"], "p", ["id"])],
        addedChecks: [{ name: "", expression: "a > 0" }],
      }),
    ).toEqual([]);
  });

  it("UNIQUE: 3 ドライバとも NULL を除いた重複グループの行を数える (複合キーは行値 IN)", () => {
    const idx = [{ name: "u", columns: ["a", "b"], unique: true }];
    const my = buildConstraintPrechecks("mysql", "app", "t", { indexes: idx });
    expect(my[0].kind).toBe("duplicateUnique");
    expect(my[0].sql).toBe(
      "SELECT COUNT(*) FROM `app`.`t` WHERE `a` IS NOT NULL AND `b` IS NOT NULL AND (`a`, `b`) IN " +
        "(SELECT `a`, `b` FROM `app`.`t` WHERE `a` IS NOT NULL AND `b` IS NOT NULL GROUP BY `a`, `b` HAVING COUNT(*) > 1)",
    );
    const pg = buildConstraintPrechecks("postgres", "public", "t", { indexes: idx });
    expect(pg[0].sql).toContain('("a", "b") IN (SELECT "a", "b" FROM "public"."t"');
    const lite = buildConstraintPrechecks("sqlite", null, "t", {
      indexes: [{ name: "u", columns: ["a"], unique: true }],
    });
    expect(lite[0].sql).toBe(
      'SELECT COUNT(*) FROM "t" WHERE "a" IS NOT NULL AND "a" IN (SELECT "a" FROM "t" WHERE "a" IS NOT NULL GROUP BY "a" HAVING COUNT(*) > 1)',
    );
  });

  it("UNIQUE でないインデックスは検査しない", () => {
    expect(
      buildConstraintPrechecks("mysql", null, "t", {
        indexes: [{ name: "i", columns: ["a"], unique: false }],
      }),
    ).toEqual([]);
  });

  it("CHECK は NOT (式) の行を数える (式が NULL の行は含まない)", () => {
    const got = buildConstraintPrechecks("postgres", "public", "t", {
      addedChecks: [
        { name: "ck_price", expression: " price > 0 " },
        { name: "", expression: "  " },
      ],
    });
    expect(got).toHaveLength(1);
    expect(got[0].kind).toBe("checkViolation");
    expect(got[0].column).toBe("ck_price");
    expect(got[0].sql).toBe('SELECT COUNT(*) FROM "public"."t" WHERE NOT (price > 0\n)');
  });

  it("同じ ALTER で追加・リネームする列 (knownColumns に無い列) は検査しない", () => {
    const got = buildConstraintPrechecks("mysql", null, "t", {
      knownColumns: new Set(["a"]),
      indexes: [
        { name: "u1", columns: ["a"], unique: true },
        { name: "u2", columns: ["a", "new_col"], unique: true },
      ],
      addedForeignKeys: [fk(["new_col"], "p", ["id"])],
    });
    expect(got.map((c) => c.id)).toEqual(["duplicateUnique:0"]);
  });

  it("不完全な行は無視し、該当行 SELECT に変換できる", () => {
    const got = buildConstraintPrechecks("mysql", "app", "t", {
      addedForeignKeys: [fk(["a"], "", ["id"]), fk(["a"], "p", ["id"])],
      addedChecks: [{ name: "", expression: "a > 0" }],
      indexes: [{ name: "u", columns: ["a"], unique: true }],
    });
    expect(got.map((c) => c.kind).sort()).toEqual(["checkViolation", "duplicateUnique", "orphanFk"]);
    for (const c of got) {
      expect(isConstraintPrecheck(c.kind)).toBe(true);
      expect(precheckRowsSql(c.sql)).toMatch(/^SELECT \* FROM [\s\S]* WHERE [\s\S]* LIMIT 1000;$/);
    }
  });

  it("MySQL の CHECK は NOT (式) を DB 修飾つきで数える", () => {
    const got = buildConstraintPrechecks("mysql", "app", "t", {
      addedChecks: [{ name: "", expression: "qty >= 0" }],
    });
    expect(got[0].sql).toBe("SELECT COUNT(*) FROM `app`.`t` WHERE NOT (qty >= 0\n)");
  });

  it("SQLite は DB 修飾を付けない", () => {
    const got = buildConstraintPrechecks("sqlite", "main", "t", {
      indexes: [{ name: "u", columns: ["a"], unique: true }],
    });
    expect(got[0].sql).toContain('FROM "t" WHERE');
    expect(got[0].sql).not.toContain('"main"');
  });

  it("CHECK の式が追加・リネームする列を単語単位で含むなら検査しない", () => {
    const input = {
      pendingColumns: new Set(["new_col"]),
      addedChecks: [
        { name: "", expression: "new_col > 0" },
        { name: "", expression: "new_columns > 0" },
      ],
    };
    const got = buildConstraintPrechecks("mysql", null, "t", input);
    expect(got).toHaveLength(1);
    expect(got[0].to).toBe("CHECK (new_columns > 0)");
  });
});
