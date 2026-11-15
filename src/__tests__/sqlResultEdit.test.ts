import { describe, expect, it } from "vitest";
import {
  analyzeSqlEditShape,
  parseIdentPath,
  resolveEditDatabase,
  resolveSqlEdit,
  sqlEditActive,
  sqlEditToggleView,
  withSqlEditTarget,
  type SqlEditShape,
  type SqlEditTabLike,
} from "../sqlResultEdit";
import type { TableColumnInfo } from "../api/tauri";

const col = (name: string, key = ""): TableColumnInfo => ({
  name,
  data_type: "int",
  nullable: !key,
  key,
  default: null,
  extra: "",
  referenced_table: null,
  referenced_column: null,
});
const TABLE = [col("id", "PRI"), col("name"), col("price")];
const names = (...n: string[]) => n.map((name) => ({ name }));

function shapeOf(sql: string, driver = "mysql"): SqlEditShape {
  const r = analyzeSqlEditShape(sql, driver);
  if (!r.ok) throw new Error(`blocked: ${r.reason}`);
  return r.shape;
}
function reasonOf(sql: string, driver = "mysql") {
  const r = analyzeSqlEditShape(sql, driver);
  return r.ok ? "ok" : r.reason;
}

describe("analyzeSqlEditShape", () => {
  it("accepts single-table selects", () => {
    expect(shapeOf("SELECT * FROM orders WHERE status = 'failed' ORDER BY created_at DESC LIMIT 10")).toEqual(
      {
        schema: null,
        table: "orders",
        items: [{ kind: "star" }],
      },
    );
    expect(shapeOf("select id, name from `db`.`t`;").schema).toBe("db");
    expect(shapeOf('SELECT o.id, o.name FROM "public"."Orders" AS o', "postgres")).toMatchObject({
      schema: "public",
      table: "Orders",
    });
    expect(shapeOf("SELECT t.* FROM t").items).toEqual([{ kind: "star" }]);
    expect(shapeOf("SELECT * FROM Orders", "postgres").table).toBe("orders");
    expect(shapeOf("-- c\nSELECT id FROM t /* x */").table).toBe("t");
    expect(shapeOf("SELECT rowid, * FROM main.t", "sqlite").items).toHaveLength(2);
  });
  it("classifies expressions and aliases", () => {
    const s = shapeOf("SELECT id, price * 1.1 AS gross, name AS label, id AS id FROM t");
    expect(s.items).toEqual([
      { kind: "plain" },
      { kind: "derived", outputName: "gross" },
      { kind: "derived", outputName: "label" },
      { kind: "plain" },
    ]);
    expect(shapeOf("SELECT (SELECT COUNT(*) FROM c WHERE c.o = t.id) AS n FROM t").items).toEqual([
      { kind: "derived", outputName: "n" },
    ]);
  });
  it.each([
    ["SELECT a.id FROM a JOIN b ON a.id = b.id", "join"],
    ["SELECT * FROM a, b", "join"],
    ["SELECT DISTINCT id FROM t", "distinct"],
    ["SELECT id FROM t GROUP BY id", "grouping"],
    ["SELECT id FROM t GROUP BY id HAVING count(*) > 1", "grouping"],
    ["SELECT id FROM t UNION SELECT id FROM u", "setOperation"],
    ["SELECT id FROM t INTERSECT SELECT id FROM u", "setOperation"],
    ["SELECT id, COUNT(*) AS c FROM t", "aggregate"],
    ["SELECT id, row_number() OVER (ORDER BY id) AS rn FROM t", "aggregate"],
    ["SELECT * FROM (SELECT * FROM t) x", "subquery"],
    ["WITH x AS (SELECT 1) SELECT * FROM x", "cte"],
    ["SELECT * FROM t; SELECT * FROM u", "multiStatement"],
    ["SELECT id, price * 2 FROM t", "unaliasedExpression"],
    ["SELECT id, lower(name) FROM t", "unaliasedExpression"],
    ["SELECT id, NULL FROM t", "unaliasedExpression"],
    ["SELECT id, 1 FROM t", "unaliasedExpression"],
    ["SELECT * FROM t USE INDEX (i)", "unsupportedFrom"],
    ["SELECT x.id FROM t", "unsupportedFrom"],
    ["SELECT 1", "unsupportedFrom"],
  ])("blocks %s", (sql, reason) => {
    expect(reasonOf(sql)).toBe(reason);
  });
  it("returns reason null for non-SELECT statements", () => {
    for (const sql of ["UPDATE t SET a = 1", "SHOW TABLES", "INSERT INTO t VALUES (1)", "", "(SELECT 1)"]) {
      const r = analyzeSqlEditShape(sql, "mysql");
      expect(r).toEqual({ ok: false, reason: null });
    }
  });
  it("ignores keywords inside literals and comments", () => {
    expect(reasonOf("SELECT id FROM t WHERE note = 'a JOIN b GROUP BY c'")).toBe("ok");
    expect(reasonOf("SELECT id FROM t -- UNION SELECT 1")).toBe("ok");
    expect(reasonOf("SELECT id FROM t WHERE x IN (SELECT y FROM u GROUP BY y)")).toBe("ok");
  });
  it("treats double quotes as strings in MySQL but identifiers elsewhere", () => {
    expect(reasonOf('SELECT "id" FROM t')).toBe("unaliasedExpression");
    expect(reasonOf('SELECT "id" FROM t', "postgres")).toBe("ok");
  });
});

