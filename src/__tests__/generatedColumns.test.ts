import { describe, expect, it } from "vitest";
import {
  buildCreateTableSql,
  generatedColumnProblems,
  generatedExpressionProblem,
  type ColumnDef,
} from "../components/createTable";
import { buildAlterPlan, type AlterTableForm } from "../components/alterTable";

function col(over: Partial<ColumnDef>): ColumnDef {
  return {
    name: "c",
    type: "INT",
    notNull: false,
    primaryKey: false,
    unique: false,
    autoIncrement: false,
    defaultValue: "",
    ...over,
  };
}

const create = (driver: string, columns: ColumnDef[]) =>
  buildCreateTableSql(driver, { database: "shop", table: "t", columns });

describe("CREATE TABLE: generated columns (#1893)", () => {
  const total = (virtual: boolean) =>
    col({ name: "total", type: "INT", generated: { expression: "price * qty", virtual } });

  it("renders the dialect specific clause", () => {
    expect(create("mysql", [total(false)])).toContain("`total` INT AS (price * qty) STORED");
    expect(create("mysql", [total(true)])).toContain("`total` INT AS (price * qty) VIRTUAL");
    expect(create("postgres", [total(false)])).toContain(
      '"total" INT GENERATED ALWAYS AS (price * qty) STORED',
    );
    expect(create("sqlite", [total(true)])).toContain(
      '"total" INT GENERATED ALWAYS AS (price * qty) VIRTUAL',
    );
    expect(create("sqlite", [total(false)])).toContain("GENERATED ALWAYS AS (price * qty) STORED");
  });

  it("never emits VIRTUAL for PostgreSQL", () => {
    expect(create("postgres", [total(true)])).toContain("STORED");
    expect(create("postgres", [total(true)])).not.toContain("VIRTUAL");
  });

  it("puts NOT NULL / UNIQUE after the generated clause and drops DEFAULT, auto-increment and PK", () => {
    const sql = create("mysql", [
      col({ name: "id", primaryKey: true, autoIncrement: true, notNull: true }),
      col({
        name: "g",
        notNull: true,
        unique: true,
        primaryKey: true,
        autoIncrement: true,
        defaultValue: "5",
        generated: { expression: "id + 1", virtual: false },
      }),
    ]);
    expect(sql).toContain("`g` INT AS (id + 1) STORED NOT NULL UNIQUE");
    expect(sql).not.toContain("DEFAULT");
    expect(sql).toContain("PRIMARY KEY (`id`)");
    expect(sql).not.toContain("PRIMARY KEY (`id`, `g`)");
    const pg = create("postgres", [
      col({ name: "g", autoIncrement: true, generated: { expression: "1", virtual: false } }),
    ]);
    expect(pg).not.toContain("IDENTITY");
  });

  it("keeps SQLite AUTOINCREMENT only for the real key column", () => {
    const sql = create("sqlite", [
      col({ name: "id", type: "INTEGER", primaryKey: true, autoIncrement: true }),
      col({ name: "g", autoIncrement: true, generated: { expression: "id * 2", virtual: true } }),
    ]);
    expect(sql).toContain('"id" INTEGER PRIMARY KEY AUTOINCREMENT');
    expect(sql).toContain('"g" INT GENERATED ALWAYS AS (id * 2) VIRTUAL');
  });

  it("treats a blank expression as a plain column", () => {
    expect(create("mysql", [col({ name: "x", generated: { expression: "  ", virtual: false } })])).toContain(
      "`x` INT\n",
    );
  });

  it("reports problems for the UI", () => {
    const g = { expression: "a + b", virtual: false };
    expect(generatedColumnProblems("mysql", col({ generated: g }))).toEqual([]);
    expect(generatedColumnProblems("mysql", col({}))).toEqual([]);
    expect(
      generatedColumnProblems(
        "postgres",
        col({ generated: { ...g, virtual: true }, primaryKey: true, autoIncrement: true, defaultValue: "1" }),
      ),
    ).toEqual(["virtualUnsupported", "primaryKey", "autoIncrement", "defaultValue"]);
    expect(generatedColumnProblems("mysql", col({ generated: { expression: "", virtual: false } }))).toEqual([
      "emptyExpression",
    ]);
    expect(
      generatedColumnProblems("mysql", col({ generated: { expression: "a)", virtual: false } })),
    ).toEqual(["invalidExpression"]);
  });

  it("validates expression shape, ignoring literals", () => {
    expect(generatedExpressionProblem("")).toBe("empty");
    expect(generatedExpressionProblem("(a + b) * 2")).toBeNull();
    expect(generatedExpressionProblem("concat(a, ')', 'it''s')")).toBeNull();
    expect(generatedExpressionProblem("a) STORED, b INT --")).toBe("invalid");
    expect(generatedExpressionProblem("(a + b")).toBe("invalid");
    expect(generatedExpressionProblem("a; DROP TABLE t")).toBe("invalid");
    expect(generatedExpressionProblem("'unterminated")).toBe("invalid");
  });
});

