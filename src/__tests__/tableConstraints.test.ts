import { describe, expect, it } from "vitest";
import { buildAlterPlan, type AlterTableForm } from "../components/alterTable";
import { buildCreateTableSql, type ColumnDef } from "../components/createTable";
import { emptyForeignKey, type ForeignKeyDef } from "../components/tableConstraints";

function form(over: Partial<AlterTableForm>): AlterTableForm {
  return { database: "shop", table: "orders", baseline: [], existing: [], added: [], indexes: [], ...over };
}

const fk: ForeignKeyDef = {
  name: "fk_orders_user",
  columns: ["user_id"],
  refTable: "users",
  refColumns: ["id"],
  onDelete: "CASCADE",
  onUpdate: "SET NULL",
};

describe("ALTER TABLE: add foreign key / CHECK (#1191)", () => {
  it("mysql", () => {
    const p = buildAlterPlan(
      "mysql",
      form({ addedForeignKeys: [fk], addedChecks: [{ name: "ck_qty", expression: "qty > 0" }] }),
    );
    expect(p.statements.map((s) => s.sql)).toEqual([
      "ALTER TABLE `shop`.`orders` ADD CONSTRAINT `fk_orders_user` FOREIGN KEY (`user_id`) REFERENCES `shop`.`users` (`id`) ON DELETE CASCADE ON UPDATE SET NULL;",
      "ALTER TABLE `shop`.`orders` ADD CONSTRAINT `ck_qty` CHECK (qty > 0);",
    ]);
    expect(p.statements.every((s) => !s.destructive)).toBe(true);
  });

  it("postgres (composite key, unnamed, no actions)", () => {
    const p = buildAlterPlan(
      "postgres",
      form({
        database: "public",
        addedForeignKeys: [
          { ...emptyForeignKey(), columns: ["a", "b"], refTable: "t", refColumns: ["x", "y"] },
        ],
        addedChecks: [{ name: "", expression: " qty > 0 " }],
      }),
    );
    expect(p.statements.map((s) => s.sql)).toEqual([
      'ALTER TABLE "public"."orders" ADD FOREIGN KEY ("a", "b") REFERENCES "public"."t" ("x", "y");',
      'ALTER TABLE "public"."orders" ADD CHECK (qty > 0);',
    ]);
  });

  it("ignores incomplete rows", () => {
    const p = buildAlterPlan(
      "postgres",
      form({
        addedForeignKeys: [{ ...fk, refColumns: [] }, { ...fk, refTable: " " }],
        addedChecks: [{ name: "x", expression: "  " }],
      }),
    );
    expect(p.statements).toEqual([]);
  });
});

describe("ALTER TABLE: drop foreign key / CHECK (#1191)", () => {
  it("mysql uses DROP FOREIGN KEY / DROP CHECK", () => {
    const p = buildAlterPlan("mysql", form({ droppedForeignKeys: ["fk1"], droppedChecks: ["ck1"] }));
    expect(p.statements.map((s) => s.sql)).toEqual([
      "ALTER TABLE `shop`.`orders` DROP FOREIGN KEY `fk1`;",
      "ALTER TABLE `shop`.`orders` DROP CHECK `ck1`;",
    ]);
    expect(p.statements.every((s) => s.destructive)).toBe(true);
  });

  it("postgres uses DROP CONSTRAINT and quotes identifiers", () => {
    const p = buildAlterPlan(
      "postgres",
      form({ database: "public", droppedForeignKeys: ['we"ird'], droppedChecks: ["ck1"] }),
    );
    expect(p.statements.map((s) => s.sql)).toEqual([
      'ALTER TABLE "public"."orders" DROP CONSTRAINT "we""ird";',
      'ALTER TABLE "public"."orders" DROP CONSTRAINT "ck1";',
    ]);
  });

  it("drops constraints before dropping columns, adds after renames", () => {
    const p = buildAlterPlan(
      "postgres",
      form({
        database: "public",
        baseline: [{ name: "u", type: "int", notNull: false, defaultValue: "", extra: "" }],
        existing: [
          { original: "u", drop: true, name: "u", type: "int", notNull: false, defaultValue: "" },
        ],
        droppedForeignKeys: ["fk1"],
        addedChecks: [{ name: "c", expression: "1 = 1" }],
      }),
    );
    expect(p.statements.map((s) => s.kind)).toEqual(["dropForeignKey", "addCheck", "dropColumn"]);
  });
});

describe("SQLite: ALTER constraints are unsupported (#1191)", () => {
  it("emits no statements and reports unsupported", () => {
    const p = buildAlterPlan(
      "sqlite",
      form({
        addedForeignKeys: [fk],
        addedChecks: [{ name: "", expression: "qty > 0" }],
        droppedForeignKeys: ["fk1"],
        droppedChecks: ["ck1"],
      }),
    );
    expect(p.statements).toEqual([]);
    expect(p.unsupported).toHaveLength(4);
    expect(p.unsupported.every((u) => u.reason === "sqliteConstraintAlter")).toBe(true);
  });
});

describe("CREATE TABLE: foreign key / CHECK (#1191)", () => {
  const cols: ColumnDef[] = [
    { name: "id", type: "INTEGER", notNull: true, primaryKey: true, unique: false, autoIncrement: false, defaultValue: "" },
    { name: "user_id", type: "INTEGER", notNull: false, primaryKey: false, unique: false, autoIncrement: false, defaultValue: "" },
  ];
  const checks = [{ name: "ck", expression: "user_id > 0" }];

  it("mysql", () => {
    expect(
      buildCreateTableSql("mysql", { database: "shop", table: "orders", columns: cols, foreignKeys: [fk], checks }),
    ).toBe(
      "CREATE TABLE `shop`.`orders` (\n  `id` INTEGER NOT NULL,\n  `user_id` INTEGER,\n  PRIMARY KEY (`id`),\n  CONSTRAINT `fk_orders_user` FOREIGN KEY (`user_id`) REFERENCES `shop`.`users` (`id`) ON DELETE CASCADE ON UPDATE SET NULL,\n  CONSTRAINT `ck` CHECK (user_id > 0)\n);",
    );
  });

  it("postgres", () => {
    expect(
      buildCreateTableSql("postgres", { database: "public", table: "orders", columns: cols, foreignKeys: [{ ...fk, onUpdate: "" }], checks }),
    ).toContain(
      '  CONSTRAINT "fk_orders_user" FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id") ON DELETE CASCADE,\n  CONSTRAINT "ck" CHECK (user_id > 0)\n);',
    );
  });

  it("sqlite does not qualify the referenced table", () => {
    expect(
      buildCreateTableSql("sqlite", { database: "main", table: "orders", columns: cols, foreignKeys: [fk], checks }),
    ).toContain(
      '  CONSTRAINT "fk_orders_user" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE SET NULL,\n  CONSTRAINT "ck" CHECK (user_id > 0)\n);',
    );
  });

  it("output is unchanged when no constraints are given", () => {
    expect(buildCreateTableSql("sqlite", { table: "t", columns: cols })).not.toContain("CONSTRAINT");
  });
});