describe("parseIdentPath", () => {
  it("folds unquoted PostgreSQL identifiers only", () => {
    expect(parseIdentPath('Public."Mixed"', "postgres")).toEqual(["public", "Mixed"]);
    expect(parseIdentPath("Public.Mixed", "mysql")).toEqual(["Public", "Mixed"]);
    expect(parseIdentPath("`a``b`", "mysql")).toEqual(["a`b"]);
    expect(parseIdentPath("a b", "mysql")).toBeNull();
    expect(parseIdentPath("a.", "mysql")).toBeNull();
    expect(parseIdentPath("1a", "mysql")).toBeNull();
  });
});

describe("resolveSqlEdit", () => {
  const run = (
    sql: string,
    cols: string[],
    tableColumns = TABLE,
    rowIdentity: Parameters<typeof resolveSqlEdit>[0]["rowIdentity"] = null,
    driver = "mysql",
  ) =>
    resolveSqlEdit({ shape: shapeOf(sql, driver), resultColumns: names(...cols), tableColumns, rowIdentity });

  it("allows select * with the primary key", () => {
    expect(run("SELECT * FROM t", ["id", "name", "price"])).toEqual({
      ok: true,
      editableColumns: ["id", "name", "price"],
      insertable: true,
    });
  });
  it("makes expression columns read-only per column", () => {
    expect(run("SELECT id, name, price * 1.1 AS gross FROM t", ["id", "name", "gross"])).toEqual({
      ok: true,
      editableColumns: ["id", "name"],
      insertable: false,
    });
  });
  it("blocks when an alias shadows a real column", () => {
    expect(run("SELECT name AS id, price FROM t", ["id", "price"])).toEqual({
      ok: false,
      reason: "nameClash",
    });
    expect(run("SELECT id, price * 2 AS NAME FROM t", ["id", "NAME"])).toEqual({
      ok: false,
      reason: "nameClash",
    });
  });
  it("blocks when the key is missing or partial", () => {
    expect(run("SELECT name FROM t", ["name"])).toEqual({ ok: false, reason: "noKey" });
    const composite = [col("a", "PRI"), col("b", "PRI"), col("c")];
    expect(run("SELECT a, c FROM t", ["a", "c"], composite)).toEqual({ ok: false, reason: "noKey" });
    expect(run("SELECT a, b, c FROM t", ["a", "b", "c"], composite).ok).toBe(true);
  });
  it("blocks duplicate output names and missing tables", () => {
    expect(run("SELECT id, id FROM t", ["id", "id"])).toEqual({ ok: false, reason: "duplicateColumn" });
    expect(
      resolveSqlEdit({
        shape: shapeOf("SELECT * FROM t"),
        resultColumns: names("id"),
        tableColumns: null,
        rowIdentity: null,
      }),
    ).toEqual({ ok: false, reason: "tableNotFound" });
  });
  it("uses unique keys, rowid and rejects all_columns / none", () => {
    const noPk = [col("a"), col("b")];
    const uk = { strategy: "unique_key", hidden_column: null, key_columns: ["a"] } as never;
    expect(run("SELECT * FROM t", ["a", "b"], noPk, uk).ok).toBe(true);
    expect(run("SELECT b FROM t", ["b"], noPk, uk)).toEqual({ ok: false, reason: "noKey" });
    const rowid = { strategy: "rowid", hidden_column: "rowid", key_columns: [] } as never;
    expect(run("SELECT * FROM t", ["a", "b"], noPk, rowid, "sqlite")).toEqual({ ok: false, reason: "noKey" });
    expect(run("SELECT rowid, * FROM t", ["rowid", "a", "b"], noPk, rowid, "sqlite")).toEqual({
      ok: true,
      editableColumns: ["a", "b"],
      insertable: false,
    });
    const all = { strategy: "all_columns", hidden_column: null, key_columns: [] } as never;
    expect(run("SELECT * FROM t", ["a", "b"], noPk, all)).toEqual({ ok: false, reason: "noRowIdentity" });
    expect(run("SELECT * FROM t", ["a", "b"], noPk, null)).toEqual({ ok: false, reason: "noKey" });
  });
});

