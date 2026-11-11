import { describe, expect, it } from "vitest";
import type { TablePartition, TablePartitions } from "../api/tauri";
import {
  type AddPartitionForm,
  emptyErrorField,
  initialAddForm,
  planAddPartitions,
} from "../components/partitionAdd";
import {
  buildRibbon,
  ghostForAdd,
  partitionId,
  partitionShares,
  ribbonKindOf,
} from "../components/partitionRibbonLayout";

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
const pgRange = (name: string, from: string, to: string, over: Partial<TablePartition> = {}) =>
  part(name, `FOR VALUES FROM ('${from}') TO ('${to}')`, over);

describe("ribbonKindOf", () => {
  it("分割方式から種別を決める", () => {
    expect(ribbonKindOf("RANGE")).toBe("range");
    expect(ribbonKindOf("RANGE COLUMNS")).toBe("range");
    expect(ribbonKindOf("LIST")).toBe("list");
    expect(ribbonKindOf("LINEAR HASH")).toBe("hash");
    expect(ribbonKindOf("KEY")).toBe("hash");
    expect(ribbonKindOf("")).toBe("other");
  });
});

describe("buildRibbon: RANGE", () => {
  it("0 件なら空", () => {
    expect(buildRibbon("postgres", info("RANGE", "d", [])).segments).toEqual([]);
  });

  it("連続した範囲は隙間なし、濃さはサイズの最大が 1", () => {
    const r = buildRibbon(
      "postgres",
      info("RANGE", "d", [
        pgRange("p1", "2026-01-01", "2026-02-01", { size_bytes: 100 }),
        pgRange("p2", "2026-02-01", "2026-03-01", { size_bytes: 50 }),
      ]),
      ["date"],
    );
    expect(r.segments.map((s) => [s.name, s.kind, s.gapBefore])).toEqual([
      ["p1", "range", false],
      ["p2", "range", false],
    ]);
    expect(r.segments.map((s) => s.heat)).toEqual([1, 0.5]);
    expect(r.segments[0]?.label).toBe("2026-01-01 → 2026-02-01");
  });

  it("PostgreSQL は前の TO と次の FROM が食い違えば隙間", () => {
    const r = buildRibbon(
      "postgres",
      info("RANGE", "d", [
        pgRange("p1", "2026-01-01", "2026-02-01"),
        pgRange("p3", "2026-03-01", "2026-04-01"),
      ]),
      ["date"],
    );
    expect(r.segments.map((s) => s.gapBefore)).toEqual([false, true]);
  });

  it("名前順と境界順が食い違う PostgreSQL の RANGE でも、境界順に並べて偽の隙間を出さない", () => {
    const r = buildRibbon(
      "postgres",
      info("RANGE", "n", [
        part("p_1", "FOR VALUES FROM ('1') TO ('2')"),
        part("p_10", "FOR VALUES FROM ('10') TO ('11')"),
        part("p_2", "FOR VALUES FROM ('2') TO ('3')"),
      ]),
      ["int"],
    );
    expect(r.segments.map((s) => s.name)).toEqual(["p_1", "p_2", "p_10"]);
    expect(r.segments.map((s) => s.gapBefore)).toEqual([false, false, true]);
    const r2 = buildRibbon(
      "postgres",
      info("RANGE", "n", [
        part("p_1", "FOR VALUES FROM ('1') TO ('2')"),
        part("p_10", "FOR VALUES FROM ('3') TO ('4')"),
        part("p_2", "FOR VALUES FROM ('2') TO ('3')"),
      ]),
      ["int"],
    );
    expect(r2.segments.map((s) => s.name)).toEqual(["p_1", "p_2", "p_10"]);
    expect(r2.segments.some((s) => s.gapBefore)).toBe(false);
  });

  it("キーの型が分からないと隙間は判定しない", () => {
    const r = buildRibbon("postgres", info("RANGE", "d", [pgRange("p1", "a", "b"), pgRange("p3", "c", "d")]));
    expect(r.segments.map((s) => s.gapBefore)).toEqual([false, false]);
  });

  it("MySQL は LESS THAN だけなので隙間は無く、MAXVALUE は有限の範囲の後ろ", () => {
    const r = buildRibbon(
      "mysql",
      info("RANGE", "y", [
        part("pmax", "LESS THAN MAXVALUE"),
        part("p2025", "LESS THAN (2026)"),
        part("p2026", "LESS THAN (2027)"),
      ]),
      ["int"],
    );
    expect(r.segments.map((s) => [s.name, s.kind, s.gapBefore])).toEqual([
      ["p2025", "range", false],
      ["p2026", "range", false],
      ["pmax", "maxvalue", false],
    ]);
    expect(r.segments[0]?.label).toBe("< 2026");
  });

  it("DEFAULT は最後に置く", () => {
    const r = buildRibbon(
      "postgres",
      info("RANGE", "d", [
        part("pdef", "DEFAULT", { is_default: true }),
        pgRange("p1", "2026-01-01", "2026-02-01"),
      ]),
    );
    expect(r.segments.map((s) => s.kind)).toEqual(["range", "default"]);
    expect(r.segments[1]?.label).toBe("DEFAULT");
  });

  it("サブパーティションは親の subs に入る", () => {
    const r = buildRibbon(
      "postgres",
      info("RANGE", "d", [
        pgRange("p1", "2026-01-01", "2026-02-01", { size_bytes: 10 }),
        part("p1_a", "FOR VALUES IN ('a')", { depth: 1, parent: "p1", size_bytes: 8 }),
        part("p1_b", "FOR VALUES IN ('b')", { depth: 1, parent: "p1", size_bytes: 2 }),
      ]),
    );
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]?.subs.map((s) => [s.name, s.heat])).toEqual([
      ["p1_a", 1],
      ["p1_b", 0.25],
    ]);
  });
});

