import { describe, expect, it } from "vitest";
import type { TableColumnInfo } from "../api/tauri";
import { inferColumnSpec } from "../components/testDataGen";
import {
  buildTestDataAiContext,
  buildTestDataPlan,
  buildTestDataPrompt,
  buildTestDataSystem,
  generateAiDataset,
  parseTestDataResponse,
  summarizeTestDataSend,
  TEST_DATA_FORMAT,
  TEST_DATA_MAX_CHOICES,
  uniqueColumnNames,
  type TestDataAiResponse,
} from "../ai/testData";

function col(over: Partial<TableColumnInfo> & { name: string }): TableColumnInfo {
  return {
    data_type: "varchar(100)",
    nullable: false,
    key: "",
    default: null,
    extra: "",
    referenced_table: null,
    referenced_column: null,
    comment: null,
    ...over,
  };
}

const orderCols: TableColumnInfo[] = [
  col({ name: "id", data_type: "int", key: "PRI", extra: "auto_increment" }),
  col({ name: "customer_id", data_type: "int", referenced_table: "customers", referenced_column: "id" }),
  col({ name: "product_name", default: "SECRET-DEFAULT", comment: "SECRET-COMMENT" }),
  col({ name: "unit_price", data_type: "decimal(10,2)" }),
  col({ name: "status", data_type: "enum('new','paid','shipped')" }),
  col({ name: "email", key: "UNI" }),
];

function setup(hints: Record<string, string> = {}) {
  const specs = orderCols.map(inferColumnSpec);
  const context = buildTestDataAiContext(orderCols, specs, hints);
  return { specs, context };
}

describe("buildTestDataAiContext / プロンプト (#698)", () => {
  it("自動採番と FK 列は生成対象に含めず、FK は参照として別に渡す", () => {
    const { context } = setup();
    expect(context.columns.map((c) => c.name)).toEqual(["product_name", "unit_price", "status", "email"]);
    expect(context.references).toEqual([{ column: "customer_id", table: "customers", refColumn: "id" }]);
    expect(context.columns.find((c) => c.name === "status")?.enumChoices).toEqual(["new", "paid", "shipped"]);
    expect(context.columns.find((c) => c.name === "email")?.unique).toBe(true);
  });

  it("プロンプトにデフォルト値・列コメントなどの実データは含まれず、スキーマと件数・ロケール・ヒントだけが入る", () => {
    const { context } = setup({ product_name: "文房具の名前" });
    const system = buildTestDataSystem({ driver: "mysql", table: "orders", rowCount: 200, locale: "ja", context });
    const prompt = buildTestDataPrompt("orders", 200);
    const all = `${system}\n${prompt}`;
    expect(all).not.toContain("SECRET-DEFAULT");
    expect(all).not.toContain("SECRET-COMMENT");
    expect(system).toContain("Table: orders");
    expect(system).toContain("- product_name: varchar(100) NOT NULL");
    expect(system).toContain("user hint: 文房具の名前");
    expect(system).toContain("about 200 rows");
    expect(system).toContain("Japanese");
    expect(system).toContain("customer_id -> customers.id");
    // 自動採番の id は生成対象として列挙しない。
    expect(system).not.toContain("- id:");
    expect(summarizeTestDataSend("orders", context, 200, "ja")).toEqual({
      table: "orders",
      columns: 4,
      foreignKeys: 1,
      rows: 200,
      locale: "ja",
    });
  });

  it("ヒントは 1 行に整形して長さを制限する", () => {
    const { context } = setup({ product_name: `a\nb  c${"x".repeat(500)}` });
    const hint = context.columns[0].hint;
    expect(hint.includes("\n")).toBe(false);
    expect(hint.length).toBeLessThanOrEqual(200);
  });

  it("構造化出力の形式は additionalProperties: false", () => {
    expect(TEST_DATA_FORMAT.schema.additionalProperties).toBe(false);
    expect(TEST_DATA_FORMAT.schema.properties.columns.items.additionalProperties).toBe(false);
    expect(TEST_DATA_FORMAT.schema.properties.consistency_rules.items.additionalProperties).toBe(false);
  });
});

