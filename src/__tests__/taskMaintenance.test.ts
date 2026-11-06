import { describe, it, expect } from "vitest";
import vectors from "./fixtures/taskMaintenanceVectors.json";
import type { TaskMaintenanceKind } from "../api/tauri";
import { maintenanceKindsForDriver } from "../taskFormat";
import {
  buildTaskMaintenanceStatements,
  isMaintenanceSupported,
  maintenanceImpact,
  TASK_MAINTENANCE_ORDER,
} from "../components/taskMaintenance";

describe("buildTaskMaintenanceStatements (#2096)", () => {
  it("Rust の build_statements と共有ゴールデンベクタで一致する", () => {
    for (const c of vectors.cases) {
      const got = buildTaskMaintenanceStatements(
        c.driver,
        c.database,
        c.targets,
        c.kind as TaskMaintenanceKind,
      );
      if (c.sql === null) expect(got, c.name).toHaveProperty("error");
      else expect(got, c.name).toEqual({ sql: c.sql });
    }
  });

  it("エラーの分類を返す", () => {
    expect(buildTaskMaintenanceStatements("mysql", null, [], "analyze")).toEqual({
      error: "targetsRequiredMysql",
    });
    expect(buildTaskMaintenanceStatements("postgres", null, [], "reindex")).toEqual({
      error: "targetsRequiredReindex",
    });
    expect(buildTaskMaintenanceStatements("sqlite", null, ["t"], "vacuum")).toEqual({
      error: "sqliteVacuumTargets",
    });
    expect(buildTaskMaintenanceStatements("postgres", 'a"b', ["t"], "analyze")).toEqual({
      error: "invalidDatabase",
    });
    // プロファイル未選択は MySQL 扱い
    expect(buildTaskMaintenanceStatements(undefined, null, ["t"], "analyze")).toEqual({
      sql: ["ANALYZE TABLE `t`;"],
    });
  });

  it("対応表は選択肢の一覧 (maintenanceKindsForDriver) と一致する", () => {
    for (const d of ["mysql", "postgres", "sqlite"]) {
      const kinds = TASK_MAINTENANCE_ORDER.filter((k) => isMaintenanceSupported(d, k));
      expect([...kinds].sort()).toEqual([...maintenanceKindsForDriver(d)].sort());
    }
  });

  it("ロックの重さ: 統計更新は軽く、再構築は重い", () => {
    expect(maintenanceImpact("postgres", "analyze")).toEqual({
      lock: "light",
      blocksWrites: false,
      blocksReads: false,
    });
    // SQLite の ANALYZE はデータベース全体の書き込みロックを取る。
    expect(maintenanceImpact("sqlite", "analyze").blocksWrites).toBe(true);
    // MySQL の ANALYZE TABLE は解析中に読み取りロックを取り、書き込みを待たせる。
    expect(maintenanceImpact("mysql", "analyze").blocksWrites).toBe(true);
    expect(maintenanceImpact("postgres", "analyze").blocksWrites).toBe(false);
    expect(maintenanceImpact("postgres", "vacuum").lock).toBe("light");
    expect(maintenanceImpact("sqlite", "vacuum")).toEqual({
      lock: "heavy",
      blocksWrites: true,
      blocksReads: true,
    });
    expect(maintenanceImpact("postgres", "reindex")).toEqual({
      lock: "heavy",
      blocksWrites: true,
      blocksReads: true,
    });
    expect(maintenanceImpact("sqlite", "reindex").blocksReads).toBe(false);
    expect(maintenanceImpact("mysql", "optimize").lock).toBe("heavy");
  });
});
