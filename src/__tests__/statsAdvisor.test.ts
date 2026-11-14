import { describe, expect, it } from "vitest";
import type { PlanNode } from "../components/explainPlan";
import {
  analyzeStatements,
  columnsSql,
  createStatisticsStatements,
  dropHistogramStatements,
  dropStatisticsStatements,
  extractConditionIdentifiers,
  freshnessSql,
  histogramStatements,
  parseExtendedStatistics,
  parseFreshness,
  parseHistograms,
  parseServerVersion,
  pickFilterColumns,
  planConditionIdentifiers,
  mysqlAnalyzeFailure,
  planStatsTables,
  setStatisticsTargetStatements,
  showsStatsSection,
  sqliteOptimizeStatements,
  statsObjectsSql,
  supportsHistogram,
  supportsMcvStatistics,
} from "../components/statsAdvisor";

function node(partial: Partial<PlanNode>): PlanNode {
  return { id: "plan", kind: "x", label: "x", cost: null, attrs: [], children: [], ...partial };
}
const t = { schema: null, table: "orders" };
const pg16 = parseServerVersion("postgres", "160002");
const pg11 = parseServerVersion("postgres", "110005");

describe("対象テーブルと条件の列", () => {
  it("PostgreSQL は Relation Name / Schema を子孫からも拾う", () => {
    const root = node({
      children: [
        node({
          attrs: [
            ["Relation Name", "orders"],
            ["Schema", "shop"],
            ["Filter", "((status = 'a'::text) AND (region_id = 3))"],
          ],
        }),
      ],
    });
    expect(planStatsTables(root, "postgres")).toEqual([{ schema: "shop", table: "orders" }]);
    expect(planConditionIdentifiers(root, "postgres")).toEqual(["status", "region_id"]);
  });

  it("MySQL の EXPLAIN ANALYZE の行ラベルからテーブルと条件を拾う", () => {
    const scan = node({ label: "Index lookup on `o` using ix_a (a=1, b=2)" });
    const filter = node({ label: "Filter: (o.c > 5)", children: [scan] });
    expect(planStatsTables(filter, "mysql")).toEqual([{ schema: null, table: "o" }]);
    expect(planConditionIdentifiers(filter, "mysql")).toContain("c");
    expect(planStatsTables(node({ label: "Table scan on shop.t" }), "mysql")).toEqual([
      { schema: "shop", table: "t" },
    ]);
  });

  it("SQLite は SCAN / SEARCH の表名を拾い、実測が無くても欄を出す", () => {
    const n = node({ label: "SEARCH users USING INDEX ix (a=? AND b>?)" });
    expect(planStatsTables(n, "sqlite")).toEqual([{ schema: null, table: "users" }]);
    expect(showsStatsSection(n, "sqlite")).toBe(true);
    expect(showsStatsSection(n, "postgres")).toBe(false);
  });

  it("リテラル・型キャスト・キーワードは列の候補にしない", () => {
    expect(
      extractConditionIdentifiers("((t.name)::text = 'x and y'::text) AND (n > 10) AND (a IS NULL)"),
    ).toEqual(["name", "n", "a"]);
  });

  it("実際の列一覧と大文字小文字を無視して突き合わせる", () => {
    expect(pickFilterColumns(["status", "foo", "Region"], ["id", "Status", "region"])).toEqual([
      "Status",
      "region",
    ]);
  });
});

describe("版による分岐", () => {
  it("版の文字列を読む", () => {
    expect(pg16).toEqual({ major: 16, minor: 0, mariadb: false });
    expect(parseServerVersion("mysql", "8.0.34")).toEqual({ major: 8, minor: 0, mariadb: false });
    expect(parseServerVersion("mysql", "10.6.12-MariaDB")?.mariadb).toBe(true);
    expect(parseServerVersion("mysql", "")).toBeNull();
  });

  it("MySQL 8.0 未満と MariaDB ではヒストグラムを無効化する", () => {
    expect(supportsHistogram("mysql", parseServerVersion("mysql", "5.7.44"))).toBe(false);
    expect(supportsHistogram("mysql", parseServerVersion("mysql", "10.6.12-MariaDB"))).toBe(false);
    expect(supportsHistogram("mysql", parseServerVersion("mysql", "8.0.0"))).toBe(true);
    expect(supportsHistogram("mysql", null)).toBe(true);
    expect(supportsHistogram("postgres", null)).toBe(false);
    const build = histogramStatements({
      driver: "mysql",
      table: t,
      database: "shop",
      columns: ["a"],
      buckets: 100,
      version: parseServerVersion("mysql", "5.7.44"),
    });
    expect(build).toEqual({ ok: false, reason: "versionTooOld" });
  });

  it("MCV は PostgreSQL 12 以降", () => {
    expect(supportsMcvStatistics("postgres", pg11)).toBe(false);
    expect(supportsMcvStatistics("postgres", pg16)).toBe(true);
    expect(
      createStatisticsStatements({
        driver: "postgres",
        table: t,
        database: "public",
        columns: ["a", "b"],
        kinds: ["mcv"],
        version: pg11,
      }),
    ).toEqual({ ok: false, reason: "mcvUnsupported" });
  });
});