describe("parseTestDataResponse", () => {
  const valid: TestDataAiResponse = { columns: [{ name: "a", kind: "choices", choices: ["x"], notes: "" }], consistency_rules: [] };
  it("JSON とコードフェンス付き JSON を受け付ける", () => {
    expect(parseTestDataResponse(JSON.stringify(valid))).toEqual({ ok: true, value: valid });
    expect(parseTestDataResponse("```json\n" + JSON.stringify(valid) + "\n```").ok).toBe(true);
  });
  it("壊れた JSON・形が違う応答は本文を返す", () => {
    expect(parseTestDataResponse("not json")).toEqual({ ok: false, raw: "not json" });
    expect(parseTestDataResponse(JSON.stringify({ columns: [{ name: "a", kind: "other" }] })).ok).toBe(false);
    expect(parseTestDataResponse(JSON.stringify({ columns: [] })).ok).toBe(false);
  });
});

const response: TestDataAiResponse = {
  columns: [
    { name: "product_name", kind: "choices", choices: ["ペン", "ノート", "消しゴム"], notes: "" },
    { name: "unit_price", kind: "choices", choices: ["120", "250", "80"], notes: "" },
    { name: "status", kind: "choices", choices: ["paid", "invalid-status", "shipped"], notes: "" },
    { name: "email", kind: "pattern", choices: ["user{n}@example.com", "member{n}@example.jp"], notes: "" },
    { name: "ghost", kind: "choices", choices: ["x"], notes: "" },
  ],
  consistency_rules: [{ columns: ["product_name", "unit_price"], description: "価格は商品に対応" }],
};

describe("buildTestDataPlan", () => {
  it("未知の列を捨て、ENUM の範囲外を除き、整合ルールをグループ化する", () => {
    const { context } = setup();
    const plan = buildTestDataPlan(response, context.columns);
    expect(Object.keys(plan.columns).sort()).toEqual(["email", "product_name", "status", "unit_price"]);
    expect(plan.columns.status.choices).toEqual(["paid", "shipped"]);
    expect(plan.groups).toEqual([["product_name", "unit_price"]]);
    expect(plan.warnings).toEqual([{ code: "unknownColumn", columns: ["ghost"] }]);
  });

  it("候補数の揃わない整合ルールは適用せず警告する", () => {
    const { context } = setup();
    const bad = {
      ...response,
      columns: response.columns.map((c) => (c.name === "unit_price" ? { ...c, choices: ["1", "2"] } : c)),
    };
    const plan = buildTestDataPlan(bad, context.columns);
    expect(plan.groups).toEqual([]);
    expect(plan.warnings.some((w) => w.code === "misaligned")).toBe(true);
  });

  it("数値列に数値でない候補だけが来たら使えない列として扱う", () => {
    const { context } = setup();
    const bad = {
      columns: [{ name: "unit_price", kind: "choices" as const, choices: ["高い", "安い"], notes: "" }],
      consistency_rules: [],
    };
    const plan = buildTestDataPlan(bad, context.columns);
    expect(plan.columns.unit_price).toBeUndefined();
    expect(plan.warnings).toEqual([{ code: "unusableChoices", columns: ["unit_price"] }]);
  });

  it(`候補は最大 ${TEST_DATA_MAX_CHOICES} 件に切り詰める`, () => {
    const { context } = setup();
    const many = {
      columns: [
        {
          name: "product_name",
          kind: "choices" as const,
          choices: Array.from({ length: 200 }, (_, i) => `p${i}`),
          notes: "",
        },
      ],
      consistency_rules: [],
    };
    expect(buildTestDataPlan(many, context.columns).columns.product_name.choices).toHaveLength(TEST_DATA_MAX_CHOICES);
  });
});

