import { describe, expect, it } from "vitest";
import {
  buildApplyRoutineStatements,
  buildRestoreStatement,
  buildRoutineTemplate,
  extractPgTriggerTable,
  routineApplyIsAtomic,
  stripDelimiterDirectives,
  supportsRoutineEditing,
} from "../components/routineMaintenance";

const MYSQL_PROC = `CREATE DEFINER=\`root\`@\`%\` PROCEDURE \`p\`(IN x INT)
BEGIN
  SELECT x;
  SELECT 'a;b';
END`;

describe("supportsRoutineEditing / routineApplyIsAtomic", () => {
  it("SQLite supports triggers only", () => {
    expect(supportsRoutineEditing("sqlite", "trigger")).toBe(true);
    expect(supportsRoutineEditing("sqlite", "procedure")).toBe(false);
    expect(supportsRoutineEditing("sqlite", "function")).toBe(false);
    expect(supportsRoutineEditing("mysql", "procedure")).toBe(true);
    expect(supportsRoutineEditing("postgres", "function")).toBe(true);
  });
  it("only MySQL is non-atomic", () => {
    expect(routineApplyIsAtomic("mysql")).toBe(false);
    expect(routineApplyIsAtomic("postgres")).toBe(true);
    expect(routineApplyIsAtomic("sqlite")).toBe(true);
  });
});

describe("buildApplyRoutineStatements - MySQL", () => {
  it("drops then creates, keeping the BEGIN..END body as ONE statement", () => {
    const r = buildApplyRoutineStatements({
      driver: "mysql",
      database: "shop",
      kind: "procedure",
      name: "p",
      originalDdl: MYSQL_PROC,
      ddl: `${MYSQL_PROC};\n`,
    });
    expect(r).toEqual({
      ok: true,
      statements: ["DROP PROCEDURE IF EXISTS `shop`.`p`;", `${MYSQL_PROC};`],
    });
  });
  it("drops a trigger and a function with the right keyword", () => {
    const trg = buildApplyRoutineStatements({
      driver: "mysql",
      database: "shop",
      kind: "trigger",
      name: "trg",
      originalDdl: null,
      ddl: "CREATE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW BEGIN SET NEW.a = 1; END",
    });
    expect(trg.ok && trg.statements[0]).toBe("DROP TRIGGER IF EXISTS `shop`.`trg`;");
    const fn = buildApplyRoutineStatements({
      driver: "mysql",
      database: "shop",
      kind: "function",
      name: "f",
      originalDdl: null,
      ddl: "CREATE FUNCTION f() RETURNS INT DETERMINISTIC RETURN 1",
    });
    expect(fn.ok && fn.statements[0]).toBe("DROP FUNCTION IF EXISTS `shop`.`f`;");
  });
  it("creating new has no DROP", () => {
    const r = buildApplyRoutineStatements({
      driver: "mysql",
      database: "shop",
      kind: "procedure",
      name: null,
      originalDdl: null,
      ddl: buildRoutineTemplate("mysql", "procedure", "shop"),
    });
    expect(r.ok && r.statements).toHaveLength(1);
    expect(r.ok && r.statements[0].startsWith("CREATE PROCEDURE")).toBe(true);
  });
  it("unwraps DELIMITER directives", () => {
    const ddl = `DELIMITER $$\n${MYSQL_PROC}$$\nDELIMITER ;\n`;
    expect(stripDelimiterDirectives(ddl)).toBe(MYSQL_PROC);
    const r = buildApplyRoutineStatements({
      driver: "mysql",
      database: "d",
      kind: "procedure",
      name: null,
      originalDdl: null,
      ddl,
    });
    expect(r).toEqual({ ok: true, statements: [`${MYSQL_PROC};`] });
  });
  it("restore statement is the original as a single statement", () => {
    expect(buildRestoreStatement("mysql", `${MYSQL_PROC};`)).toBe(MYSQL_PROC);
  });
});

