import { describe, expect, it } from "vitest";
import type { SchemaDocForeignKey, SchemaDocTable } from "../ai/schemaDoc";
import {
  buildCachedSchemaDoc,
  buildSchemaDocIncrementalPrompt,
  buildSchemaDocIncrementalSystem,
  isCachedSchemaDoc,
  mergeTableSections,
  objectsFingerprint,
  planIncremental,
  splitTableSections,
  tableFingerprints,
} from "../ai/schemaDocIncremental";

const table = (
  name: string,
  cols: string[] = ["id"],
  over: Partial<SchemaDocTable> = {},
): SchemaDocTable => ({
  name,
  isView: false,
  comment: null,
  columns: cols.map((c) => ({ name: c, data_type: "int", nullable: false, key: "", comment: null })),
  indexes: [],
  ...over,
});
const fk = (t: string, ref: string): SchemaDocForeignKey => ({
  table: t,
  column: `${ref}_id`,
  referenced_table: ref,
  referenced_column: "id",
});

const EXTRA = ["e1", "e2", "e3", "e4", "e5"];
const BODY = [
  "# Doc",
  "",
  "## Overview",
  "overview text",
  "",
  "## Table details",
  "",
  "### customers",
  "customers role",
  "",
  "| name | type |",
  "",
  "### orders",
  "orders role",
  "",
  "### products (view)",
  "products role",
  "",
  ...EXTRA.flatMap((n) => [`### ${n}`, `${n} role`, ""]),
  "## Relationships",
  "orders -> customers",
].join("\n");

describe("表ごとの指紋 (#1620)", () => {
  it("その表の列・インデックス・外部キーが変わると変わり、他の表には影響しない", () => {
    const fks = [fk("orders", "customers")];
    const a = tableFingerprints([table("customers"), table("orders", ["id", "customers_id"])], fks);
    const b = tableFingerprints([table("customers"), table("orders", ["id", "customers_id", "note"])], fks);
    expect(b.customers).toBe(a.customers);
    expect(b.orders).not.toBe(a.orders);
    // 外部キーの追加は、持つ側の表だけ変える。
    const c = tableFingerprints([table("customers"), table("orders", ["id", "customers_id"])], []);
    expect(c.orders).not.toBe(a.orders);
    expect(c.customers).toBe(a.customers);
  });

  it("ビュー / ルーチンの定義の指紋は定義の変更で変わる", () => {
    const o = (def: string | null) => [{ kind: "view", name: "v", definition: def }];
    expect(objectsFingerprint(o("select 1"))).toBe(objectsFingerprint(o("select 1")));
    expect(objectsFingerprint(o("select 1"))).not.toBe(objectsFingerprint(o("select 2")));
  });
});

describe("節の分割 (#1620)", () => {
  it("既知の表の ### 見出しだけを節として取り、次の見出し (レベル 1〜3) で終える", () => {
    const secs = splitTableSections(BODY, ["customers", "orders", "products"]);
    expect(secs.map((s) => s.name)).toEqual(["customers", "orders", "products"]);
    expect(splitTableSections(BODY, ["customers", "orders", "products", ...EXTRA])).toHaveLength(8);
    const lines = BODY.split("\n");
    expect(lines[secs[0].start]).toBe("### customers");
    expect(lines[secs[2].end]).toBe("### e1");
  });

  it("未知の見出し・バッククォート付き・コードフェンス内の # を正しく扱う", () => {
    const body = ["### `t1`", "x", "```", "### t2", "```", "### other", "y"].join("\n");
    const secs = splitTableSections(body, ["t1", "t2"]);
    expect(secs.map((s) => s.name)).toEqual(["t1"]);
    expect(secs[0].end).toBe(5); // `### other` で終わる
  });
});

