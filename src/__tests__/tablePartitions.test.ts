import { describe, expect, it } from "vitest";
import type { TablePartition } from "../api/tauri";
import { partitionMaintenanceCommands } from "../components/maintenanceCommands";
import {
  buildDetachPartitionSql,
  buildPartitionDropSql,
  buildPartitionTruncateSql,
} from "../components/tableMaintenance";
import {
  buildPartitionOpSql,
  formatPartitionBound,
  partitionDestructiveOps,
} from "../components/tablePartitions";

const part = (over: Partial<TablePartition> = {}): TablePartition => ({
  name: "p1",
  schema: null,
  parent: null,
  parent_schema: null,
  depth: 0,
  bound: "",
  size_bytes: null,
  row_estimate: null,
  is_default: false,
  is_partitioned: false,
  sub_partition_key: null,
  ...over,
});

describe("formatPartitionBound (#1868)", () => {
  it("PostgreSQL の RANGE / LIST / HASH / DEFAULT を短くする", () => {
    expect(formatPartitionBound("FOR VALUES FROM ('2026-01-01') TO ('2026-02-01')")).toBe(
      "2026-01-01 → 2026-02-01",
    );
    expect(formatPartitionBound("FOR VALUES FROM (MINVALUE) TO (100)")).toBe("MINVALUE → 100");
    expect(formatPartitionBound("FOR VALUES FROM (1, 'a') TO (2, 'b')")).toBe("1, a → 2, b");
    expect(formatPartitionBound("FOR VALUES IN ('x', 'it''s')")).toBe("x, it's");
    expect(formatPartitionBound("FOR VALUES WITH (modulus 4, remainder 1)")).toBe("modulus 4 / remainder 1");
    expect(formatPartitionBound("DEFAULT")).toBe("DEFAULT");
  });

  it("型キャストを落とし、カンマ入りの引用値や関数呼び出しで割らない", () => {
    expect(
      formatPartitionBound("FOR VALUES FROM ('2026-01-01 00:00:00+00'::timestamptz) TO ('2026-02-01'::date)"),
    ).toBe("2026-01-01 00:00:00+00 → 2026-02-01");
    expect(formatPartitionBound("FOR VALUES IN ('a,b', 'c')")).toBe("a,b, c");
  });

  it("MySQL の境界や空・未知の形式は原文のまま返す", () => {
    expect(formatPartitionBound("LESS THAN (2026)")).toBe("LESS THAN (2026)");
    expect(formatPartitionBound("IN (1,2)")).toBe("IN (1,2)");
    expect(formatPartitionBound("")).toBe("");
    expect(formatPartitionBound("something odd")).toBe("something odd");
  });
});

describe("パーティション操作 SQL (#1868)", () => {
  it("PostgreSQL は子テーブルを直接指す (子が別スキーマならそちらを使う)", () => {
    const child = { name: "ev_2026_01", schema: "archive" };
    expect(buildPartitionTruncateSql("postgres", "public", "ev", child)).toBe(
      'TRUNCATE TABLE "archive"."ev_2026_01";',
    );
    expect(buildPartitionDropSql("postgres", "public", "ev", child)).toBe(
      'DROP TABLE "archive"."ev_2026_01";',
    );
    expect(buildDetachPartitionSql("postgres", "public", "ev", child)).toBe(
      'ALTER TABLE "public"."ev" DETACH PARTITION "archive"."ev_2026_01";',
    );
    expect(partitionMaintenanceCommands("postgres", "public", "ev", child).map((c) => c.sql)).toEqual([
      'VACUUM (ANALYZE) "archive"."ev_2026_01";',
      'ANALYZE "archive"."ev_2026_01";',
      'VACUUM "archive"."ev_2026_01";',
      'REINDEX TABLE "archive"."ev_2026_01";',
    ]);
  });

  it("MySQL は ALTER TABLE ... PARTITION で、識別子のバッククォートを二重化する", () => {
    const p = { name: "p`1" };
    expect(buildPartitionTruncateSql("mysql", "app", "ev", p)).toBe(
      "ALTER TABLE `app`.`ev` TRUNCATE PARTITION `p``1`;",
    );
    expect(buildPartitionDropSql("mysql", "app", "ev", p)).toBe(
      "ALTER TABLE `app`.`ev` DROP PARTITION `p``1`;",
    );
    expect(buildDetachPartitionSql("mysql", "app", "ev", p)).toBe("");
    expect(partitionMaintenanceCommands("mysql", "app", "ev", p).map((c) => c.sql)).toEqual([
      "ALTER TABLE `app`.`ev` ANALYZE PARTITION `p``1`;",
      "ALTER TABLE `app`.`ev` REBUILD PARTITION `p``1`;",
      "ALTER TABLE `app`.`ev` CHECK PARTITION `p``1`;",
    ]);
  });

  it("SQLite は何も生成しない", () => {
    expect(buildPartitionTruncateSql("sqlite", null, "t", { name: "p" })).toBe("");
    expect(buildPartitionDropSql("sqlite", null, "t", { name: "p" })).toBe("");
    expect(partitionMaintenanceCommands("sqlite", null, "t", { name: "p" })).toEqual([]);
    expect(partitionDestructiveOps("sqlite", { method: "RANGE" }, part())).toEqual([]);
  });
});

describe("partitionDestructiveOps (#1868)", () => {
  it("PostgreSQL: サブパーティションの DETACH は直上のパーティションから外す", () => {
    const sub = part({
      name: "ev_jp",
      schema: "public",
      parent: "ev_02",
      parent_schema: "archive",
      depth: 1,
    });
    expect(buildPartitionOpSql("detach", "postgres", "public", "ev", sub)).toBe(
      'ALTER TABLE "archive"."ev_02" DETACH PARTITION "public"."ev_jp";',
    );
  });

  it("PostgreSQL: 直下の子もサブパーティションも DETACH できる", () => {
    expect(partitionDestructiveOps("postgres", { method: "RANGE" }, part())).toEqual([
      "truncate",
      "detach",
      "drop",
    ]);
    expect(partitionDestructiveOps("postgres", { method: "RANGE" }, part({ depth: 1 }))).toEqual([
      "truncate",
      "detach",
      "drop",
    ]);
  });

  it("MySQL: DROP は RANGE / LIST の直下のパーティションだけ", () => {
    expect(partitionDestructiveOps("mysql", { method: "RANGE COLUMNS" }, part())).toEqual([
      "truncate",
      "drop",
    ]);
    expect(partitionDestructiveOps("mysql", { method: "LIST" }, part())).toEqual(["truncate", "drop"]);
    expect(partitionDestructiveOps("mysql", { method: "HASH" }, part())).toEqual(["truncate"]);
    expect(partitionDestructiveOps("mysql", { method: "KEY" }, part())).toEqual(["truncate"]);
    // MySQL のサブパーティションには出さない。
    expect(partitionDestructiveOps("mysql", { method: "RANGE" }, part({ depth: 1 }))).toEqual([]);
  });

  it("buildPartitionOpSql は操作ごとの SQL を返す", () => {
    const p = part({ schema: "public" });
    expect(buildPartitionOpSql("detach", "postgres", "public", "ev", p)).toContain("DETACH PARTITION");
    expect(buildPartitionOpSql("drop", "postgres", "public", "ev", p)).toContain("DROP TABLE");
    expect(buildPartitionOpSql("truncate", "postgres", "public", "ev", p)).toContain("TRUNCATE TABLE");
  });
});
