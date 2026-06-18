import { describe, expect, it } from "vitest";
import {
  databaseMaintenanceCommands,
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
    expect(sqlFor("postgres", "public", "users", "vacuumAnalyze")).toBe(
      'VACUUM (ANALYZE) "public"."users";',
    );
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