describe("差分計画 (#1620)", () => {
  const names = ["customers", "orders", "products", ...EXTRA];
  const hashes: Record<string, string> = Object.fromEntries(names.map((n, i) => [n, `h${i}`]));
  const cached = buildCachedSchemaDoc({
    locale: "ja",
    driver: "mysql",
    maskLiterals: true,
    objectsFp: "o",
    hashes,
    body: BODY,
    generatedAt: 1,
  });
  const base = {
    cached,
    locale: "ja" as const,
    driver: "mysql",
    maskLiterals: true,
    objectsFp: "o",
    tableNames: names,
    hashes,
    foreignKeys: [fk("orders", "customers")],
  };

  it("保存が無い / 言語・ドライバ・マスク設定が違う / 定義が変わったときは全体", () => {
    expect(planIncremental({ ...base, cached: null })).toEqual({ mode: "full", reason: "noCache" });
    expect(planIncremental({ ...base, locale: "en" })).toEqual({ mode: "full", reason: "incompatible" });
    expect(planIncremental({ ...base, driver: "postgres" })).toEqual({
      mode: "full",
      reason: "incompatible",
    });
    expect(planIncremental({ ...base, maskLiterals: false })).toEqual({
      mode: "full",
      reason: "incompatible",
    });
    expect(planIncremental({ ...base, objectsFp: "x" })).toEqual({ mode: "full", reason: "objectsChanged" });
    expect(planIncremental({ ...base, cached: { ...cached, body: "# nothing" } })).toEqual({
      mode: "full",
      reason: "noSections",
    });
  });

  it("何も変わっていなければ none (AI を呼ばない)", () => {
    expect(planIncremental(base)).toEqual({ mode: "none", reused: 8 });
  });

  it("変わった表と、その外部キーの参照先だけを作り直し、残りは再利用する", () => {
    const plan = planIncremental({ ...base, hashes: { ...hashes, orders: "B" } });
    expect(plan).toEqual({
      mode: "incremental",
      changed: ["orders"],
      regenerate: ["customers", "orders"], // customers は orders の参照先
      removed: [],
      reused: 6,
    });
  });

  it("親の変更は子へ波及しない。新しい表は変更扱い、消えた表は removed", () => {
    const plan = planIncremental({
      ...base,
      tableNames: ["customers", "orders", "shipments", ...EXTRA],
      hashes: { ...hashes, customers: "A", shipments: "s" },
    });
    expect(plan).toMatchObject({
      mode: "incremental",
      changed: ["customers", "shipments"],
      regenerate: ["customers", "shipments"],
      removed: ["products"],
      reused: 6,
    });
  });

  it("表を取り除くだけでも差分になる (none ではない)", () => {
    const plan = planIncremental({ ...base, tableNames: ["customers", "orders", ...EXTRA] });
    expect(plan).toMatchObject({ mode: "incremental", regenerate: [], removed: ["products"], reused: 7 });
  });

  it("前回の本文に節が無い表は、指紋が同じでも作り直す", () => {
    const body = BODY.replace("### orders", "### ordersX");
    const plan = planIncremental({ ...base, cached: { ...cached, body } });
    expect(plan).toMatchObject({ mode: "incremental", regenerate: ["orders"] });
  });

  it("作り直す表が多すぎるときは全体", () => {
    const plan = planIncremental({
      ...base,
      hashes: Object.fromEntries(names.map((n) => [n, "changed"])),
    });
    expect(plan).toEqual({ mode: "full", reason: "tooMany" });
  });
});

