import { describe, expect, it } from "vitest";
import type { TablePartition, TablePartitions } from "../api/tauri";
import {
  addPartitionKind,
  advanceRange,
  compareBoundTuple,
  compareBoundValue,
  hasDefaultPartition,
  initialAddForm,
  planAddPartitions,
  reorganizesMaxvalue,
} from "../components/partitionAdd";
import { parseHashBound, parseListBound, parseRangeBound } from "../components/tablePartitions";

const part = (name: string, bound: string, over: Partial<TablePartition> = {}): TablePartition => ({
  name,
  schema: null,
  parent: null,
  parent_schema: null,
  depth: 0,
  bound,
  size_bytes: null,
  row_estimate: null,
  is_default: false,
  is_partitioned: false,
  sub_partition_key: null,
  ...over,
});
const info = (method: string, key: string, partitions: TablePartition[]): TablePartitions => ({
  method,
  key,
  sub_method: null,
  sub_key: null,
  partitions,
});
const pgRange = (...months: string[]) =>
  info(
    "RANGE",
    "created_at",
    months.map((m, i) => {
      const [y, mo] = m.split("-").map(Number) as [number, number];
      const next = mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, "0")}-01`;
      return part(`ev_${i}`, `FOR VALUES FROM ('${m}-01') TO ('${next}')`);
    }),
  );
const mysqlRange = (...uppers: string[]) =>
  info(
    "RANGE",
    "id",
    uppers.map((u, i) => part(`p${i}`, u === "MAXVALUE" ? "LESS THAN MAXVALUE" : `LESS THAN (${u})`)),
  );

describe("境界の解析", () => {
  it("RANGE / LIST / HASH を値に分ける", () => {
    expect(parseRangeBound("FOR VALUES FROM ('2026-01-01') TO ('2026-02-01')")).toEqual({
      from: ["2026-01-01"],
      to: ["2026-02-01"],
    });
    expect(parseRangeBound("FOR VALUES FROM (1, 'a') TO (MAXVALUE, MAXVALUE)")).toEqual({
      from: ["1", "a"],
      to: ["MAXVALUE", "MAXVALUE"],
    });
    expect(parseRangeBound("LESS THAN (100)")).toEqual({ from: null, to: ["100"] });
    expect(parseRangeBound("LESS THAN MAXVALUE")).toEqual({ from: null, to: ["MAXVALUE"] });
    expect(parseRangeBound("IN (1)")).toBeNull();
    expect(parseListBound("FOR VALUES IN ('x', 'it''s')")).toEqual(["x", "it's"]);
    expect(parseListBound("IN (1,2)")).toEqual(["1", "2"]);
    expect(parseHashBound("FOR VALUES WITH (modulus 4, remainder 1)")).toEqual({ modulus: 4, remainder: 1 });
  });
});

describe("compareBoundValue", () => {
  it("整数・日付・MINVALUE / MAXVALUE を比べ、型が違えば null", () => {
    expect(compareBoundValue("9", "10")).toBe(-1);
    expect(compareBoundValue("2026-02-01", "2026-01-31")).toBe(1);
    expect(compareBoundValue("2026-02-01", "2026-02-01 00:00:00")).toBe(0);
    expect(compareBoundValue("MAXVALUE", "99999999999999999999")).toBe(1);
    expect(compareBoundValue("minvalue", "-5")).toBe(-1);
    expect(compareBoundValue("abc", "abd")).toBeNull();
    expect(compareBoundTuple(["1", "2"], ["1", "3"])).toBe(-1);
    expect(compareBoundTuple(["1"], ["1", "3"])).toBeNull();
  });
});

describe("advanceRange (次の境界の推定)", () => {
  it("月・年・日の幅を保つ", () => {
    expect(advanceRange("2026-01-01", "2026-02-01")).toEqual({ from: "2026-02-01", to: "2026-03-01" });
    expect(advanceRange("2026-12-01", "2027-01-01")).toEqual({ from: "2027-01-01", to: "2027-02-01" });
    expect(advanceRange("2025-01-01", "2026-01-01")).toEqual({ from: "2026-01-01", to: "2027-01-01" });
    expect(advanceRange("2026-01-01", "2026-04-01")).toEqual({ from: "2026-04-01", to: "2026-07-01" });
    expect(advanceRange("2026-03-01", "2026-03-08")).toEqual({ from: "2026-03-08", to: "2026-03-15" });
    expect(advanceRange("2026-01-31", "2026-02-28")).toEqual({ from: "2026-02-28", to: "2026-03-28" });
    expect(advanceRange("2026-01-01 00:00:00", "2026-01-02 00:00:00")).toEqual({
      from: "2026-01-02 00:00:00",
      to: "2026-01-03 00:00:00",
    });
  });
  it("整数は同じ幅だけ進め、64bit も丸めない", () => {
    expect(advanceRange("0", "1000")).toEqual({ from: "1000", to: "2000" });
    expect(advanceRange("9007199254740993", "9007199254741993")).toEqual({
      from: "9007199254741993",
      to: "9007199254742993",
    });
  });
  it("推定できない値は null", () => {
    expect(advanceRange("a", "b")).toBeNull();
    expect(advanceRange("2", "1")).toBeNull();
    expect(advanceRange("MINVALUE", "10")).toBeNull();
  });
});

describe("addPartitionKind", () => {
  it("ドライバと方式で出し分ける。SQLite とサブパーティション付き MySQL は出さない", () => {
    expect(addPartitionKind("postgres", { method: "RANGE", sub_method: null })).toBe("range");
    expect(addPartitionKind("postgres", { method: "HASH", sub_method: null })).toBe("hash");
    expect(addPartitionKind("mysql", { method: "RANGE COLUMNS", sub_method: null })).toBe("range");
    expect(addPartitionKind("mysql", { method: "LIST", sub_method: null })).toBe("list");
    expect(addPartitionKind("mysql", { method: "LINEAR KEY", sub_method: null })).toBe("hashCount");
    expect(addPartitionKind("mysql", { method: "RANGE", sub_method: "HASH" })).toBeNull();
    expect(addPartitionKind("sqlite", { method: "RANGE", sub_method: null })).toBeNull();
  });
});

describe("PostgreSQL RANGE", () => {
  const i = pgRange("2026-01", "2026-02");
  it("初期値は同じ幅の次の期間と、既存名から付けた名前", () => {
    const f = initialAddForm("postgres", "orders", i, "range");
    expect(f.from).toEqual(["2026-03-01"]);
    expect(f.to).toEqual(["2026-04-01"]);
    expect(f.name).toBe("ev_2026_03");
  });
  it("1 件の PARTITION OF を作る", () => {
    const f = initialAddForm("postgres", "orders", i, "range");
    const plan = planAddPartitions("postgres", "app", "orders", i, "range", f);
    expect(plan.errors).toEqual([]);
    expect(plan.statements).toEqual([
      `CREATE TABLE "app"."ev_2026_03" PARTITION OF "app"."orders" FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');`,
    ]);
  });
  it("N 件まとめて作り、年をまたぐ", () => {
    const j = pgRange("2026-11", "2026-12");
    const f = { ...initialAddForm("postgres", "orders", j, "range"), count: "3" };
    const plan = planAddPartitions("postgres", null, "orders", j, "range", f);
    expect(plan.items.map((x) => x.name)).toEqual(["ev_2027_01", "ev_2027_02", "ev_2027_03"]);
    expect(plan.statements).toHaveLength(3);
    expect(plan.statements[2]).toBe(
      `CREATE TABLE "ev_2027_03" PARTITION OF "orders" FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');`,
    );
  });
  it("既存と重なる / FROM >= TO / 名前重複 / 空はエラーで SQL を出さない", () => {
    const f = initialAddForm("postgres", "orders", i, "range");
    const overlap = planAddPartitions("postgres", null, "orders", i, "range", {
      ...f,
      from: ["2026-02-15"],
      to: ["2026-03-15"],
    });
    expect(overlap.errors).toEqual([{ code: "rangeOverlap", detail: "ev_1" }]);
    expect(overlap.sql).toBe("");
    // 隣接 (to == 既存の from) は重ならない。
    const adj = planAddPartitions("postgres", null, "orders", i, "range", {
      ...f,
      from: ["2025-12-01"],
      to: ["2026-01-01"],
    });
    expect(adj.errors).toEqual([]);
    expect(
      planAddPartitions("postgres", null, "orders", i, "range", { ...f, to: ["2026-02-01"] }).errors,
    ).toEqual([{ code: "rangeOrder" }]);
    expect(planAddPartitions("postgres", null, "orders", i, "range", { ...f, name: "ev_0" }).errors).toEqual([
      { code: "nameDuplicate", detail: "ev_0" },
    ]);
    expect(planAddPartitions("postgres", null, "orders", i, "range", { ...f, to: [""] }).errors).toEqual([
      { code: "rangeEmpty" },
    ]);
    expect(planAddPartitions("postgres", null, "orders", i, "range", { ...f, count: "0" }).errors).toEqual([
      { code: "count" },
    ]);
  });
  it("名前と値の引用符を二重化して SQL を抜け出させない", () => {
    const f = initialAddForm("postgres", 'o"rders', i, "range");
    const plan = planAddPartitions("postgres", null, 'o"rders', i, "range", {
      ...f,
      name: 'x"y',
      to: ["2026-03-01'); DROP TABLE t; --"],
    });
    expect(plan.statements[0]).toContain(`"x""y" PARTITION OF "o""rders"`);
    expect(plan.statements[0]).toContain(`TO ('2026-03-01''); DROP TABLE t; --')`);
  });
  it("DEFAULT の有無を判定する", () => {
    expect(hasDefaultPartition(i)).toBe(false);
    expect(
      hasDefaultPartition({ partitions: [...i.partitions, part("d", "DEFAULT", { is_default: true })] }),
    ).toBe(true);
  });
  it("整数 RANGE と複数列 RANGE", () => {
    const ints = info("RANGE", "id", [
      part("a", "FOR VALUES FROM (0) TO (1000)"),
      part("b", "FOR VALUES FROM (1000) TO (2000)"),
    ]);
    const f = initialAddForm("postgres", "t", ints, "range");
    expect([f.from, f.to, f.name]).toEqual([["2000"], ["3000"], "b_2000"]);
    const multi = info("RANGE", "a, b", [part("m", "FOR VALUES FROM (1, 1) TO (2, 1)")]);
    const mf = initialAddForm("postgres", "t", multi, "range");
    expect(mf.from).toEqual(["2", "1"]);
    expect(mf.to).toEqual(["", ""]);
    const p = planAddPartitions("postgres", null, "t", multi, "range", {
      ...mf,
      name: "m2",
      to: ["3", "1"],
      count: "2",
    });
    expect(p.errors).toEqual([{ code: "countUnsupported" }]);
  });
});