describe("打ち手の SQL", () => {
  it("ANALYZE は識別子をクォートし、PostgreSQL だけ列を絞れる", () => {
    expect(analyzeStatements("mysql", t, "shop")).toEqual({
      ok: true,
      statements: ["ANALYZE TABLE `shop`.`orders`;"],
    });
    expect(analyzeStatements("postgres", t, "public", ["a", 'we"ird'])).toEqual({
      ok: true,
      statements: ['ANALYZE "public"."orders" ("a", "we""ird");'],
    });
    expect(analyzeStatements("sqlite", t, "main")).toEqual({ ok: true, statements: ['ANALYZE "orders";'] });
    expect(sqliteOptimizeStatements("sqlite")).toEqual({ ok: true, statements: ["PRAGMA optimize;"] });
    expect(sqliteOptimizeStatements("mysql").ok).toBe(false);
  });

  it("拡張統計は 2 列以上で、作成後に ANALYZE を続ける", () => {
    const base = { driver: "postgres", table: t, database: "public", version: pg16 } as const;
    expect(createStatisticsStatements({ ...base, columns: ["a"], kinds: [] })).toEqual({
      ok: false,
      reason: "tooFewColumns",
    });
    expect(
      createStatisticsStatements({ ...base, columns: ["a", "b"], kinds: ["dependencies", "ndistinct"] }),
    ).toEqual({
      ok: true,
      statements: [
        'CREATE STATISTICS "public"."orders_a_b_stat" (dependencies, ndistinct) ON "a", "b" FROM "public"."orders";',
        'ANALYZE "public"."orders";',
      ],
    });
    const taken = createStatisticsStatements({
      ...base,
      columns: ["a", "b"],
      kinds: [],
      takenNames: new Set(["orders_a_b_stat"]),
    });
    expect(taken.ok && taken.statements[0]).toContain('"orders_a_b_stat1" ON');
    expect(createStatisticsStatements({ ...base, driver: "mysql", columns: ["a", "b"], kinds: [] }).ok).toBe(
      false,
    );
  });

  it("統計目標は範囲を検証し、ALTER の後に ANALYZE を続ける", () => {
    const base = { driver: "postgres", table: t, database: "public", column: "a" } as const;
    expect(setStatisticsTargetStatements({ ...base, target: 500 })).toEqual({
      ok: true,
      statements: [
        'ALTER TABLE "public"."orders" ALTER COLUMN "a" SET STATISTICS 500;',
        'ANALYZE "public"."orders" ("a");',
      ],
    });
    expect(setStatisticsTargetStatements({ ...base, target: 10001 })).toEqual({
      ok: false,
      reason: "badNumber",
    });
    expect(setStatisticsTargetStatements({ ...base, target: 1.5 })).toEqual({
      ok: false,
      reason: "badNumber",
    });
  });

  it("ヒストグラムの作成と削除 (MySQL 8.0 以降)", () => {
    const v8 = parseServerVersion("mysql", "8.0.34");
    expect(
      histogramStatements({
        driver: "mysql",
        table: t,
        database: "shop",
        columns: ["a", "b"],
        buckets: 64,
        version: v8,
      }),
    ).toEqual({
      ok: true,
      statements: ["ANALYZE TABLE `shop`.`orders` UPDATE HISTOGRAM ON `a`, `b` WITH 64 BUCKETS;"],
    });
    expect(
      histogramStatements({
        driver: "mysql",
        table: t,
        database: "shop",
        columns: ["a"],
        buckets: 2000,
        version: v8,
      }),
    ).toEqual({ ok: false, reason: "badNumber" });
    expect(
      histogramStatements({
        driver: "mysql",
        table: t,
        database: "shop",
        columns: [],
        buckets: 10,
        version: v8,
      }),
    ).toEqual({ ok: false, reason: "noColumns" });
    expect(
      dropHistogramStatements({ driver: "mysql", table: t, database: "shop", columns: ["a"], version: v8 }),
    ).toEqual({
      ok: true,
      statements: ["ANALYZE TABLE `shop`.`orders` DROP HISTOGRAM ON `a`;"],
    });
  });

  it("拡張統計の削除", () => {
    expect(dropStatisticsStatements("postgres", "public", "s1")).toEqual({
      ok: true,
      statements: ['DROP STATISTICS "public"."s1";'],
    });
    expect(dropStatisticsStatements("mysql", "x", "s1").ok).toBe(false);
  });
});