describe("buildRibbon: 別スキーマの同名の親", () => {
  it("サブパーティションを (スキーマ, 親名) ごとにまとめ、偏りも兄弟ごとに計算する", () => {
    const r = buildRibbon(
      "postgres",
      info("LIST", "k", [
        part("p", "FOR VALUES IN ('a')", { schema: "a" }),
        part("p", "FOR VALUES IN ('b')", { schema: "b" }),
        part("x1", "FOR VALUES IN ('1')", {
          schema: "a",
          depth: 1,
          parent: "p",
          parent_schema: "a",
          size_bytes: 5,
        }),
        part("y1", "FOR VALUES IN ('2')", {
          schema: "b",
          depth: 1,
          parent: "p",
          parent_schema: "b",
          size_bytes: 7,
        }),
        part("y2", "FOR VALUES IN ('3')", {
          schema: "b",
          depth: 1,
          parent: "p",
          parent_schema: "b",
          size_bytes: 7,
        }),
      ]),
    );
    expect(r.segments.map((s) => s.subs.map((x) => x.name))).toEqual([["x1"], ["y1", "y2"]]);
  });

  it("partitionShares の兄弟は (スキーマ, 親) 単位", () => {
    const ps = [
      part("x1", "", { schema: "a", depth: 1, parent: "p", parent_schema: "a", size_bytes: 5 }),
      part("y1", "", { schema: "b", depth: 1, parent: "p", parent_schema: "b", size_bytes: 7 }),
    ];
    const m = partitionShares(ps);
    expect(m.get(partitionId(ps[0] as TablePartition))?.sizeShare).toBe(1);
    expect(m.get(partitionId(ps[1] as TablePartition))?.sizeShare).toBe(1);
  });
});