describe("PostgreSQL LIST / HASH", () => {
  const list = info("LIST", "region", [part("r_a", "FOR VALUES IN ('a', 'b')")]);
  it("LIST: 値の重複を検出し、リテラルを引用する", () => {
    const f = { ...initialAddForm("postgres", "t", list, "list"), name: "r_c" };
    expect(
      planAddPartitions("postgres", null, "t", list, "list", { ...f, values: "c, 'it''s'" }).statements,
    ).toEqual([`CREATE TABLE "r_c" PARTITION OF "t" FOR VALUES IN ('c', 'it''s');`]);
    expect(planAddPartitions("postgres", null, "t", list, "list", { ...f, values: "c, b" }).errors).toEqual([
      { code: "listOverlap", detail: "b" },
    ]);
    expect(planAddPartitions("postgres", null, "t", list, "list", { ...f, values: " " }).errors).toEqual([
      { code: "listEmpty" },
    ]);
  });
  const hash = info("HASH", "id", [
    part("h0", "FOR VALUES WITH (modulus 4, remainder 0)"),
    part("h1", "FOR VALUES WITH (modulus 4, remainder 1)"),
    part("h3", "FOR VALUES WITH (modulus 4, remainder 3)"),
  ]);
  it("HASH: 未使用の剰余を提案し、重複は不可", () => {
    const f = initialAddForm("postgres", "t", hash, "hash");
    expect([f.modulus, f.remainder, f.name]).toEqual(["4", "2", "h2"]);
    expect(planAddPartitions("postgres", null, "t", hash, "hash", f).statements).toEqual([
      `CREATE TABLE "h2" PARTITION OF "t" FOR VALUES WITH (MODULUS 4, REMAINDER 2);`,
    ]);
    expect(
      planAddPartitions("postgres", null, "t", hash, "hash", { ...f, remainder: "3", name: "x" }).errors,
    ).toEqual([{ code: "hashDuplicate" }]);
    expect(planAddPartitions("postgres", null, "t", hash, "hash", { ...f, remainder: "4" }).errors).toEqual([
      { code: "hashRemainder" },
    ]);
  });
});

