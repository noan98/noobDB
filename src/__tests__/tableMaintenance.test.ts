import { describe, expect, it } from "vitest";
import {
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