describe("generateAiDataset (#698)", () => {
  function build(count: number, seed: number) {
    const { specs, context } = setup();
    // customer_id は取得済みの親 PK から選ぶ (既存の buildFkSelectSql 経路と同じ)。
    const withFk = specs.map((s) => (s.column === "customer_id" ? { ...s, choices: [10, 20, 30] } : s));
    const plan = buildTestDataPlan(response, context.columns);
    return generateAiDataset(
      [{ table: "orders", specs: withFk, plan, uniqueColumns: uniqueColumnNames(orderCols), count }],
      seed,
    ).orders;
  }

  it("同じシードなら常に同じ行、違うシードなら変わる", () => {
    expect(build(50, 42)).toEqual(build(50, 42));
    expect(build(50, 42).rows).not.toEqual(build(50, 43).rows);
  });

  it("自動採番は含まず、候補由来の値・型変換・整合ルールが効く", () => {
    const { columns, rows } = build(100, 7);
    expect(columns).toEqual(["customer_id", "product_name", "unit_price", "status", "email"]);
    const pairs = new Set(rows.map((r) => `${r[1]}:${r[2]}`));
    for (const p of pairs) expect(["ペン:120", "ノート:250", "消しゴム:80"]).toContain(p);
    for (const r of rows) {
      expect(typeof r[2]).toBe("number");
      expect(["paid", "shipped"]).toContain(r[3]);
      expect([10, 20, 30]).toContain(r[0]);
    }
  });

  it("件数が候補数を超えても UNIQUE 列は一意になる (パターンの {n} と衝突時のサフィックス)", () => {
    const { rows } = build(500, 1);
    const emails = rows.map((r) => String(r[4]));
    expect(new Set(emails).size).toBe(500);
    expect(emails[0]).toMatch(/^(user|member)1@example\.(com|jp)$/);
  });

  it("候補が少ない UNIQUE 文字列列は連番サフィックスで一意化する", () => {
    const cols = [col({ name: "code", key: "UNI" })];
    const specs = cols.map(inferColumnSpec);
    const plan = buildTestDataPlan(
      { columns: [{ name: "code", kind: "choices", choices: ["A", "B", "C"], notes: "" }], consistency_rules: [] },
      buildTestDataAiContext(cols, specs, {}).columns,
    );
    const { rows } = generateAiDataset([{ table: "t", specs, plan, uniqueColumns: ["code"], count: 8 }], 3).t;
    const vals = rows.map((r) => String(r[0]));
    expect(new Set(vals).size).toBe(8);
    expect(vals.filter((v) => ["A", "B", "C"].includes(v))).toHaveLength(3);
  });

  it("計画の無い列はルールベースで生成する", () => {
    const { specs } = setup();
    const { rows } = generateAiDataset(
      [{ table: "orders", specs, plan: null, uniqueColumns: [], count: 5 }],
      9,
    ).orders;
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.length === 5)).toBe(true);
  });

  it("親も同時に生成する場合は親の生成値だけを子の FK に配る (参照が壊れない)", () => {
    const parentCols = [col({ name: "id", data_type: "int", key: "PRI" }), col({ name: "name" })];
    const childCols = [
      col({ name: "id", data_type: "int", key: "PRI", extra: "auto_increment" }),
      col({ name: "parent_id", data_type: "int", referenced_table: "parents", referenced_column: "id" }),
      col({ name: "title" }),
    ];
    const parentSpecs = parentCols.map(inferColumnSpec); // id: serial
    const childSpecs = childCols.map(inferColumnSpec); // parent_id: fkRef (候補なし)
    const plan = buildTestDataPlan(
      {
        columns: [{ name: "name", kind: "choices", choices: ["山田", "佐藤"], notes: "" }],
        consistency_rules: [],
      },
      buildTestDataAiContext(parentCols, parentSpecs, {}).columns,
    );
    // 子を先頭に渡しても、親 → 子の順で生成される。
    const out = generateAiDataset(
      [
        { table: "children", specs: childSpecs, plan: null, uniqueColumns: [], count: 30 },
        { table: "parents", specs: parentSpecs, plan, uniqueColumns: ["id"], count: 5 },
      ],
      11,
    );
    const parentIds = new Set(out.parents.rows.map((r) => r[0]));
    expect(parentIds.size).toBe(5);
    const fkIdx = out.children.columns.indexOf("parent_id");
    for (const r of out.children.rows) expect(parentIds.has(r[fkIdx])).toBe(true);
  });
});
