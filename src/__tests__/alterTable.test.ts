import { describe, expect, it } from "vitest";
import {
  buildAlterPlan,
  type AlterTableForm,
  type ExistingColumnBaseline,
  type ExistingColumnEdit,
} from "../components/alterTable";

function baseline(over: Partial<ExistingColumnBaseline>): ExistingColumnBaseline {
  return { name: "c", type: "int", notNull: false, defaultValue: "", ...over };
}

function edit(over: Partial<ExistingColumnEdit>): ExistingColumnEdit {
  return { original: "c", drop: false, name: "c", type: "int", notNull: false, defaultValue: "", ...over };
}

function form(over: Partial<AlterTableForm>): AlterTableForm {
  return {
    database: "shop",
    table: "users",
    baseline: [],
    existing: [],
    added: [],
    indexes: [],
    ...over,
  };
}

describe("buildAlterPlan: ADD COLUMN", () => {
  it("builds an ADD COLUMN statement per driver with correct identifier quoting", () => {
    const mysql = buildAlterPlan(
      "mysql",
      form({ added: [{ name: "age", type: "INT", notNull: true, defaultValue: "0" }] }),
    );
    expect(mysql.statements).toHaveLength(1);
    expect(mysql.statements[0]).toMatchObject({ kind: "addColumn", destructive: false });
    expect(mysql.statements[0].sql).toBe(
      "ALTER TABLE `shop`.`users` ADD COLUMN `age` INT NOT NULL DEFAULT 0;",
    );

    const pg = buildAlterPlan(
      "postgres",
      form({ added: [{ name: "age", type: "int", notNull: false, defaultValue: "" }] }),
    );
    expect(pg.statements[0].sql).toBe('ALTER TABLE "shop"."users" ADD COLUMN "age" int;');

    const sqlite = buildAlterPlan(
      "sqlite",
      form({ database: null, added: [{ name: "age", type: "INTEGER", notNull: false, defaultValue: "" }] }),
    );
    expect(sqlite.statements[0].sql).toBe('ALTER TABLE "users" ADD COLUMN "age" INTEGER;');
  });

  it("quotes string defaults and skips blank column names", () => {
    const plan = buildAlterPlan(
      "mysql",
      form({
        added: [
          { name: "note", type: "VARCHAR(50)", notNull: false, defaultValue: "hello" },
          { name: "  ", type: "TEXT", notNull: false, defaultValue: "" },
        ],
      }),
    );
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0].sql).toContain("DEFAULT 'hello'");
  });
});

describe("buildAlterPlan: rename / modify — MySQL", () => {
  it("uses RENAME COLUMN when only the name changes", () => {
    const plan = buildAlterPlan(
      "mysql",
      form({
        baseline: [baseline({ name: "old_name", type: "int" })],
        existing: [edit({ original: "old_name", name: "new_name", type: "int" })],
      }),
    );
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0]).toMatchObject({ kind: "renameColumn", destructive: false });
    expect(plan.statements[0].sql).toBe(
      "ALTER TABLE `shop`.`users` RENAME COLUMN `old_name` TO `new_name`;",
    );
  });

  it("uses CHANGE COLUMN with a full definition when type/null/default change", () => {
    const plan = buildAlterPlan(
      "mysql",
      form({
        baseline: [baseline({ name: "amount", type: "int", notNull: false, defaultValue: "" })],
        existing: [
          edit({ original: "amount", name: "amount", type: "bigint", notNull: true, defaultValue: "0" }),
        ],
      }),
    );
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0]).toMatchObject({ kind: "modifyColumn" });
    expect(plan.statements[0].sql).toBe(
      "ALTER TABLE `shop`.`users` CHANGE COLUMN `amount` `amount` bigint NOT NULL DEFAULT 0;",
    );
  });

  it("combines rename and redefinition in a single CHANGE COLUMN, quoting string defaults", () => {
    const plan = buildAlterPlan(
      "mysql",
      form({
        baseline: [baseline({ name: "status", type: "varchar(20)", notNull: false, defaultValue: "" })],
        existing: [
          edit({
            original: "status",
            name: "state",
            type: "varchar(20)",
            notNull: true,
            defaultValue: "pending",
          }),
        ],
      }),
    );
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0].kind).toBe("renameColumn");
    expect(plan.statements[0].sql).toBe(
      "ALTER TABLE `shop`.`users` CHANGE COLUMN `status` `state` varchar(20) NOT NULL DEFAULT 'pending';",
    );
  });

  it("produces nothing when nothing actually changed", () => {
    const plan = buildAlterPlan(
      "mysql",
      form({
        baseline: [baseline({ name: "id", type: "int", notNull: true, defaultValue: "" })],
        existing: [edit({ original: "id", name: "id", type: "int", notNull: true, defaultValue: "" })],
      }),
    );
    expect(plan.statements).toHaveLength(0);
    expect(plan.unsupported).toHaveLength(0);
  });
});

