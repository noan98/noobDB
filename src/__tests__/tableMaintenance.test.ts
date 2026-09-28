import { describe, expect, it } from "vitest";
import {
  buildCreateIndexSql,
  buildDropIndexSql,
  buildDropTableSql,
  buildRenameTableSql,
  buildTruncateSql,
} from "../components/tableMaintenance";

describe("buildTruncateSql", () => {
  it("uses TRUNCATE TABLE on MySQL/Postgres with qualified, quoted names", () => {
    expect(buildTruncateSql("mysql", "shop", "users")).toBe("TRUNCATE TABLE `shop`.`users`;");
    expect(buildTruncateSql("postgres", "public", "users")).toBe('TRUNCATE TABLE "public"."users";');
  });

  it("falls back to DELETE FROM on SQLite (no TRUNCATE, no schema)", () => {
    expect(buildTruncateSql("sqlite", "main", "users")).toBe('DELETE FROM "users";');
  });
});

describe("buildDropTableSql", () => {
  it("drops with a qualified, quoted name", () => {
    expect(buildDropTableSql("mysql", "shop", "t")).toBe("DROP TABLE `shop`.`t`;");
    expect(buildDropTableSql("sqlite", "main", "t")).toBe('DROP TABLE "t";');
  });
});

describe("buildRenameTableSql", () => {
  it("uses ALTER TABLE ... RENAME TO with an unqualified new name", () => {
    expect(buildRenameTableSql("mysql", "shop", "old", "new")).toBe(
      "ALTER TABLE `shop`.`old` RENAME TO `new`;",
    );
    expect(buildRenameTableSql("postgres", "public", "old", "new")).toBe(
      'ALTER TABLE "public"."old" RENAME TO "new";',
    );
    expect(buildRenameTableSql("sqlite", "main", "old", "new")).toBe(
      'ALTER TABLE "old" RENAME TO "new";',
    );
  });

  it("escapes embedded quotes in identifiers", () => {
    expect(buildRenameTableSql("postgres", null, 'we"ird', 'ne"w')).toBe(
      'ALTER TABLE "we""ird" RENAME TO "ne""w";',
    );
  });
});

describe("buildCreateIndexSql (#850)", () => {
  it("generates a plain CREATE INDEX with an auto-generated name", () => {
    expect(buildCreateIndexSql("mysql", "shop", "users", ["email"])).toBe(
      "CREATE INDEX `idx_users_email` ON `shop`.`users` (`email`);",
    );
    expect(buildCreateIndexSql("postgres", "public", "orders", ["user_id", "status"])).toBe(
      'CREATE INDEX "idx_orders_user_id_status" ON "public"."orders" ("user_id", "status");',
    );
    expect(buildCreateIndexSql("sqlite", "main", "t", ["a"])).toBe(
      'CREATE INDEX "idx_t_a" ON "t" ("a");',
    );
  });

  it("uses CREATE UNIQUE INDEX when unique is set", () => {
    expect(buildCreateIndexSql("mysql", "shop", "users", ["email"], { unique: true })).toBe(
      "CREATE UNIQUE INDEX `idx_users_email` ON `shop`.`users` (`email`);",
    );
  });

  it("uses an explicit index name when given, sanitizing non-alphanumeric characters", () => {
    expect(
      buildCreateIndexSql("postgres", "public", "orders", ["user_id"], { name: "my-idx!" }),
    ).toBe('CREATE INDEX "my_idx_" ON "public"."orders" ("user_id");');
  });

  it("trims and drops empty column entries", () => {
    expect(buildCreateIndexSql("mysql", "shop", "users", [" email ", ""])).toBe(
      "CREATE INDEX `idx_users_email` ON `shop`.`users` (`email`);",
    );
  });
});

describe("buildDropIndexSql (#850)", () => {
  it("uses DROP INDEX ... ON ... for MySQL (table-qualified)", () => {
    expect(buildDropIndexSql("mysql", "shop", "users", "idx_users_email")).toBe(
      "DROP INDEX `idx_users_email` ON `shop`.`users`;",
    );
  });

  it("uses a bare DROP INDEX (no table clause) for PostgreSQL/SQLite", () => {
    expect(buildDropIndexSql("postgres", "public", "orders", "idx_orders_user_id")).toBe(
      'DROP INDEX "idx_orders_user_id";',
    );
    expect(buildDropIndexSql("sqlite", "main", "t", "idx_t_a")).toBe('DROP INDEX "idx_t_a";');
  });
});