describe("buildRibbon: LIST / HASH", () => {
  it("LIST は値ごとのタイル", () => {
    const r = buildRibbon(
      "postgres",
      info("LIST", "region", [
        part("pj", "FOR VALUES IN ('jp', 'kr')"),
        part("pd", "DEFAULT", { is_default: true }),
      ]),
    );
    expect(r.segments.map((s) => [s.kind, s.label])).toEqual([
      ["list", "jp, kr"],
      ["default", "DEFAULT"],
    ]);
  });

  it("PostgreSQL の HASH は剰余のスロットに並び、未使用の剰余は空きスロット", () => {
    const r = buildRibbon(
      "postgres",
      info("HASH", "id", [
        part("h2", "FOR VALUES WITH (modulus 4, remainder 2)"),
        part("h0", "FOR VALUES WITH (modulus 4, remainder 0)"),
      ]),
    );
    expect(r.segments.map((s) => s.kind)).toEqual(["hash", "hashEmpty", "hash", "hashEmpty"]);
    expect(r.segments.map((s) => s.name)).toEqual(["h0", "", "h2", ""]);
  });

  it("MODULUS が混在すると、既存の子だけを並べる", () => {
    const r = buildRibbon(
      "postgres",
      info("HASH", "id", [
        part("a", "FOR VALUES WITH (modulus 2, remainder 0)"),
        part("b", "FOR VALUES WITH (modulus 4, remainder 1)"),
      ]),
    );
    expect(r.segments.map((s) => s.name)).toEqual(["a", "b"]);
  });

  it("MySQL の HASH は境界が無いので名前のタイル", () => {
    const r = buildRibbon("mysql", info("HASH", "id", [part("p0", ""), part("p1", "")]));
    expect(r.segments.map((s) => [s.name, s.kind])).toEqual([
      ["p0", "plain"],
      ["p1", "plain"],
    ]);
  });
});

describe("partitionShares", () => {
  it("合計に対する割合と、平均の 2 倍以上の偏り", () => {
    const ps = [
      part("a", "", { size_bytes: 80, row_estimate: 10 }),
      part("b", "", { size_bytes: 10, row_estimate: 10 }),
      part("c", "", { size_bytes: 10, row_estimate: 10 }),
    ];
    const m = partitionShares(ps);
    expect(m.get(partitionId(ps[0] as TablePartition))).toMatchObject({
      sizeShare: 0.8,
      sizeHot: true,
      rowHot: false,
    });
    expect(m.get(partitionId(ps[1] as TablePartition))?.sizeHot).toBe(false);
  });

  it("先に空で作ったパーティションが多くても、過去分すべてを偏りにしない", () => {
    const ps = [
      ...Array.from({ length: 12 }, (_, i) => part(`e${i}`, "", { size_bytes: 0, row_estimate: 0 })),
      part("a", "", { size_bytes: 100, row_estimate: 10 }),
      part("b", "", { size_bytes: 100, row_estimate: 10 }),
      part("c", "", { size_bytes: 100, row_estimate: 10 }),
    ];
    const m = partitionShares(ps);
    expect(ps.some((p) => m.get(partitionId(p))?.sizeHot || m.get(partitionId(p))?.rowHot)).toBe(false);
    expect(m.get(partitionId(ps[0] as TablePartition))?.sizeShare).toBe(0);
  });

  it("2 件以下・合計 0・不明は偏りにしない", () => {
    const two = [part("a", "", { size_bytes: 99 }), part("b", "", { size_bytes: 1 })];
    expect(partitionShares(two).get(partitionId(two[0] as TablePartition))?.sizeHot).toBe(false);
    const zero = [
      part("a", "", { size_bytes: 0 }),
      part("b", "", { size_bytes: 0 }),
      part("c", "", { size_bytes: 0 }),
    ];
    expect(partitionShares(zero).get(partitionId(zero[0] as TablePartition))?.sizeShare).toBeNull();
    const unknown = [part("a", ""), part("b", ""), part("c", "")];
    expect(partitionShares(unknown).get(partitionId(unknown[0] as TablePartition))?.sizeShare).toBeNull();
  });

  it("サブパーティションは親ごとに集計する", () => {
    const ps = [
      part("x", "", { depth: 1, parent: "p1", size_bytes: 1 }),
      part("y", "", { depth: 1, parent: "p2", size_bytes: 9 }),
    ];
    const m = partitionShares(ps);
    expect(m.get(partitionId(ps[0] as TablePartition))?.sizeShare).toBe(1);
  });
});

