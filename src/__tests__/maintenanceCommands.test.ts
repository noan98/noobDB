import { describe, expect, it } from "vitest";
import {
  batchMaintenanceCommands,
  batchMaintenanceKinds,
  databaseMaintenanceCommands,
  matviewRefreshCommands,
  tableMaintenanceCommands,
  type MaintenanceKind,
} from "../components/maintenanceCommands";

function sqlFor(driver: string, db: string | null, table: string, kind: MaintenanceKind): string {
  const cmd = tableMaintenanceCommands(driver, db, table).find((c) => c.kind === kind);
  if (!cmd) throw new Error(`no ${kind} command for ${driver}`);
  return cmd.sql;
}

describe("tableMaintenanceCommands", () => {
  it("generates MySQL table maintenance with backtick-qualified names", () => {
    const kinds = tableMaintenanceCommands("mysql", "shop", "users").map((c) => c.kind);
    expect(kinds).toEqual(["analyze", "optimize", "check", "repair"]);
    expect(sqlFor("mysql", "shop", "users", "analyze")).toBe("ANALYZE TABLE `shop`.`users`;");
    expect(sqlFor("mysql", "shop", "users", "optimize")).toBe("OPTIMIZE TABLE `shop`.`users`;");
    expect(sqlFor("mysql", "shop", "users", "check")).toBe("CHECK TABLE `shop`.`users`;");
    expect(sqlFor("mysql", "shop", "users", "repair")).toBe("REPAIR TABLE `shop`.`users`;");
  });

  it("generates PostgreSQL VACUUM / ANALYZE / REINDEX with double-quoted names", () => {
    const kinds = tableMaintenanceCommands("postgres", "public", "users").map((c) => c.kind);
    expect(kinds).toEqual(["vacuumAnalyze", "analyze", "vacuum", "reindex"]);
    expect(sqlFor("postgres", "public", "users", "vacuumAnalyze")).toBe('VACUUM (ANALYZE) "public"."users";');
    expect(sqlFor("postgres", "public", "users", "vacuum")).toBe('VACUUM "public"."users";');
    expect(sqlFor("postgres", "public", "users", "reindex")).toBe('REINDEX TABLE "public"."users";');
  });

  it("generates only ANALYZE / REINDEX for SQLite with an unqualified name", () => {
    const kinds = tableMaintenanceCommands("sqlite", "main", "users").map((c) => c.kind);
    expect(kinds).toEqual(["analyze", "reindex"]);
    expect(sqlFor("sqlite", "main", "users", "analyze")).toBe('ANALYZE "users";');
    expect(sqlFor("sqlite", "main", "users", "reindex")).toBe('REINDEX "users";');
  });

  it("escapes embedded identifier quotes", () => {
    expect(sqlFor("mysql", "sh`op", "us`er", "analyze")).toBe("ANALYZE TABLE `sh``op`.`us``er`;");
    expect(sqlFor("postgres", null, 'we"ird', "analyze")).toBe('ANALYZE "we""ird";');
  });

  it("treats an unknown driver as MySQL-compatible", () => {
    expect(sqlFor("mariadb", "shop", "t", "optimize")).toBe("OPTIMIZE TABLE `shop`.`t`;");
  });
});

describe("databaseMaintenanceCommands", () => {
  it("returns whole-database commands for SQLite", () => {
    expect(databaseMaintenanceCommands("sqlite")).toEqual([
      { kind: "vacuum", sql: "VACUUM;" },
      { kind: "analyze", sql: "ANALYZE;" },
      { kind: "reindex", sql: "REINDEX;" },
    ]);
  });

  it("returns target-less VACUUM/ANALYZE for PostgreSQL", () => {
    expect(databaseMaintenanceCommands("postgres").map((c) => c.kind)).toEqual([
      "vacuumAnalyze",
      "analyze",
      "vacuum",
    ]);
  });

  it("returns nothing for MySQL (no global maintenance statement)", () => {
    expect(databaseMaintenanceCommands("mysql")).toEqual([]);
  });
});

describe("matviewRefreshCommands (#1241)", () => {
  it("generates plain and CONCURRENTLY REFRESH for PostgreSQL", () => {
    expect(matviewRefreshCommands("postgres", "public", "mv_sales")).toEqual([
      { kind: "refreshMatview", sql: 'REFRESH MATERIALIZED VIEW "public"."mv_sales";' },
      {
        kind: "refreshMatviewConcurrently",
        sql: 'REFRESH MATERIALIZED VIEW CONCURRENTLY "public"."mv_sales";',
      },
    ]);
  });

  it("escapes embedded double quotes in identifiers", () => {
    expect(matviewRefreshCommands("postgres", 'sc"h', 'm"v')[0]?.sql).toBe(
      'REFRESH MATERIALIZED VIEW "sc""h"."m""v";',
    );
  });

  it("returns nothing for drivers without materialized views", () => {
    expect(matviewRefreshCommands("mysql", "shop", "v")).toEqual([]);
    expect(matviewRefreshCommands("sqlite", null, "v")).toEqual([]);
  });
});

describe("複数テーブルの一括保守 (#1629)", () => {
  it("種別は単一テーブルの保守と同じ (ドライバごと)", () => {
    expect(batchMaintenanceKinds("mysql")).toEqual(["analyze", "optimize", "check", "repair"]);
    expect(batchMaintenanceKinds("postgres")).toEqual(["vacuumAnalyze", "analyze", "vacuum", "reindex"]);
    expect(batchMaintenanceKinds("sqlite")).toEqual(["analyze", "reindex"]);
  });

  it("テーブルごとに 1 文ずつ、選択の順で生成する", () => {
    const cmds = batchMaintenanceCommands("mysql", "shop", ["b", "a"], "optimize");
    expect(cmds.map((c) => c.table)).toEqual(["b", "a"]);
    expect(cmds.map((c) => c.command.sql)).toEqual([
      "OPTIMIZE TABLE `shop`.`b`;",
      "OPTIMIZE TABLE `shop`.`a`;",
    ]);
    expect(
      batchMaintenanceCommands("postgres", "public", ["t1", "t2"], "vacuum").map((c) => c.command.sql),
    ).toEqual(['VACUUM "public"."t1";', 'VACUUM "public"."t2";']);
  });

  it("ドライバが持たない種別・空の選択は空配列", () => {
    expect(batchMaintenanceCommands("sqlite", null, ["a"], "vacuum")).toEqual([]);
    expect(batchMaintenanceCommands("mysql", "d", [], "analyze")).toEqual([]);
  });
});