describe("tab helpers", () => {
  const avail = {
    status: "available" as const,
    sql: "SELECT 1",
    database: "db",
    table: "t",
    tableColumns: TABLE,
    rowIdentity: null,
    editableColumns: ["id", "name"],
    insertable: true,
  };
  const base: SqlEditTabLike = {
    kind: "query",
    tableColumns: null,
    rowIdentity: null,
    lastExecutedSql: "SELECT 1",
  };
  it("is active only when on, available and for the same SQL", () => {
    expect(sqlEditActive({ ...base, sqlEdit: avail })).toBe(false);
    expect(sqlEditActive({ ...base, sqlEdit: avail, sqlEditOn: true })).toBe(true);
    expect(sqlEditActive({ ...base, sqlEdit: avail, sqlEditOn: true, lastExecutedSql: "SELECT 2" })).toBe(
      false,
    );
    expect(sqlEditActive({ ...base, kind: "table", sqlEdit: avail, sqlEditOn: true })).toBe(false);
  });
  it("overlays the edit target only while active", () => {
    const off = { ...base, sqlEdit: avail };
    expect(withSqlEditTarget(off)).toBe(off);
    const on = withSqlEditTarget({ ...off, sqlEditOn: true });
    expect(on).toMatchObject({ database: "db", table: "t", tableColumns: TABLE });
  });
  it("derives the toggle view", () => {
    expect(sqlEditToggleView({ ...base })).toBeNull();
    expect(sqlEditToggleView({ ...base, sqlEdit: { status: "checking", sql: "SELECT 1" } })).toBeNull();
    expect(sqlEditToggleView({ ...base, sqlEdit: { status: "checking", sql: "stale" } })).toBeNull();
    expect(
      sqlEditToggleView({ ...base, sqlEdit: { status: "unavailable", sql: "SELECT 1", reason: "join" } }),
    ).toEqual({
      state: "unavailable",
      reason: "join",
    });
    expect(sqlEditToggleView({ ...base, sqlEdit: avail })).toEqual({ state: "off" });
    expect(sqlEditToggleView({ ...base, sqlEdit: avail, sqlEditOn: true })).toEqual({ state: "on" });
  });
});

describe("resolveEditDatabase", () => {
  it("prefers the qualifier, then main for SQLite, then tab/profile", () => {
    const a = { tabDatabase: "tabdb", profileDatabase: "pdb" };
    expect(resolveEditDatabase({ driver: "mysql", schema: "x", ...a })).toBe("x");
    expect(resolveEditDatabase({ driver: "mysql", schema: null, ...a })).toBe("tabdb");
    expect(
      resolveEditDatabase({ driver: "postgres", schema: null, tabDatabase: null, profileDatabase: "pdb" }),
    ).toBe("pdb");
    expect(resolveEditDatabase({ driver: "sqlite", schema: null, ...a })).toBe("main");
    expect(
      resolveEditDatabase({ driver: "mysql", schema: null, tabDatabase: null, profileDatabase: null }),
    ).toBeNull();
  });
});