describe("読み取りクエリとパース", () => {
  it("リテラルをエスケープし、スキーマ未指定でも組み立てる", () => {
    const q = { schema: null, table: "o'rders" };
    expect(freshnessSql("postgres", q, "public")[0]).toContain("relname = 'o''rders'");
    expect(freshnessSql("mysql", { schema: null, table: "a\\b" }, "shop")[0]).toContain(
      "table_name = 'a\\\\b'",
    );
    expect(columnsSql("postgres", t, null)).toContain("current_schemas(false)");
    expect(statsObjectsSql("sqlite", t, null)).toBeNull();
    expect(statsObjectsSql("postgres", t, "public")).toContain("pg_statistic_ext");
    expect(statsObjectsSql("mysql", t, "shop")).toContain("COLUMN_STATISTICS");
  });

  it("鮮度をドライバごとに読む", () => {
    const res = (rows: (string | number | null)[][]) => ({ columns: [], rows }) as never;
    expect(
      parseFreshness("postgres", [res([["public", "orders", "2026-01-01 00:00:00", null, 1200, 5000]])]),
    ).toMatchObject({
      found: true,
      lastAnalyze: "2026-01-01 00:00:00",
      lastAutoAnalyze: null,
      modsSinceAnalyze: 1200,
    });
    expect(parseFreshness("mysql", [res([["2026-02-02 10:00:00", 100]])]).lastAnalyze).toBe(
      "2026-02-02 10:00:00",
    );
    expect(parseFreshness("mysql", [res([])]).found).toBe(false);
    const sqlite = parseFreshness("sqlite", [res([["sqlite_stat1"]]), res([["ix", "100 10"]])]);
    expect(sqlite.sqlite).toEqual({
      hasStat1: true,
      hasStat4: false,
      entries: [{ index: "ix", stat: "100 10" }],
    });
  });

  it("拡張統計とヒストグラムの一覧を読む", () => {
    expect(
      parseExtendedStatistics({
        columns: [],
        rows: [["public", "s", "CREATE STATISTICS …", "{d,f,m}"]],
      } as never),
    ).toEqual([{ schema: "public", name: "s", definition: "CREATE STATISTICS …", kinds: ["d", "f", "m"] }]);
    expect(
      parseHistograms({ columns: [], rows: [["a", "equi-height", "100", "2026-01-01"]] } as never),
    ).toEqual([{ column: "a", type: "equi-height", buckets: 100, lastUpdated: "2026-01-01" }]);
  });
});

describe("PostgreSQL 9.x と MySQL の ANALYZE の失敗", () => {
  it("PG 9.6 も版として読み、拡張統計は使えない", () => {
    const v96 = parseServerVersion("postgres", "90600");
    expect(v96).toEqual({ major: 9, minor: 6, mariadb: false });
    expect(
      createStatisticsStatements({
        driver: "postgres",
        table: t,
        database: "public",
        columns: ["a", "b"],
        kinds: [],
        version: v96,
      }),
    ).toEqual({ ok: false, reason: "versionTooOld" });
  });

  it("ANALYZE TABLE の Error / Warning 行を失敗として返す", () => {
    const cols = ["Table", "Op", "Msg_type", "Msg_text"].map((name) => ({ name, type_name: "text" }));
    const ok = { columns: cols, rows: [["db.t", "analyze", "status", "OK"]] };
    const err = {
      columns: cols,
      rows: [
        ["db.t", "analyze", "Error", "Table 'db.t' doesn't exist"],
        ["db.t", "analyze", "status", "Operation failed"],
      ],
    };
    const warn = { columns: cols, rows: [["db.t", "histogram", "Warning", "Cannot create histogram"]] };
    expect(mysqlAnalyzeFailure(ok)).toBeNull();
    expect(mysqlAnalyzeFailure(err)).toBe("Table 'db.t' doesn't exist");
    expect(mysqlAnalyzeFailure(warn)).toBe("Cannot create histogram");
    expect(mysqlAnalyzeFailure({ columns: [{ name: "x", type_name: "int" }], rows: [[1]] })).toBeNull();
    expect(mysqlAnalyzeFailure(null)).toBeNull();
  });
});
