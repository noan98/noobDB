import { describe, it, expect } from "vitest";
import type { ViewRebuildPlan } from "../api/tauri";
import type { AlterStatement, ExistingColumnBaseline, ExistingColumnEdit } from "../components/alterTable";
import { applyViewRebuild, canRebuildViews, materializedViews, typeChangedColumns } from "../viewRebuild";

const base = (name: string, type: string): ExistingColumnBaseline =>
  ({ name, type, notNull: false, defaultValue: null, extra: "", comment: "" }) as ExistingColumnBaseline;
const edit = (
  original: string,
  type: string,
  extra: Partial<ExistingColumnEdit> = {},
): ExistingColumnEdit => ({
  original,
  drop: false,
  name: original,
  type,
  notNull: false,
  defaultValue: "",
  ...extra,
});

const plan = (over: Partial<ViewRebuildPlan> = {}): ViewRebuildPlan => ({
  views: [
    { schema: "s", name: "v1", kind: "view", size_bytes: null, est_rows: null },
    { schema: "s", name: "mv", kind: "materialized_view", size_bytes: 1000, est_rows: 5 },
  ],
  drop_statements: ['DROP MATERIALIZED VIEW "s"."mv";', 'DROP VIEW "s"."v1";'],
  create_statements: [
    'CREATE VIEW "s"."v1" AS\nSELECT 1;',
    'CREATE MATERIALIZED VIEW "s"."mv" AS\nSELECT 1\nWITH DATA;',
  ],
  restore_statements: ['GRANT SELECT ON "s"."v1" TO PUBLIC;'],
  blockers: [],
  ...over,
});

const alter: AlterStatement = {
  sql: "ALTER TABLE t ALTER COLUMN a TYPE bigint;",
  kind: "modifyColumn",
  destructive: false,
};

describe("typeChangedColumns", () => {
  const b = [base("a", "integer"), base("b", "text")];
  it("PostgreSQL の型変更だけを返す", () => {
    expect(typeChangedColumns("postgres", b, [edit("a", "bigint"), edit("b", "text")])).toEqual(["a"]);
  });
  it("型欄が空なら変更なし・DROP は除外・他ドライバは空", () => {
    expect(typeChangedColumns("postgres", b, [edit("a", "  ")])).toEqual([]);
    expect(typeChangedColumns("postgres", b, [edit("a", "bigint", { drop: true })])).toEqual([]);
    expect(typeChangedColumns("mysql", b, [edit("a", "bigint")])).toEqual([]);
    expect(typeChangedColumns("sqlite", b, [edit("a", "bigint")])).toEqual([]);
  });
  it("リネームしても元の列名で返す", () => {
    expect(typeChangedColumns("postgres", b, [edit("a", "bigint", { name: "a2" })])).toEqual(["a"]);
  });
});

describe("applyViewRebuild", () => {
  it("DROP を先頭、CREATE と復元を末尾に差し込む", () => {
    const out = applyViewRebuild([alter], plan());
    expect(out.map((s) => s.kind)).toEqual([
      "dropDependentView",
      "dropDependentView",
      "modifyColumn",
      "recreateDependentView",
      "recreateDependentView",
      "recreateDependentView",
    ]);
    expect(out[0].sql).toContain("DROP MATERIALIZED VIEW");
    expect(out[2]).toBe(alter);
    expect(out.every((s) => !s.destructive)).toBe(true);
  });
  it("依存が無い・止める依存があるときは文を変えない", () => {
    const stmts = [alter];
    expect(
      applyViewRebuild(
        stmts,
        plan({ views: [], drop_statements: [], create_statements: [], restore_statements: [] }),
      ),
    ).toBe(stmts);
    expect(
      applyViewRebuild(stmts, plan({ blockers: [{ kind: "policy", description: "policy p on table t" }] })),
    ).toBe(stmts);
  });
  it("canRebuildViews / materializedViews", () => {
    expect(canRebuildViews(null)).toBe(false);
    expect(canRebuildViews(plan())).toBe(true);
    expect(materializedViews(plan()).map((v) => v.name)).toEqual(["mv"]);
  });
});