describe("buildApplyRoutineStatements - PostgreSQL", () => {
  const fn = `CREATE FUNCTION public.f(a integer) RETURNS integer LANGUAGE plpgsql AS $$
BEGIN
  RETURN a; -- ; inside dollar quote
END;
$$`;
  it("turns CREATE FUNCTION into CREATE OR REPLACE as one statement", () => {
    const r = buildApplyRoutineStatements({
      driver: "postgres",
      database: "public",
      kind: "function",
      name: "f",
      originalDdl: fn,
      ddl: fn,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.statements).toHaveLength(1);
      expect(r.statements[0].startsWith("CREATE OR REPLACE FUNCTION public.f")).toBe(true);
      expect(r.statements[0].endsWith("$$;")).toBe(true);
    }
  });
  it("leaves an existing CREATE OR REPLACE PROCEDURE alone", () => {
    const r = buildApplyRoutineStatements({
      driver: "postgres",
      database: "public",
      kind: "procedure",
      name: "p",
      originalDdl: null,
      ddl: buildRoutineTemplate("postgres", "procedure", "public"),
    });
    expect(r.ok && r.statements[0].startsWith("CREATE OR REPLACE PROCEDURE")).toBe(true);
  });
  it("trigger edit is DROP ... ON table + CREATE", () => {
    const orig =
      'CREATE TRIGGER trg BEFORE INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION f()';
    const r = buildApplyRoutineStatements({
      driver: "postgres",
      database: "public",
      kind: "trigger",
      name: "trg",
      originalDdl: orig,
      ddl: orig.replace("INSERT", "UPDATE"),
    });
    expect(r).toEqual({
      ok: true,
      statements: [
        'DROP TRIGGER IF EXISTS "trg" ON public.orders;',
        "CREATE TRIGGER trg BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION f();",
      ],
    });
  });
  it("trigger edit without a parsable table fails", () => {
    const r = buildApplyRoutineStatements({
      driver: "postgres",
      database: "public",
      kind: "trigger",
      name: "trg",
      originalDdl: "garbage",
      ddl: "CREATE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION f()",
    });
    expect(r).toEqual({ ok: false, error: "routineEditErrNoTable" });
  });
  it("new trigger template (helper function + trigger) splits into two statements", () => {
    const r = buildApplyRoutineStatements({
      driver: "postgres",
      database: "public",
      kind: "trigger",
      name: null,
      originalDdl: null,
      ddl: buildRoutineTemplate("postgres", "trigger", "public"),
    });
    expect(r.ok && r.statements).toHaveLength(2);
  });
  it("extracts quoted table names", () => {
    expect(
      extractPgTriggerTable('CREATE TRIGGER "my trg" AFTER DELETE ON "Sales"."Order Items" FOR EACH ROW EXECUTE FUNCTION f()'),
    ).toBe('"Sales"."Order Items"');
  });
});

describe("buildApplyRoutineStatements - SQLite", () => {
  const trg = `CREATE TRIGGER t1 AFTER INSERT ON a BEGIN
  INSERT INTO log VALUES (1);
  INSERT INTO log VALUES (2);
END`;
  it("drops then creates the trigger; body stays one statement", () => {
    const r = buildApplyRoutineStatements({
      driver: "sqlite",
      database: "main",
      kind: "trigger",
      name: "t1",
      originalDdl: trg,
      ddl: `${trg};`,
    });
    expect(r).toEqual({
      ok: true,
      statements: ['DROP TRIGGER IF EXISTS "t1";', `${trg};`],
    });
  });
});

describe("validation", () => {
  it("rejects empty text and non-CREATE text", () => {
    expect(
      buildApplyRoutineStatements({ driver: "mysql", database: "d", kind: "procedure", name: null, originalDdl: null, ddl: "  \n" }),
    ).toEqual({ ok: false, error: "routineEditErrEmpty" });
    const r = buildApplyRoutineStatements({
      driver: "mysql",
      database: "d",
      kind: "procedure",
      name: "p",
      originalDdl: null,
      ddl: "DROP DATABASE d",
    });
    expect(r).toEqual({ ok: false, error: "routineEditErrNotCreate", vars: { kind: "PROCEDURE" } });
  });
  it("allows leading comments before CREATE", () => {
    const r = buildApplyRoutineStatements({
      driver: "sqlite",
      database: "main",
      kind: "trigger",
      name: null,
      originalDdl: null,
      ddl: "-- note\n/* x */ CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT 1; END",
    });
    expect(r.ok).toBe(true);
  });
});

describe("buildRoutineTemplate", () => {
  it("produces a CREATE for every supported driver/kind", () => {
    for (const driver of ["mysql", "postgres", "sqlite"]) {
      for (const kind of ["procedure", "function", "trigger"] as const) {
        if (!supportsRoutineEditing(driver, kind)) continue;
        const r = buildApplyRoutineStatements({
          driver,
          database: "main",
          kind,
          name: null,
          originalDdl: null,
          ddl: buildRoutineTemplate(driver, kind, "main"),
        });
        expect(r.ok, `${driver}/${kind}`).toBe(true);
      }
    }
  });
});