describe("MySQL", () => {
  it("MAXVALUE が無ければ ADD PARTITION (N 件まとめて)", () => {
    const i = mysqlRange("1000", "2000");
    const f = initialAddForm("mysql", "t", i, "range");
    expect([f.from, f.to, f.name]).toEqual([["2000"], ["3000"], "p2000"]);
    const plan = planAddPartitions("mysql", "app", "t", i, "range", { ...f, count: "2" });
    expect(plan.mode).toBe("add");
    expect(plan.statements).toEqual([
      "ALTER TABLE `app`.`t` ADD PARTITION (PARTITION `p2000` VALUES LESS THAN (3000), PARTITION `p3000` VALUES LESS THAN (4000));",
    ]);
  });
  it("MAXVALUE があれば REORGANIZE PARTITION で分割し、MAXVALUE を残す", () => {
    const i = mysqlRange("1000", "2000", "MAXVALUE");
    expect(reorganizesMaxvalue("mysql", "range", i)).toBe("p2");
    const f = initialAddForm("mysql", "t", i, "range");
    expect(f.to).toEqual(["3000"]);
    const plan = planAddPartitions("mysql", null, "t", i, "range", { ...f, name: "pnew" });
    expect(plan.mode).toBe("reorganize");
    expect(plan.statements).toEqual([
      "ALTER TABLE `t` REORGANIZE PARTITION `p2` INTO (PARTITION `pnew` VALUES LESS THAN (3000), PARTITION `p2` VALUES LESS THAN (MAXVALUE));",
    ]);
  });
  it("上限が既存より小さい / 等しいと実行前にエラー", () => {
    const i = mysqlRange("1000", "2000");
    const f = { ...initialAddForm("mysql", "t", i, "range"), name: "px" };
    expect(planAddPartitions("mysql", null, "t", i, "range", { ...f, to: ["1500"] }).errors).toEqual([
      { code: "rangeNotAscending", detail: "2000" },
    ]);
    expect(planAddPartitions("mysql", null, "t", i, "range", { ...f, to: ["2000"] }).errors).toEqual([
      { code: "rangeNotAscending", detail: "2000" },
    ]);
  });
  it("RANGE COLUMNS の日付は引用し、整数は引用しない", () => {
    const i = info("RANGE COLUMNS", "d", [
      part("a", "LESS THAN ('2026-01-01')"),
      part("b", "LESS THAN ('2026-02-01')"),
    ]);
    const f = initialAddForm("mysql", "t", i, "range");
    expect(f.to).toEqual(["2026-03-01"]);
    expect(planAddPartitions("mysql", null, "t", i, "range", f).statements[0]).toContain(
      "VALUES LESS THAN ('2026-03-01')",
    );
  });
  it("先頭の 1 件だけのときは幅を推定せず上限を空で提案する", () => {
    const i = mysqlRange("100");
    const f = initialAddForm("mysql", "t", i, "range");
    expect([f.from, f.to]).toEqual([["100"], [""]]);
  });
  it("LIST と HASH / KEY", () => {
    const list = info("LIST", "c", [part("a", "IN (1,2)")]);
    const f = { ...initialAddForm("mysql", "t", list, "list"), name: "b", values: "3, 'x'" };
    expect(planAddPartitions("mysql", null, "t", list, "list", f).statements).toEqual([
      "ALTER TABLE `t` ADD PARTITION (PARTITION `b` VALUES IN (3, 'x'));",
    ]);
    expect(planAddPartitions("mysql", null, "t", list, "list", { ...f, values: "2" }).errors).toEqual([
      { code: "listOverlap", detail: "2" },
    ]);
    const h = info("HASH", "id", [part("p0", ""), part("p1", "")]);
    const hf = { ...initialAddForm("mysql", "t", h, "hashCount"), count: "2" };
    expect(planAddPartitions("mysql", null, "t", h, "hashCount", hf).statements).toEqual([
      "ALTER TABLE `t` ADD PARTITION PARTITIONS 2;",
    ]);
  });
});

