import { describe, it, expect } from "vitest";
import {
  ALTER_COST_ROW_THRESHOLD,
  MYSQL_ONLINE_CLAUSE,
  classifyAlterCost,
  hasMysqlCopyRisk,
  shouldWarnForRows,
  withMysqlOnlineClause,
} from "../components/alterCost";
import type { ExistingColumnBaseline, ExistingColumnEdit } from "../components/alterTable";

const base = (name: string, type: string, notNull = false): ExistingColumnBaseline => ({
  name,
  type,
  notNull,
  defaultValue: "",
  extra: "",
});
const edit = (b: ExistingColumnBaseline, patch: Partial<ExistingColumnEdit> = {}): ExistingColumnEdit => ({
  original: b.name,
  drop: false,
  name: b.name,
  type: b.type,
  notNull: b.notNull,
  defaultValue: b.defaultValue,
  ...patch,
});
const run = (driver: string, b: ExistingColumnBaseline, patch: Partial<ExistingColumnEdit>) =>
  classifyAlterCost(driver, { baseline: [b], existing: [edit(b, patch)], added: [] }).map((r) => r.reason);

describe("classifyAlterCost (#1771)", () => {
  it("SQLite は常に空", () => {
    const b = base("a", "INTEGER");
    expect(run("sqlite", b, { type: "TEXT" })).toEqual([]);
  });

  it("変更が無ければ空", () => {
    expect(run("mysql", base("a", "int"), {})).toEqual([]);
    expect(run("postgres", base("a", "integer"), {})).toEqual([]);
  });

  describe("MySQL", () => {
    it("型変更は COPY", () => {
      expect(run("mysql", base("a", "int"), { type: "bigint" })).toEqual(["mysqlCopyType"]);
      expect(run("mysql", base("a", "varchar(100)"), { type: "varchar(50)" })).toEqual(["mysqlCopyType"]);
      expect(run("mysql", base("a", "varchar(10)"), { type: "text" })).toEqual(["mysqlCopyType"]);
    });
    it("VARCHAR を同じ長さクラスで拡張するのはインプレース", () => {
      expect(run("mysql", base("a", "varchar(20)"), { type: "varchar(60)" })).toEqual([]);
      expect(run("mysql", base("a", "varchar(100)"), { type: "varchar(300)" })).toEqual([]);
    });
    it("VARCHAR の拡張でも長さプレフィックスが 1→2 バイトにまたがるなら COPY", () => {
      expect(run("mysql", base("a", "varchar(60)"), { type: "varchar(100)" })).toEqual(["mysqlCopyType"]);
    });
    it("NULL 可否の変更はインプレース再構築、DEFAULT 変更は何も出ない", () => {
      expect(run("mysql", base("a", "int"), { notNull: true })).toEqual(["mysqlRebuildNullability"]);
      expect(run("mysql", base("a", "int"), { defaultValue: "1" })).toEqual([]);
    });
    it("DROP 予定の列・リネームのみは対象外", () => {
      expect(run("mysql", base("a", "int"), { drop: true, type: "bigint" })).toEqual([]);
      expect(run("mysql", base("a", "int"), { name: "b" })).toEqual([]);
    });
    it("FK / CHECK の追加は COPY、インデックスと列追加は対象外", () => {
      const risks = classifyAlterCost("mysql", {
        baseline: [],
        existing: [],
        added: [{ name: "c", defaultValue: "random()" }],
        indexes: [{ name: "i", columns: ["a"], unique: true }],
        addedForeignKeys: [
          {
            name: "fk",
            columns: ["a"],
            refTable: "p",
            refColumns: ["id"],
            onDelete: "NO ACTION",
            onUpdate: "NO ACTION",
          },
        ],
        addedChecks: [{ name: "ck", expression: "a > 0" }],
      });
      expect(risks.map((r) => r.reason)).toEqual(["mysqlCopyForeignKey", "mysqlCopyCheck"]);
      expect(hasMysqlCopyRisk(risks)).toBe(true);
    });
  });

  describe("PostgreSQL", () => {
    it("型変更は書き換え", () => {
      expect(run("postgres", base("a", "integer"), { type: "bigint" })).toEqual(["pgRewriteType"]);
      expect(run("postgres", base("a", "text"), { type: "integer" })).toEqual(["pgRewriteType"]);
      expect(run("postgres", base("a", "character varying(100)"), { type: "character varying(50)" })).toEqual(
        ["pgRewriteType"],
      );
      expect(run("postgres", base("a", "character(5)"), { type: "character(10)" })).toEqual([
        "pgRewriteType",
      ]);
    });
    it("書き換え不要な型変更 (VARCHAR 拡張・text 化・NUMERIC 精度拡張・別名) は出ない", () => {
      expect(run("postgres", base("a", "character varying(50)"), { type: "character varying(100)" })).toEqual(
        [],
      );
      expect(run("postgres", base("a", "character varying(50)"), { type: "text" })).toEqual([]);
      expect(run("postgres", base("a", "character varying(50)"), { type: "varchar" })).toEqual([]);
      expect(run("postgres", base("a", "numeric(10,2)"), { type: "numeric(12,2)" })).toEqual([]);
      expect(run("postgres", base("a", "integer"), { type: "int4" })).toEqual([]);
    });
    it("NUMERIC の小数桁変更は書き換え", () => {
      expect(run("postgres", base("a", "numeric(10,2)"), { type: "numeric(12,3)" })).toEqual([
        "pgRewriteType",
      ]);
    });
    it("SET NOT NULL は全件走査、DROP NOT NULL は出ない", () => {
      expect(run("postgres", base("a", "integer"), { notNull: true })).toEqual(["pgScanSetNotNull"]);
      expect(run("postgres", base("a", "integer", true), { notNull: false })).toEqual([]);
    });
    it("揮発的 DEFAULT 付き ADD COLUMN だけ書き換え", () => {
      const r = (d: string) =>
        classifyAlterCost("postgres", {
          baseline: [],
          existing: [],
          added: [{ name: "c", defaultValue: d }],
        }).map((x) => x.reason);
      expect(r("gen_random_uuid()")).toEqual(["pgRewriteVolatileDefault"]);
      expect(r("random()")).toEqual(["pgRewriteVolatileDefault"]);
      expect(r("now()")).toEqual([]);
      expect(r("0")).toEqual([]);
      expect(r("")).toEqual([]);
    });
    it("FK / CHECK 追加は走査、CREATE INDEX は書き込みロック", () => {
      const risks = classifyAlterCost("postgres", {
        baseline: [],
        existing: [],
        added: [],
        indexes: [{ name: "i", columns: ["a"], unique: false }],
        addedForeignKeys: [
          {
            name: "",
            columns: ["a"],
            refTable: "p",
            refColumns: ["id"],
            onDelete: "NO ACTION",
            onUpdate: "NO ACTION",
          },
        ],
        addedChecks: [{ name: "", expression: "a > 0" }],
      });
      expect(risks.map((r) => r.reason)).toEqual(["pgScanForeignKey", "pgScanCheck", "pgIndexBuildLock"]);
      expect(hasMysqlCopyRisk(risks)).toBe(false);
    });
  });
});