describe("buildAlterPlan: rename / modify — PostgreSQL", () => {
  it("emits one ALTER COLUMN per changed facet, using the new name after rename", () => {
    const plan = buildAlterPlan(
      "postgres",
      form({
        baseline: [baseline({ name: "v", type: "int", notNull: false, defaultValue: "" })],
        existing: [
          edit({ original: "v", name: "value", type: "bigint", notNull: true, defaultValue: "0" }),
        ],
      }),
    );
    const sqls = plan.statements.map((s) => s.sql);
    expect(sqls).toEqual([
      'ALTER TABLE "shop"."users" RENAME COLUMN "v" TO "value";',
      'ALTER TABLE "shop"."users" ALTER COLUMN "value" TYPE bigint;',
      'ALTER TABLE "shop"."users" ALTER COLUMN "value" SET NOT NULL;',
      'ALTER TABLE "shop"."users" ALTER COLUMN "value" SET DEFAULT 0;',
    ]);
  });

  it("keeps existing default expressions verbatim when unedited (no spurious ALTER)", () => {
    const plan = buildAlterPlan(
      "postgres",
      form({
        baseline: [
          baseline({ name: "status", type: "character varying(20)", defaultValue: "'pending'::character varying" }),
        ],
        existing: [
          edit({
            original: "status",
            name: "status",
            type: "character varying(20)",
            defaultValue: "'pending'::character varying",
          }),
        ],
      }),
    );
    expect(plan.statements).toHaveLength(0);
  });

  it("drops the default when the field is cleared", () => {
    const plan = buildAlterPlan(
      "postgres",
      form({
        baseline: [baseline({ name: "status", type: "text", defaultValue: "'pending'" })],
        existing: [edit({ original: "status", name: "status", type: "text", defaultValue: "" })],
      }),
    );
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0].sql).toBe('ALTER TABLE "shop"."users" ALTER COLUMN "status" DROP DEFAULT;');
  });

  it("warns via key/foreign_key style separation is not applicable; type-only diffs stay isolated", () => {
    const plan = buildAlterPlan(
      "postgres",
      form({
        baseline: [baseline({ name: "v", type: "int" })],
        existing: [edit({ original: "v", name: "v", type: "bigint" })],
      }),
    );
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0].sql).toBe('ALTER TABLE "shop"."users" ALTER COLUMN "v" TYPE bigint;');
  });
});

