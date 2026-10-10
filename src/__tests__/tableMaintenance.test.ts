import { describe, expect, it } from "vitest";
import {
  buildCreateIndexSql,
  buildDropIndexSql,
  buildDropTableSql,
  buildDropTablesSql,
  orderTablesChildrenFirst,
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

describe("buildDropTablesSql (#1399)", () => {
  it("MySQL / PostgreSQL は 1 文にまとめる", () => {
    expect(buildDropTablesSql("mysql", "shop", ["a", "b`c"])).toEqual(["DROP TABLE `shop`.`a`, `shop`.`b``c`;"]);
    expect(buildDropTablesSql("postgres", "public", ["a", "B"])).toEqual(['DROP TABLE "public"."a", "public"."B";']);
  });

  it("SQLite はテーブルごとの文", () => {
    expect(buildDropTablesSql("sqlite", "main", ["a", "b"])).toEqual(['DROP TABLE "a";', 'DROP TABLE "b";']);
  });

  it("空なら文を作らない", () => {
    expect(buildDropTablesSql("mysql", "shop", [])).toEqual([]);
  });
});

describe("orderTablesChildrenFirst (#1399)", () => {
  it("子 (参照する側) を親より先に並べる", () => {
    const fks = [
      { table: "order_items", referenced_table: "orders" },
      { table: "orders", referenced_table: "users" },
    ];
    expect(orderTablesChildrenFirst(["users", "orders", "order_items"], fks)).toEqual(["order_items", "orders", "users"]);
  });
  it("選択外への参照・自己参照は無視し、元の順序を保つ", () => {
    const fks = [
      { table: "a", referenced_table: "outside" },
      { table: "b", referenced_table: "b" },
    ];
    expect(orderTablesChildrenFirst(["a", "b"], fks)).toEqual(["a", "b"]);
  });
  it("循環は元の順序で末尾に回す", () => {
    const fks = [
      { table: "a", referenced_table: "b" },
      { table: "b", referenced_table: "a" },
      { table: "c", referenced_table: "a" },
    ];
    expect(orderTablesChildrenFirst(["a", "b", "c"], fks)).toEqual(["c", "a", "b"]);
  });
});
