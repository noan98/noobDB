import { describe, expect, it } from "vitest";
import type { TablePartition } from "../api/tauri";
import { partitionMaintenanceCommands } from "../components/maintenanceCommands";
import {
  buildAttachPartitionSql,
  buildDetachPartitionSql,
  buildPartitionDropSql,
  buildPartitionTruncateSql,
} from "../components/tableMaintenance";
import {
  attachBoundKind,
  attachCandidates,
  buildAttachSql,
  buildPartitionBoundClause,
  buildPartitionOpSql,
  existingHashModulus,
  formatPartitionBound,
  parseListValues,
  partitionKeyColumns,
  quoteBoundValue,
  validateAttachBound,
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

describe("ATTACH PARTITION (#1929)", () => {
  it("PostgreSQL の RANGE / LIST / HASH だけが対象 (MySQL / SQLite は対象外)", () => {
    expect(attachBoundKind("postgres", { method: "RANGE" })).toBe("range");
    expect(attachBoundKind("postgres", { method: "list" })).toBe("list");
    expect(attachBoundKind("postgres", { method: "HASH" })).toBe("hash");
    expect(attachBoundKind("postgres", { method: "weird" })).toBeNull();
    expect(attachBoundKind("mysql", { method: "RANGE" })).toBeNull();
    expect(attachBoundKind("sqlite", { method: "RANGE" })).toBeNull();
  });

  it("境界値のリテラル化: MINVALUE / MAXVALUE / NULL 以外は常に引用し、文を抜け出せない", () => {
    expect(quoteBoundValue(" 10 ")).toBe("'10'");
    expect(quoteBoundValue("007")).toBe("'007'");
    expect(quoteBoundValue("minvalue")).toBe("MINVALUE");
    expect(quoteBoundValue("MaxValue")).toBe("MAXVALUE");
    expect(quoteBoundValue("null")).toBe("NULL");
    expect(quoteBoundValue("2026-01-01")).toBe("'2026-01-01'");
    expect(quoteBoundValue("it's")).toBe("'it''s'");
    // 完全な 1 つの文字列リテラルはそのまま。
    expect(quoteBoundValue("'007'")).toBe("'007'");
    expect(quoteBoundValue("'it''s'")).toBe("'it''s'");
    // 文を抜け出す入力・複数値は全体が 1 つのリテラルになる。
    expect(quoteBoundValue("'a'); DROP TABLE x; --'")).toBe("'''a''); DROP TABLE x; --'''");
    expect(quoteBoundValue("'a', 'b'")).toBe("'''a'', ''b'''");
    expect(
      buildPartitionBoundClause({ kind: "list", values: parseListValues("'a'); DROP TABLE x; --'") }),
    ).toBe("FOR VALUES IN ('''a''); DROP TABLE x; --''')");
    expect(buildPartitionBoundClause({ kind: "range", from: ["'a', 'b'"], to: ["z"] })).toBe(
      "FOR VALUES FROM ('''a'', ''b''') TO ('z')",
    );
  });

  it("RANGE: キー列ごとの FROM / TO (複合キー・MINVALUE)", () => {
    expect(buildPartitionBoundClause({ kind: "range", from: ["2026-01-01"], to: ["2026-02-01"] })).toBe(
      "FOR VALUES FROM ('2026-01-01') TO ('2026-02-01')",
    );
    expect(
      buildPartitionBoundClause({ kind: "range", from: ["MINVALUE", "1"], to: ["100", "MAXVALUE"] }),
    ).toBe("FOR VALUES FROM (MINVALUE, '1') TO ('100', MAXVALUE)");
    expect(validateAttachBound({ kind: "range", from: ["1"], to: [" "] })).toBe("rangeEmpty");
    expect(buildPartitionBoundClause({ kind: "range", from: [""], to: ["1"] })).toBe("");
  });

  it("LIST: カンマ区切り (引用符内のカンマは区切らない)・空要素は捨てる", () => {
    expect(parseListValues("'a,b', c, ")).toEqual(["'a,b'", "c"]);
    expect(buildPartitionBoundClause({ kind: "list", values: parseListValues("jp, us, NULL") })).toBe(
      "FOR VALUES IN ('jp', 'us', NULL)",
    );
    expect(validateAttachBound({ kind: "list", values: [] })).toBe("listEmpty");
  });

  it("HASH: MODULUS は 1 以上、REMAINDER は 0 以上 MODULUS 未満の整数", () => {
    expect(buildPartitionBoundClause({ kind: "hash", modulus: "4", remainder: "3" })).toBe(
      "FOR VALUES WITH (MODULUS 4, REMAINDER 3)",
    );
    expect(validateAttachBound({ kind: "hash", modulus: "0", remainder: "0" })).toBe("hashModulus");
    expect(validateAttachBound({ kind: "hash", modulus: "x", remainder: "0" })).toBe("hashModulus");
    expect(validateAttachBound({ kind: "hash", modulus: "4", remainder: "4" })).toBe("hashRemainder");
    expect(validateAttachBound({ kind: "hash", modulus: "4", remainder: "-1" })).toBe("hashRemainder");
  });

  it("DEFAULT と ATTACH 文の組み立て (他ドライバ・境界不正は空文字)", () => {
    expect(buildAttachSql("postgres", "public", "ev", "ev_old", { kind: "default" })).toBe(
      'ALTER TABLE "public"."ev" ATTACH PARTITION "public"."ev_old" DEFAULT;',
    );
    expect(buildAttachSql("postgres", "public", "ev", 'ev"x', { kind: "list", values: ["1"] })).toBe(
      `ALTER TABLE "public"."ev" ATTACH PARTITION "public"."ev""x" FOR VALUES IN ('1');`,
    );
    expect(buildAttachPartitionSql("mysql", "app", "ev", { name: "c" }, "DEFAULT")).toBe("");
    expect(buildAttachPartitionSql("sqlite", null, "ev", { name: "c" }, "DEFAULT")).toBe("");
    expect(
      buildAttachSql("postgres", "public", "ev", "c", { kind: "hash", modulus: "", remainder: "" }),
    ).toBe("");
  });

  it("候補は親自身と付いている子を除く。キー列の分割と既存 MODULUS の取得", () => {
    const info = {
      partitions: [
        part({ name: "ev_1" }),
        part({ name: "ev_2", bound: "FOR VALUES WITH (modulus 8, remainder 1)" }),
      ],
    };
    expect(attachCandidates(["ev", "ev_1", "ev_2", "old"], "ev", info)).toEqual(["old"]);
    expect(existingHashModulus(info)).toBe("8");
    expect(existingHashModulus({ partitions: [part({ name: "a" })] })).toBeNull();
    expect(
      existingHashModulus({
        partitions: [part({ name: "s", depth: 1, bound: "FOR VALUES WITH (modulus 2, remainder 0)" })],
      }),
    ).toBeNull();
    expect(partitionKeyColumns("a, lower(b)")).toEqual(["a", "lower(b)"]);
  });
});