describe("buildAlterPlan: rename / modify — SQLite", () => {
  it("renames natively", () => {
    const plan = buildAlterPlan(
      "sqlite",
      form({
        database: null,
        baseline: [baseline({ name: "old", type: "TEXT" })],
        existing: [edit({ original: "old", name: "new", type: "TEXT" })],
      }),
    );
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0].sql).toBe('ALTER TABLE "users" RENAME COLUMN "old" TO "new";');
    expect(plan.unsupported).toHaveLength(0);
  });

  it("reports an in-place modify as unsupported instead of emitting broken SQL", () => {
    const plan = buildAlterPlan(
      "sqlite",
      form({
        database: null,
        baseline: [baseline({ name: "v", type: "TEXT", notNull: false })],
        existing: [edit({ original: "v", name: "v", type: "INTEGER", notNull: false })],
      }),
    );
    expect(plan.statements).toHaveLength(0);
    expect(plan.unsupported).toEqual([{ column: "v", reason: "sqliteInPlaceModify" }]);
  });

  it("still renames even when the type also changes, and reports the type change separately", () => {
    const plan = buildAlterPlan(
      "sqlite",
      form({
        database: null,
        baseline: [baseline({ name: "old", type: "TEXT" })],
        existing: [edit({ original: "old", name: "new", type: "INTEGER" })],
      }),
    );
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0].sql).toBe('ALTER TABLE "users" RENAME COLUMN "old" TO "new";');
    expect(plan.unsupported).toEqual([{ column: "old", reason: "sqliteInPlaceModify" }]);
  });
});

describe("buildAlterPlan: DROP COLUMN", () => {
  it("drops regardless of other edited fields, and flags it destructive", () => {
    const plan = buildAlterPlan(
      "mysql",
      form({
        baseline: [baseline({ name: "gone", type: "int" })],
        existing: [edit({ original: "gone", drop: true, name: "ignored", type: "text" })],
      }),
    );
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0]).toMatchObject({ kind: "dropColumn", destructive: true });
    expect(plan.statements[0].sql).toBe("ALTER TABLE `shop`.`users` DROP COLUMN `gone`;");
  });

  it("supports DROP COLUMN natively on SQLite too", () => {
    const plan = buildAlterPlan(
      "sqlite",
      form({
        database: null,
        baseline: [baseline({ name: "gone", type: "TEXT" })],
        existing: [edit({ original: "gone", drop: true })],
      }),
    );
    expect(plan.statements[0].sql).toBe('ALTER TABLE "users" DROP COLUMN "gone";');
  });
});

describe("buildAlterPlan: CREATE INDEX", () => {
  it("builds a plain and a unique index with dialect quoting", () => {
    const plain = buildAlterPlan(
      "mysql",
      form({ indexes: [{ name: "idx_email", columns: ["email"], unique: false }] }),
    );
    expect(plain.statements[0].sql).toBe(
      "CREATE INDEX `idx_email` ON `shop`.`users` (`email`);",
    );
    expect(plain.statements[0].kind).toBe("createIndex");

    const unique = buildAlterPlan(
      "postgres",
      form({ indexes: [{ name: "idx_email_uniq", columns: ["email"], unique: true }] }),
    );
    expect(unique.statements[0].sql).toBe(
      'CREATE UNIQUE INDEX "idx_email_uniq" ON "shop"."users" ("email");',
    );
  });

  it("supports composite indexes and skips rows with no name or no columns", () => {
    const plan = buildAlterPlan(
      "sqlite",
      form({
        database: null,
        indexes: [
          { name: "idx_multi", columns: ["a", "b"], unique: false },
          { name: "", columns: ["c"], unique: false },
          { name: "idx_empty", columns: [], unique: false },
        ],
      }),
    );
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0].sql).toBe('CREATE INDEX "idx_multi" ON "users" ("a", "b");');
  });
});

describe("buildAlterPlan: statement ordering", () => {
  it("orders ADD before RENAME/MODIFY before DROP before CREATE INDEX", () => {
    const plan = buildAlterPlan(
      "mysql",
      form({
        baseline: [
          baseline({ name: "renamed_from", type: "int" }),
          baseline({ name: "dropped", type: "int" }),
        ],
        existing: [
          edit({ original: "renamed_from", name: "renamed_to", type: "int" }),
          edit({ original: "dropped", drop: true }),
        ],
        added: [{ name: "added", type: "TEXT", notNull: false, defaultValue: "" }],
        indexes: [{ name: "idx_added", columns: ["added"], unique: false }],
      }),
    );
    expect(plan.statements.map((s) => s.kind)).toEqual([
      "addColumn",
      "renameColumn",
      "dropColumn",
      "createIndex",
    ]);
  });
});
