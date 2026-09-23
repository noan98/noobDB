import { describe, expect, it } from "vitest";
import {
  buildAlterPlan,
  supportsComments,
  type AlterTableForm,
  type ExistingColumnBaseline,
  type ExistingColumnEdit,
} from "../components/alterTable";

// テーブル / 列コメントの編集 DDL 生成 (#1002)。

function baseline(over: Partial<ExistingColumnBaseline>): ExistingColumnBaseline {
  return { name: "c", type: "int", notNull: false, defaultValue: "", extra: "", comment: "", ...over };
}

function edit(over: Partial<ExistingColumnEdit>): ExistingColumnEdit {
  return { original: "c", drop: false, name: "c", type: "int", notNull: false, defaultValue: "", ...over };
}

function form(over: Partial<AlterTableForm>): AlterTableForm {
  return { database: "shop", table: "users", baseline: [], existing: [], added: [], indexes: [], ...over };
}

const sqls = (driver: string, f: AlterTableForm) => buildAlterPlan(driver, f).statements.map((s) => s.sql);

describe("supportsComments", () => {
  it("SQLite だけ非対応", () => {
    expect(supportsComments("mysql")).toBe(true);
    expect(supportsComments("postgres")).toBe(true);
    expect(supportsComments("duckdb")).toBe(true);
    expect(supportsComments("mssql")).toBe(true);
    expect(supportsComments("sqlite")).toBe(false);
  });
});

describe("テーブルコメント", () => {
  it("MySQL は ALTER TABLE ... COMMENT = (バックスラッシュ/クオートをエスケープ)", () => {
    expect(sqls("mysql", form({ tableComment: { before: "", after: "it's a\\b" } }))).toEqual([
      "ALTER TABLE `shop`.`users` COMMENT = 'it''s a\\\\b';",
    ]);
  });

  it("PostgreSQL / DuckDB は COMMENT ON TABLE、空は IS NULL", () => {
    expect(sqls("postgres", form({ database: "public", tableComment: { before: "", after: "会員" } }))).toEqual([
      `COMMENT ON TABLE "public"."users" IS '会員';`,
    ]);
    expect(sqls("duckdb", form({ database: "main", tableComment: { before: "x", after: "" } }))).toEqual([
      `COMMENT ON TABLE "main"."users" IS NULL;`,
    ]);
  });

  it("MSSQL は既存値の有無で add / update / drop を選ぶ", () => {
    expect(sqls("mssql", form({ tableComment: { before: "", after: "顧客" } }))).toEqual([
      "EXEC sp_addextendedproperty @name = N'MS_Description', @value = N'顧客', @level0type = N'SCHEMA', @level0name = N'dbo', @level1type = N'TABLE', @level1name = N'users';",
    ]);
    expect(sqls("mssql", form({ tableComment: { before: "a", after: "b'c" } }))[0]).toContain(
      "EXEC sp_updateextendedproperty @name = N'MS_Description', @value = N'b''c'",
    );
    expect(sqls("mssql", form({ tableComment: { before: "a", after: "" } }))).toEqual([
      "EXEC sp_dropextendedproperty @name = N'MS_Description', @level0type = N'SCHEMA', @level0name = N'dbo', @level1type = N'TABLE', @level1name = N'users';",
    ]);
  });

  it("変更なし / SQLite では何も生成しない", () => {
    expect(sqls("mysql", form({ tableComment: { before: "a", after: "a" } }))).toEqual([]);
    expect(sqls("sqlite", form({ tableComment: { before: "", after: "x" } }))).toEqual([]);
  });
});

describe("列コメント", () => {
  it("MySQL はコメントのみの変更でも列定義を保ったまま CHANGE COLUMN する", () => {
    const plan = buildAlterPlan(
      "mysql",
      form({
        baseline: [baseline({ name: "id", type: "bigint", notNull: true, extra: "auto_increment" })],
        existing: [edit({ original: "id", name: "id", type: "bigint", notNull: true, comment: "主キー" })],
      }),
    );
    expect(plan.statements).toEqual([
      {
        sql: "ALTER TABLE `shop`.`users` CHANGE COLUMN `id` `id` bigint NOT NULL auto_increment COMMENT '主キー';",
        kind: "comment",
        destructive: false,
      },
    ]);
  });

  it("MySQL は型変更の CHANGE COLUMN でも既存コメントを保持する", () => {
    expect(
      sqls(
        "mysql",
        form({
          baseline: [baseline({ name: "n", type: "int", comment: "数量" })],
          existing: [edit({ original: "n", name: "n", type: "bigint" })],
        }),
      ),
    ).toEqual(["ALTER TABLE `shop`.`users` CHANGE COLUMN `n` `n` bigint COMMENT '数量';"]);
  });

  it("MySQL でコメントを空にすると COMMENT '' で明示的に消す", () => {
    expect(
      sqls(
        "mysql",
        form({
          baseline: [baseline({ name: "n", comment: "old" })],
          existing: [edit({ original: "n", name: "n", comment: "" })],
        }),
      ),
    ).toEqual(["ALTER TABLE `shop`.`users` CHANGE COLUMN `n` `n` int COMMENT '';"]);
  });

  it("PostgreSQL はリネームの後にリネーム後の列名で COMMENT ON COLUMN する", () => {
    expect(
      sqls(
        "postgres",
        form({
          database: "public",
          baseline: [baseline({ name: "v", type: "integer", comment: "" })],
          existing: [edit({ original: "v", name: "value", type: "integer", comment: "値" })],
        }),
      ),
    ).toEqual([
      `ALTER TABLE "public"."users" RENAME COLUMN "v" TO "value";`,
      `COMMENT ON COLUMN "public"."users"."value" IS '値';`,
    ]);
  });

  it("MSSQL は列レベルの拡張プロパティ", () => {
    expect(
      sqls(
        "mssql",
        form({
          baseline: [baseline({ name: "qty", comment: "" })],
          existing: [edit({ original: "qty", name: "qty", comment: "数量" })],
        }),
      ),
    ).toEqual([
      "EXEC sp_addextendedproperty @name = N'MS_Description', @value = N'数量', @level0type = N'SCHEMA', @level0name = N'dbo', @level1type = N'TABLE', @level1name = N'users', @level2type = N'COLUMN', @level2name = N'qty';",
    ]);
  });

  it("SQLite はコメント入力を無視し、DROP 予定の列にはコメント文を出さない", () => {
    expect(
      sqls(
        "sqlite",
        form({ baseline: [baseline({ name: "n" })], existing: [edit({ original: "n", name: "n", comment: "x" })] }),
      ),
    ).toEqual([]);
    expect(
      sqls(
        "postgres",
        form({
          baseline: [baseline({ name: "n" })],
          existing: [edit({ original: "n", name: "n", drop: true, comment: "x" })],
        }),
      ),
    ).toEqual([`ALTER TABLE "shop"."users" DROP COLUMN "n";`]);
  });

  it("コメント未指定 (undefined) の編集は変更なし扱い", () => {
    expect(
      sqls(
        "postgres",
        form({ baseline: [baseline({ name: "n", comment: "keep" })], existing: [edit({ original: "n", name: "n" })] }),
      ),
    ).toEqual([]);
  });
});