describe("節の結合 (#1620)", () => {
  it("作り直した表の節だけ差し替え、他の節・概要・関係の節は前回のまま", () => {
    const merged = mergeTableSections({
      prevBody: BODY,
      newBody: "### orders\nNEW orders role\n\n### customers\nNEW customers role",
      order: ["customers", "orders", "products"],
      regenerate: ["customers", "orders"],
      removed: [],
    });
    expect(merged.updated).toEqual(["customers", "orders"]);
    expect(merged.missing).toEqual([]);
    expect(merged.body).toContain("overview text");
    expect(merged.body).toContain("NEW orders role");
    expect(merged.body).toContain("NEW customers role");
    expect(merged.body).not.toContain("customers role\n\n| name | type |");
    expect(merged.body).toContain("products role");
    expect(merged.body).toContain("## Relationships\norders -> customers");
    // 並びは前回のまま、節の間は空行 1 つ。
    expect(merged.body.indexOf("### customers")).toBeLessThan(merged.body.indexOf("### orders"));
    expect(merged.body).not.toMatch(/\n{3,}/);
  });

  it("取り除く表の節は消える", () => {
    const merged = mergeTableSections({
      prevBody: BODY,
      newBody: "",
      order: ["customers", "orders"],
      regenerate: [],
      removed: ["products"],
    });
    expect(merged.body).not.toContain("products");
    expect(merged.body).toContain("### orders");
    expect(merged.body).toContain("## Relationships");
  });

  it("新しい表は並び順で直前の表の節の後ろ、直前が無ければ最初の節の前、節が無ければ末尾へ入る", () => {
    const merged = mergeTableSections({
      prevBody: BODY,
      newBody: "### aaa\nA\n\n### orders_x\nOX\n\n### zzz\nZ",
      order: ["aaa", "customers", "orders", "orders_x", "products", ...EXTRA, "zzz"],
      regenerate: ["aaa", "orders_x", "zzz"],
      removed: [],
    });
    const idx = (s: string) => merged.body.indexOf(s);
    expect(idx("### aaa")).toBeLessThan(idx("### customers"));
    expect(idx("### orders\n")).toBeLessThan(idx("### orders_x"));
    expect(idx("### orders_x")).toBeLessThan(idx("### products"));
    expect(idx("### zzz")).toBeGreaterThan(idx("### e5"));
    expect(idx("### zzz")).toBeLessThan(idx("## Relationships"));

    const noSections = mergeTableSections({
      prevBody: "# T\n\ntext",
      newBody: "### a\nA",
      order: ["a"],
      regenerate: ["a"],
      removed: [],
    });
    expect(noSections.body).toBe("# T\n\ntext\n\n### a\nA");
  });

  it("AI が節を返さなかった表は前回の節を残し、missing に載せる", () => {
    const merged = mergeTableSections({
      prevBody: BODY,
      newBody: "### customers\nNEW",
      order: ["customers", "orders", "products"],
      regenerate: ["customers", "orders"],
      removed: [],
    });
    expect(merged.updated).toEqual(["customers"]);
    expect(merged.missing).toEqual(["orders"]);
    expect(merged.body).toContain("orders role");
  });
});

describe("差分用プロンプトと保存形式 (#1620)", () => {
  it("作り直す表のスキーマだけを載せ、他の表は名前だけ。節だけを返させる", () => {
    const system = buildSchemaDocIncrementalSystem({
      driver: "postgres",
      database: "app",
      locale: "ja",
      context: {
        tables: [table("orders", ["id", "secret_col"])],
        foreignKeys: [fk("orders", "customers")],
        objects: [],
      },
      otherTables: ["customers", "products"],
      mask: { driver: "postgres", maskLiterals: true },
    });
    expect(system).toContain("### orders");
    expect(system).toContain("- secret_col | int");
    expect(system).toContain("Other tables in the database (names only");
    expect(system).toContain("customers, products");
    expect(system).toContain("Do not write any other heading");
    expect(system).toContain("Japanese");
    expect(buildSchemaDocIncrementalPrompt("en", ["orders"])).toContain("1 tables");
  });

  it("保存形式の検証", () => {
    const ok = buildCachedSchemaDoc({
      locale: "en",
      driver: "mysql",
      maskLiterals: false,
      objectsFp: "o",
      hashes: { a: "1" },
      body: "b",
      generatedAt: 1,
    });
    expect(isCachedSchemaDoc(ok)).toBe(true);
    expect(isCachedSchemaDoc({ ...ok, v: 0 })).toBe(false);
    expect(isCachedSchemaDoc({ ...ok, hashes: { a: 1 } })).toBe(false);
    expect(isCachedSchemaDoc({ ...ok, locale: "fr" })).toBe(false);
    expect(isCachedSchemaDoc(null)).toBe(false);
  });
});