describe("shouldWarnForRows", () => {
  it("閾値未満は警告せず、不明なら警告する", () => {
    expect(shouldWarnForRows(ALTER_COST_ROW_THRESHOLD - 1)).toBe(false);
    expect(shouldWarnForRows(ALTER_COST_ROW_THRESHOLD)).toBe(true);
    expect(shouldWarnForRows(null)).toBe(true);
    expect(shouldWarnForRows(undefined)).toBe(true);
    expect(shouldWarnForRows(0)).toBe(false);
  });
});

describe("withMysqlOnlineClause", () => {
  const st = (sql: string) => ({ sql, kind: "modifyColumn" as const, destructive: false });
  it("ALTER TABLE は末尾に ', 句'、CREATE INDEX は空白区切りで付ける", () => {
    const out = withMysqlOnlineClause("mysql", [
      st("ALTER TABLE `t` CHANGE COLUMN `a` `a` bigint;"),
      st("CREATE UNIQUE INDEX `i` ON `t` (`a`);"),
    ]);
    expect(out[0].sql).toBe(`ALTER TABLE \`t\` CHANGE COLUMN \`a\` \`a\` bigint, ${MYSQL_ONLINE_CLAUSE};`);
    expect(out[1].sql).toBe("CREATE UNIQUE INDEX `i` ON `t` (`a`) ALGORITHM=INPLACE LOCK=NONE;");
  });
  it("MySQL 以外・認識できない文はそのまま", () => {
    const s = st("ALTER TABLE t ALTER COLUMN a TYPE bigint;");
    expect(withMysqlOnlineClause("postgres", [s])[0]).toEqual(s);
    expect(withMysqlOnlineClause("mysql", [st("COMMENT ON TABLE t IS 'x';")])[0].sql).toBe(
      "COMMENT ON TABLE t IS 'x';",
    );
  });
});
