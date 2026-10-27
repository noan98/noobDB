import { describe, expect, it } from "vitest";
import {
  buildCreateIndexSql,
  indexOptionSupport,
  normalizeIndexFragment,
  buildDropIndexSql,
  buildDropTableSql,
  buildDropTablesSql,
  buildRenameTableSql,
  buildTruncateSql,
  buildTruncateTablesSql,
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
    expect(buildRenameTableSql("sqlite", "main", "old", "new")).toBe('ALTER TABLE "old" RENAME TO "new";');
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
    expect(buildCreateIndexSql("sqlite", "main", "t", ["a"])).toBe('CREATE INDEX "idx_t_a" ON "t" ("a");');
  });

  it("uses CREATE UNIQUE INDEX when unique is set", () => {
    expect(buildCreateIndexSql("mysql", "shop", "users", ["email"], { unique: true })).toBe(
      "CREATE UNIQUE INDEX `idx_users_email` ON `shop`.`users` (`email`);",
    );
  });

  it("uses an explicit index name when given, sanitizing non-alphanumeric characters", () => {
    expect(buildCreateIndexSql("postgres", "public", "orders", ["user_id"], { name: "my-idx!" })).toBe(
      'CREATE INDEX "my_idx_" ON "public"."orders" ("user_id");',
    );
  });

  it("trims and drops empty column entries", () => {
    expect(buildCreateIndexSql("mysql", "shop", "users", [" email ", ""])).toBe(
      "CREATE INDEX `idx_users_email` ON `shop`.`users` (`email`);",
    );
  });
});

describe("buildCreateIndexSql options (#1892)", () => {
  it("emits USING before the column list on PostgreSQL", () => {
    expect(buildCreateIndexSql("postgres", "public", "t", ["data"], { method: "gin" })).toBe(
      'CREATE INDEX "idx_t_data" ON "public"."t" USING gin ("data");',
    );
    expect(buildCreateIndexSql("postgres", "public", "t", ["a"], { method: "brin" })).toContain("USING brin");
  });

  it("emits USING after the column list on MySQL, and FULLTEXT / SPATIAL as the index kind", () => {
    expect(buildCreateIndexSql("mysql", "d", "t", ["a"], { method: "hash" })).toBe(
      "CREATE INDEX `idx_t_a` ON `d`.`t` (`a`) USING HASH;",
    );
    expect(buildCreateIndexSql("mysql", "d", "t", ["body"], { method: "fulltext" })).toBe(
      "CREATE FULLTEXT INDEX `idx_t_body` ON `d`.`t` (`body`);",
    );
    expect(buildCreateIndexSql("mysql", "d", "t", ["geo"], { method: "spatial", unique: true })).toBe(
      "CREATE SPATIAL INDEX `idx_t_geo` ON `d`.`t` (`geo`);",
    );
  });

  it("ignores USING and INCLUDE on SQLite", () => {
    expect(buildCreateIndexSql("sqlite", null, "t", ["a"], { method: "gin", include: ["b"] })).toBe(
      'CREATE INDEX "idx_t_a" ON "t" ("a");',
    );
  });

  it("wraps expressions in parentheses on all three drivers", () => {
    expect(buildCreateIndexSql("mysql", "d", "t", [], { expressions: ["LOWER(email)"] })).toMatch(
      /^CREATE INDEX `idx_t_LOWER_email_[0-9a-f]+` ON `d`\.`t` \(\(LOWER\(email\)\)\);$/,
    );
    expect(
      buildCreateIndexSql("postgres", "public", "t", ["a"], { name: "n", expressions: ["(data->>'k')"] }),
    ).toBe('CREATE INDEX "n" ON "public"."t" ("a", ((data->>\'k\')));');
    expect(buildCreateIndexSql("sqlite", null, "t", [], { expressions: ["lower(email);"] })).toMatch(
      /^CREATE INDEX "idx_t_lower_email_[0-9a-f]+" ON "t" \(\(lower\(email\)\)\);$/,
    );
  });

  it("gives different auto names to different expressions", () => {
    const n = (e: string) => buildCreateIndexSql("postgres", null, "t", [], { expressions: [e] });
    expect(n("LOWER(email)")).not.toBe(n("UPPER(email)"));
    expect(n("a+b")).not.toBe(n("a-b"));
  });

  it("excludes key columns from INCLUDE", () => {
    expect(buildCreateIndexSql("postgres", "public", "t", ["a", "b"], { include: ["b", "c"] })).toBe(
      'CREATE INDEX "idx_t_a_b" ON "public"."t" ("a", "b") INCLUDE ("c");',
    );
    expect(buildCreateIndexSql("postgres", "public", "t", ["b"], { include: ["b"] })).not.toContain(
      "INCLUDE",
    );
  });

  it("flags single-column methods", () => {
    expect(indexOptionSupport("postgres", "hash").singleColumn).toBe(true);
    expect(indexOptionSupport("mysql", "spatial").singleColumn).toBe(true);
    expect(indexOptionSupport("mysql", "hash").singleColumn).toBe(false);
    expect(indexOptionSupport("postgres", "gin").singleColumn).toBe(false);
  });

  it("drops expressions for MySQL FULLTEXT", () => {
    expect(buildCreateIndexSql("mysql", "d", "t", ["a"], { method: "fulltext", expressions: ["x"] })).toBe(
      "CREATE FULLTEXT INDEX `idx_t_a` ON `d`.`t` (`a`);",
    );
  });

  it("appends WHERE for PostgreSQL and SQLite only", () => {
    expect(buildCreateIndexSql("postgres", "public", "t", ["a"], { where: "deleted_at IS NULL;" })).toBe(
      'CREATE INDEX "idx_t_a" ON "public"."t" ("a") WHERE deleted_at IS NULL;',
    );
    expect(buildCreateIndexSql("sqlite", null, "t", ["a"], { unique: true, where: "a > 0" })).toBe(
      'CREATE UNIQUE INDEX "idx_t_a" ON "t" ("a") WHERE a > 0;',
    );
    expect(buildCreateIndexSql("mysql", "d", "t", ["a"], { where: "a > 0" })).toBe(
      "CREATE INDEX `idx_t_a` ON `d`.`t` (`a`);",
    );
  });

  it("appends INCLUDE for PostgreSQL btree/gist/spgist only, after USING and before WHERE", () => {
    expect(
      buildCreateIndexSql("postgres", "public", "t", ["a"], { include: ["b", "c"], where: "a > 0" }),
    ).toBe('CREATE INDEX "idx_t_a" ON "public"."t" ("a") INCLUDE ("b", "c") WHERE a > 0;');
    expect(buildCreateIndexSql("postgres", "public", "t", ["a"], { method: "gin", include: ["b"] })).toBe(
      'CREATE INDEX "idx_t_a" ON "public"."t" USING gin ("a");',
    );
    expect(buildCreateIndexSql("mysql", "d", "t", ["a"], { include: ["b"] })).not.toContain("INCLUDE");
  });

  it("drops UNIQUE for non-btree PostgreSQL methods", () => {
    expect(buildCreateIndexSql("postgres", "public", "t", ["a"], { method: "gin", unique: true })).toContain(
      "CREATE INDEX",
    );
    expect(
      buildCreateIndexSql("postgres", "public", "t", ["a"], { method: "btree", unique: true }),
    ).toContain("CREATE UNIQUE INDEX");
  });
});