describe("レビュー指摘 (#2211)", () => {
  it("MySQL のリテラルは引用済みに見える入力も必ず引用し直す (バックスラッシュで文を抜け出せない)", () => {
    const list = info("LIST", "c", [part("a", "IN (1)")]);
    const f = { ...initialAddForm("mysql", "t", list, "list"), name: "b" };
    const evil = "'2027\\'' ) ; DROP TABLE x; -- '";
    const sql = planAddPartitions("mysql", null, "t", list, "list", { ...f, values: evil })
      .statements[0] as string;
    // 先頭・末尾以外の単一引用符はすべて '' になり、バックスラッシュは \\ になる。
    expect(sql).toBe(
      "ALTER TABLE `t` ADD PARTITION (PARTITION `b` VALUES IN ('''2027\\\\'''' ) ; DROP TABLE x; -- '''));",
    );
    const r = mysqlRange("1000");
    const rf = { ...initialAddForm("mysql", "t", r, "range"), name: "px", to: ["a\\"] };
    expect(planAddPartitions("mysql", null, "t", r, "range", rf).statements[0]).toContain(
      "LESS THAN ('a\\\\')",
    );
    expect(
      planAddPartitions("mysql", null, "t", list, "list", { ...f, values: "null, 5" }).statements[0],
    ).toContain("VALUES IN (NULL, 5)");
  });

  it("名前の接頭辞は MAXVALUE / DEFAULT の子から取らない", () => {
    const m = info("RANGE", "id", [
      part("p_2025", "LESS THAN (2026)"),
      part("p_2026", "LESS THAN (2027)"),
      part("pmax", "LESS THAN MAXVALUE"),
    ]);
    expect(initialAddForm("mysql", "t", m, "range").name).toBe("p_2027");
    const pg = info("RANGE", "id", [
      part("a_1", "FOR VALUES FROM (0) TO (10)"),
      part("a_2", "FOR VALUES FROM (10) TO (20)"),
      part("zz_default", "DEFAULT", { is_default: true }),
    ]);
    expect(initialAddForm("postgres", "t", pg, "range").name).toBe("a_20");
  });

  it("月末起点でも N 件が 1 件目の幅でずれずに進む", () => {
    const i = info("RANGE", "d", [part("m_0", "FOR VALUES FROM ('2026-11-30') TO ('2026-12-31')")]);
    const f = {
      ...initialAddForm("postgres", "t", i, "range"),
      from: ["2026-12-31"],
      to: ["2027-01-31"],
      count: "3",
    };
    const plan = planAddPartitions("postgres", null, "t", i, "range", f);
    expect(plan.items.map((x) => [x.from[0], x.to[0]])).toEqual([
      ["2026-12-31", "2027-01-31"],
      ["2027-01-31", "2027-02-28"],
      ["2027-02-28", "2027-03-31"],
    ]);
  });

  it("式キーの MySQL RANGE は名前を空欄で始める", () => {
    const i = info("RANGE", "to_days(`d`)", [part("p0", "LESS THAN (100)"), part("p1", "LESS THAN (200)")]);
    expect(initialAddForm("mysql", "t", i, "range").name).toBe("");
  });

  // src-tauri/tests/{postgres,mysql}_integration.rs が手書きしている文と、生成器の出力を同一に保つ。
  it("PostgreSQL 統合テストの文と生成器の出力が一致する", () => {
    const i = info("RANGE", "ts", [
      part("noobdb_padd_t_2026_01", "FOR VALUES FROM ('2026-01-01') TO ('2026-02-01')"),
    ]);
    const f = { ...initialAddForm("postgres", "noobdb_padd_t", i, "range"), count: "2" };
    expect(planAddPartitions("postgres", "public", "noobdb_padd_t", i, "range", f).statements).toEqual([
      `CREATE TABLE "public"."noobdb_padd_t_2026_02" PARTITION OF "public"."noobdb_padd_t" FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');`,
      `CREATE TABLE "public"."noobdb_padd_t_2026_03" PARTITION OF "public"."noobdb_padd_t" FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');`,
    ]);
    const dup = planAddPartitions("postgres", "public", "noobdb_padd_t", i, "range", {
      ...f,
      name: "noobdb_padd_t_dup",
      from: ["2026-01-15"],
      to: ["2026-02-15"],
    });
    expect(dup.errors[0]?.code).toBe("rangeOverlap");
  });

  it("MySQL 統合テストの文と生成器の出力が一致する", () => {
    const i = mysqlRange("2026", "2027");
    const f = { ...initialAddForm("mysql", "noobdb_padd_t", i, "range"), count: "2" };
    expect(planAddPartitions("mysql", "db", "noobdb_padd_t", i, "range", f).statements).toEqual([
      "ALTER TABLE `db`.`noobdb_padd_t` ADD PARTITION (PARTITION `p2027` VALUES LESS THAN (2028), PARTITION `p2028` VALUES LESS THAN (2029));",
    ]);
    const m = info("RANGE", "y", [
      part("p2025", "LESS THAN (2026)"),
      part("p2026", "LESS THAN (2027)"),
      part("p2027", "LESS THAN (2028)"),
      part("p2028", "LESS THAN (2029)"),
      part("pmax", "LESS THAN MAXVALUE"),
    ]);
    const mf = initialAddForm("mysql", "noobdb_padd_t", m, "range");
    expect(mf.name).toBe("p2029");
    expect(planAddPartitions("mysql", "db", "noobdb_padd_t", m, "range", mf).statements).toEqual([
      "ALTER TABLE `db`.`noobdb_padd_t` REORGANIZE PARTITION `pmax` INTO (PARTITION `p2029` VALUES LESS THAN (2030), PARTITION `pmax` VALUES LESS THAN (MAXVALUE));",
    ]);
  });
});