describe("ghostForAdd", () => {
  const ghost = (
    driver: string,
    i: TablePartitions,
    kind: Parameters<typeof initialAddForm>[3],
    patch: Partial<AddPartitionForm> = {},
  ) => {
    const ribbon = buildRibbon(driver, i, ["date"]);
    const form = { ...initialAddForm(driver, "t", i, kind, ["date"]), ...patch };
    const plan = planAddPartitions(driver, null, "t", i, kind, form, ["date"]);
    return { ribbon, g: ghostForAdd(driver, kind, ribbon, form, plan, ["date"]) };
  };

  it("RANGE は末尾 (DEFAULT の手前) に入り、PostgreSQL は DEFAULT をスキャン対象にする", () => {
    const i = info("RANGE", "d", [
      pgRange("p1", "2026-01-01", "2026-02-01"),
      pgRange("p2", "2026-02-01", "2026-03-01"),
      part("pdef", "DEFAULT", { is_default: true }),
    ]);
    const { g } = ghost("postgres", i, "range");
    expect(g?.index).toBe(2);
    expect(g?.items[0]?.label).toBe("2026-03-01 → 2026-04-01");
    expect(g?.scanId).toBe(partitionId(i.partitions[2] as TablePartition));
  });

  it("入力に追従し、空なら仮ラベル用に空文字", () => {
    const i = info("RANGE", "d", [pgRange("p1", "2026-01-01", "2026-02-01")]);
    expect(ghost("postgres", i, "range", { to: ["2026-06-01"] }).g?.items[0]?.label).toBe(
      "2026-02-01 → 2026-06-01",
    );
    expect(ghost("postgres", i, "range", { to: [""] }).g?.items[0]?.label).toBe("");
  });

  it("件数ぶんのゴーストを出す", () => {
    const i = info("RANGE", "d", [pgRange("p1", "2026-01-01", "2026-02-01")]);
    expect(ghost("postgres", i, "range", { count: "3" }).g?.items).toHaveLength(3);
  });

  it("上限が小さい入力は既存の範囲の手前に入る", () => {
    const i = info("RANGE", "d", [
      pgRange("p1", "2026-01-01", "2026-02-01"),
      pgRange("p3", "2026-03-01", "2026-04-01"),
    ]);
    const { g } = ghost("postgres", i, "range", { from: ["2026-02-01"], to: ["2026-03-01"] });
    expect(g?.index).toBe(1);
  });

  it("MySQL の MAXVALUE は REORGANIZE で割られ、その手前に入る", () => {
    const i = info("RANGE", "y", [part("p2025", "LESS THAN (2026)"), part("pmax", "LESS THAN MAXVALUE")]);
    const ribbon = buildRibbon("mysql", i, ["int"]);
    const form = initialAddForm("mysql", "t", i, "range", ["int"]);
    const f = { ...form, name: "p2026", to: ["2027"] };
    const plan = planAddPartitions("mysql", null, "t", i, "range", f, ["int"]);
    const g = ghostForAdd("mysql", "range", ribbon, f, plan, ["int"]);
    expect(g?.index).toBe(1);
    expect(g?.splitId).toBe(partitionId(i.partitions[1] as TablePartition));
    expect(g?.items[0]?.label).toBe("< 2027");
  });

  it("LIST は値を入力に追従させる", () => {
    const i = info("LIST", "r", [part("pj", "FOR VALUES IN ('jp')")]);
    expect(ghost("postgres", i, "list", { values: "us, ca" }).g?.items[0]?.label).toBe("us, ca");
    expect(ghost("postgres", i, "list").g?.items[0]?.label).toBe("");
  });

  it("HASH は未使用の剰余のスロットを置き換える", () => {
    const i = info("HASH", "id", [part("h0", "FOR VALUES WITH (modulus 4, remainder 0)")]);
    const { ribbon, g } = ghost("postgres", i, "hash");
    expect(ribbon.segments).toHaveLength(4);
    expect(g?.index).toBe(1);
    expect(g?.replaces).toBe("hash-slot:1");
    expect(g?.items[0]?.label).toBe("1 / 4");
  });

  it("MySQL の HASH / KEY は件数ぶんを末尾に", () => {
    const i = info("HASH", "id", [part("p0", ""), part("p1", "")]);
    const { g } = ghost("mysql", i, "hashCount", { count: "3" });
    expect(g?.index).toBe(2);
    expect(g?.items).toHaveLength(3);
  });
});

describe("emptyErrorField", () => {
  it("未入力系だけが欄のグループに対応する", () => {
    expect(emptyErrorField("listEmpty")).toBe("bound");
    expect(emptyErrorField("rangeEmpty")).toBe("bound");
    expect(emptyErrorField("nameEmpty")).toBe("name");
    expect(emptyErrorField("rangeOverlap")).toBeNull();
    expect(emptyErrorField("nameDuplicate")).toBeNull();
  });
});