describe("indexOptionSupport / normalizeIndexFragment (#1892)", () => {
  it("matrix per driver", () => {
    const sq = indexOptionSupport("sqlite");
    expect(sq).toMatchObject({ methods: [], where: true, include: false });
    expect(sq.reasons.method).toBe("noMethod");
    expect(sq.reasons.include).toBe("includePgOnly");
    const my = indexOptionSupport("mysql");
    expect(my).toMatchObject({ where: false, include: false });
    expect(my.reasons.where).toBe("noWhereMysql");
    expect(indexOptionSupport("mysql", "fulltext")).toMatchObject({ unique: false, expression: false });
    const pg = indexOptionSupport("postgres");
    expect(pg).toMatchObject({ where: true, include: true, unique: true });
    expect(indexOptionSupport("postgres", "gin").reasons).toMatchObject({
      include: "includeMethod",
      unique: "uniqueMethod",
    });
  });

  it("strips trailing semicolons and rejects statement chaining", () => {
    expect(normalizeIndexFragment("  a > 0 ; ")).toEqual({ sql: "a > 0", error: false });
    expect(normalizeIndexFragment("")).toEqual({ sql: null, error: false });
    expect(normalizeIndexFragment("a; DROP TABLE t").error).toBe(true);
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
    expect(buildDropTablesSql("mysql", "shop", ["a", "b`c"])).toEqual([
      "DROP TABLE `shop`.`a`, `shop`.`b``c`;",
    ]);
    expect(buildDropTablesSql("postgres", "public", ["a", "B"])).toEqual([
      'DROP TABLE "public"."a", "public"."B";',
    ]);
  });

  it("SQLite はテーブルごとの文", () => {
    expect(buildDropTablesSql("sqlite", "main", ["a", "b"])).toEqual(['DROP TABLE "a";', 'DROP TABLE "b";']);
  });

  it("空なら文を作らない", () => {
    expect(buildDropTablesSql("mysql", "shop", [])).toEqual([]);
  });
});

describe("buildTruncateTablesSql (#1629)", () => {
  it("PostgreSQL は 1 文にまとめる (single)", () => {
    expect(buildTruncateTablesSql("postgres", "public", ["a", "b"])).toEqual({
      mode: "single",
      statements: ['TRUNCATE TABLE "public"."a", "public"."b";'],
    });
  });

  it("SQLite はテーブルごとの DELETE を 1 トランザクションで流す (transaction)", () => {
    expect(buildTruncateTablesSql("sqlite", null, ["a", "b"])).toEqual({
      mode: "transaction",
      statements: ['DELETE FROM "a";', 'DELETE FROM "b";'],
    });
  });

  it("MySQL はテーブルごとの TRUNCATE を順に流す (sequential)", () => {
    expect(buildTruncateTablesSql("mysql", "shop", ["a", "b"])).toEqual({
      mode: "sequential",
      statements: ["TRUNCATE TABLE `shop`.`a`;", "TRUNCATE TABLE `shop`.`b`;"],
    });
  });

  it("空の選択は文なし", () => {
    expect(buildTruncateTablesSql("mysql", "shop", []).statements).toEqual([]);
  });
});