function form(over: Partial<AlterTableForm>): AlterTableForm {
  return { database: "shop", table: "t", baseline: [], existing: [], added: [], indexes: [], ...over };
}
const gbase = (extra: string, expression: string, virtual: boolean) => ({
  name: "total",
  type: "int",
  notNull: false,
  defaultValue: "",
  extra,
  generated: { expression, virtual },
});
const gedit = (expression: string, virtual: boolean, over: object = {}) => ({
  original: "total",
  drop: false,
  name: "total",
  type: "int",
  notNull: false,
  defaultValue: "",
  generated: { expression, virtual },
  ...over,
});
const newGen = (virtual: boolean, over: object = {}) => ({
  name: "g",
  type: "INT",
  notNull: false,
  defaultValue: "",
  generated: { expression: "a * 2", virtual },
  ...over,
});

describe("ALTER TABLE: generated columns (#1893)", () => {
  it("adds generated columns per dialect", () => {
    const my = buildAlterPlan(
      "mysql",
      form({ added: [newGen(false, { notNull: true, defaultValue: "9" })] }),
    );
    expect(my.statements[0].sql).toBe(
      "ALTER TABLE `shop`.`t` ADD COLUMN `g` INT AS (a * 2) STORED NOT NULL;",
    );
    const pg = buildAlterPlan("postgres", form({ added: [newGen(true)] }));
    expect(pg.statements[0].sql).toBe(
      'ALTER TABLE "shop"."t" ADD COLUMN "g" INT GENERATED ALWAYS AS (a * 2) STORED;',
    );
  });

  it("SQLite: VIRTUAL is added in place, STORED goes through the rebuild", () => {
    const v = buildAlterPlan("sqlite", form({ added: [newGen(true)] }));
    expect(v.rebuild).toBeNull();
    expect(v.statements[0].sql).toBe(
      'ALTER TABLE "t" ADD COLUMN "g" INT GENERATED ALWAYS AS (a * 2) VIRTUAL;',
    );
    const s = buildAlterPlan(
      "sqlite",
      form({
        baseline: [{ name: "a", type: "INT", notNull: false, defaultValue: "", extra: "" }],
        existing: [{ original: "a", drop: false, name: "a", type: "INT", notNull: false, defaultValue: "" }],
        added: [newGen(false, { notNull: true })],
      }),
    );
    expect(s.statements).toEqual([]);
    expect(s.rebuild?.added_columns).toEqual([]);
    expect(s.rebuild?.added_generated).toEqual([
      { name: "g", data_type: "INT", not_null: true, expression: "a * 2", is_virtual: false },
    ]);
    expect(s.rebuild?.columns.map((c) => c.original)).toEqual(["a"]);
  });

  it("SQLite: editing or dropping a hidden generated column", () => {
    const a = { name: "a", type: "INT", notNull: false, defaultValue: "", extra: "" };
    const ea = { original: "a", drop: false, name: "a", type: "INT", notNull: false, defaultValue: "" };
    const changed = buildAlterPlan(
      "sqlite",
      form({ baseline: [a, gbase("", "a + 1", true)], existing: [ea, gedit("a + 2", true)] }),
    );
    expect(changed.rebuild?.changed_generated).toEqual([
      { column: "total", expression: "a + 2", is_virtual: true },
    ]);
    // 隠れた生成列は columns に入れない。
    expect(changed.rebuild?.columns.map((c) => c.original)).toEqual(["a"]);
    const untouched = buildAlterPlan(
      "sqlite",
      form({ baseline: [a, gbase("", "a + 1", true)], existing: [ea, gedit("a + 1", true)] }),
    );
    expect(untouched.rebuild).toBeNull();
    expect(untouched.statements).toEqual([]);
    const dropped = buildAlterPlan(
      "sqlite",
      form({ baseline: [a, gbase("", "a + 1", true)], existing: [ea, gedit("a + 1", true, { drop: true })] }),
    );
    expect(dropped.rebuild).toBeNull();
    expect(dropped.statements[0].sql).toBe('ALTER TABLE "t" DROP COLUMN "total";');
    const both = buildAlterPlan(
      "sqlite",
      form({
        baseline: [a, gbase("", "a + 1", true)],
        existing: [ea, gedit("a + 1", true, { drop: true })],
        added: [newGen(false)],
      }),
    );
    expect(both.rebuild?.dropped_generated).toEqual(["total"]);
  });

  it("MySQL: CHANGE keeps the expression and strips the EXTRA marker", () => {
    const p = buildAlterPlan(
      "mysql",
      form({
        baseline: [gbase("STORED GENERATED", "a + 1", false)],
        existing: [gedit("a + 1", false, { type: "bigint" })],
      }),
    );
    expect(p.warnings).toEqual([]);
    expect(p.statements[0].sql).toBe(
      "ALTER TABLE `shop`.`t` CHANGE COLUMN `total` `total` bigint AS (a + 1) STORED;",
    );
  });

  it("MySQL: a changed expression is applied with MODIFY semantics (CHANGE)", () => {
    const p = buildAlterPlan(
      "mysql",
      form({
        baseline: [gbase("VIRTUAL GENERATED", "a + 1", true)],
        existing: [gedit("a + 2", true, { notNull: true })],
      }),
    );
    expect(p.statements[0].sql).toBe(
      "ALTER TABLE `shop`.`t` CHANGE COLUMN `total` `total` int AS (a + 2) VIRTUAL NOT NULL;",
    );
    expect(p.statements[0].kind).toBe("modifyColumn");
  });

  it("MySQL: refuses to redefine a generated column whose expression is unknown", () => {
    const p = buildAlterPlan(
      "mysql",
      form({
        baseline: [
          { name: "total", type: "int", notNull: false, defaultValue: "", extra: "STORED GENERATED" },
        ],
        existing: [
          { original: "total", drop: false, name: "total", type: "bigint", notNull: false, defaultValue: "" },
        ],
      }),
    );
    expect(p.statements).toEqual([]);
    expect(p.warnings).toEqual([{ code: "generatedExpressionUnknown", column: "total" }]);
    // 改名だけなら式に触れないので文にする。
    const r = buildAlterPlan(
      "mysql",
      form({
        baseline: [
          { name: "total", type: "int", notNull: false, defaultValue: "", extra: "STORED GENERATED" },
        ],
        existing: [
          { original: "total", drop: false, name: "sum", type: "int", notNull: false, defaultValue: "" },
        ],
      }),
    );
    expect(r.statements[0].sql).toContain("RENAME COLUMN `total` TO `sum`");
  });

  it("MySQL: switching STORED/VIRTUAL is a warning", () => {
    const p = buildAlterPlan(
      "mysql",
      form({ baseline: [gbase("STORED GENERATED", "a", false)], existing: [gedit("a", true)] }),
    );
    expect(p.statements).toEqual([]);
    expect(p.warnings).toEqual([{ code: "generatedStorageUnsupported", column: "total" }]);
  });

  it("PostgreSQL: an expression change is a warning, other edits still apply", () => {
    const p = buildAlterPlan(
      "postgres",
      form({
        baseline: [gbase("STORED GENERATED", "a + 1", false)],
        existing: [gedit("a + 2", false, { notNull: true, defaultValue: "0" })],
      }),
    );
    expect(p.warnings).toEqual([{ code: "generatedExpressionUnsupported", column: "total" }]);
    expect(p.statements.map((s) => s.sql)).toEqual([
      'ALTER TABLE "shop"."t" ALTER COLUMN "total" SET NOT NULL;',
    ]);
  });
});
