import { describe, expect, it } from "vitest";
import type { TableColumnInfo } from "../api/tauri";
import { inferColumnSpec } from "../components/testDataGen";
import {
  buildTestDataAiContext,
  buildTestDataPlan,
  buildTestDataPrompt,
  buildTestDataSystem,
  generateAiRows,
  isValidTemporal,
  resolveUniqueColumns,
  parseTestDataResponse,
  summarizeTestDataSend,
  TEST_DATA_FORMAT,
  TEST_DATA_MAX_CHOICES,
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
  const context = buildTestDataAiContext(orderCols, specs, hints, resolveUniqueColumns(orderCols, []).columns);
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

describe("generateAiRows (#698)", () => {
  function build(count: number, seed: number) {
    const { specs, context } = setup();
    // customer_id は取得済みの親 PK から選ぶ (既存の buildFkSelectSql 経路と同じ)。
    const withFk = specs.map((s) => (s.column === "customer_id" ? { ...s, choices: [10, 20, 30] } : s));
    const plan = buildTestDataPlan(response, context.columns);
    return generateAiRows(
      { specs: withFk, plan, uniqueColumns: resolveUniqueColumns(orderCols, []).columns, count },
      seed,
    );
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
    expect(emails[0]).toMatch(/^(user|member)\d+@example\.(com|jp)$/);
  });

  it("候補が少ない UNIQUE 文字列列は連番サフィックスで一意化する", () => {
    const cols = [col({ name: "code", key: "UNI" })];
    const specs = cols.map(inferColumnSpec);
    const plan = buildTestDataPlan(
      { columns: [{ name: "code", kind: "choices", choices: ["A", "B", "C"], notes: "" }], consistency_rules: [] },
      buildTestDataAiContext(cols, specs, {}, ["code"]).columns,
    );
    const { rows } = generateAiRows({ specs, plan, uniqueColumns: ["code"], count: 8 }, 3);
    const vals = rows.map((r) => String(r[0]));
    expect(new Set(vals).size).toBe(8);
    expect(vals.filter((v) => ["A", "B", "C"].includes(v))).toHaveLength(3);
  });

  it("計画の無い列はルールベースで生成する", () => {
    const { specs } = setup();
    const { rows } = generateAiRows({ specs, plan: null, uniqueColumns: [], count: 5 }, 9);
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.length === 5)).toBe(true);
  });

  it("UNIQUE 文字列は宣言長を超えず、メールは @ の前にサフィックスが入り、大小違いも衝突とみなす", () => {
    const cols = [col({ name: "email", data_type: "varchar(20)", key: "UNI" })];
    const specs = cols.map(inferColumnSpec);
    const plan = buildTestDataPlan(
      { columns: [{ name: "email", kind: "choices", choices: ["Taro@ex.com", "taro@ex.com"], notes: "" }], consistency_rules: [] },
      buildTestDataAiContext(cols, specs, {}, ["email"]).columns,
    );
    const { rows } = generateAiRows({ specs, plan, uniqueColumns: ["email"], count: 30 }, 5);
    const vals = rows.map((r) => String(r[0]));
    expect(new Set(vals.map((v) => v.toLowerCase())).size).toBe(30);
    for (const v of vals) {
      expect(v.length).toBeLessThanOrEqual(20);
      expect(v.endsWith("@ex.com")).toBe(true);
    }
  });

  it("{n} の開始値はシードで変わるが、同じシードなら同じ", () => {
    const cols = [col({ name: "code", key: "UNI" })];
    const specs = cols.map(inferColumnSpec);
    const plan = buildTestDataPlan(
      { columns: [{ name: "code", kind: "pattern", choices: ["C{n}"], notes: "" }], consistency_rules: [] },
      buildTestDataAiContext(cols, specs, {}, ["code"]).columns,
    );
    const gen = (seed: number) => generateAiRows({ specs, plan, uniqueColumns: ["code"], count: 3 }, seed).rows;
    expect(gen(1)).toEqual(gen(1));
    expect(gen(1)).not.toEqual(gen(2));
  });
});

describe("候補の検証 (#698 レビュー)", () => {
  const cols = [
    col({ name: "product_name", data_type: "varchar(5)" }),
    col({ name: "unit_price", data_type: "int" }),
    col({ name: "qty", data_type: "int" }),
    col({ name: "created", data_type: "datetime" }),
    col({ name: "birth", data_type: "date" }),
    col({ name: "at", data_type: "time" }),
    col({ name: "note", data_type: "varchar(10)" }),
  ];
  const ctx = () => buildTestDataAiContext(cols, cols.map(inferColumnSpec), {}, []).columns;

  it("整合ルールの列は除外後に添字がずれない (空要素・不正値の行は全列から落ちる)", () => {
    const plan = buildTestDataPlan(
      {
        columns: [
          { name: "product_name", kind: "choices", choices: ["A", "", "C"], notes: "" },
          { name: "unit_price", kind: "choices", choices: ["1", "2", "x"], notes: "" },
        ],
        consistency_rules: [{ columns: ["product_name", "unit_price"], description: "対応" }],
      },
      ctx(),
    );
    // 添字 0 だけが両列で有効。A:1 のみで、C:2 のような誤った組は作らない。
    expect(plan.columns.product_name.choices).toEqual(["A"]);
    expect(plan.columns.unit_price.choices).toEqual(["1"]);
    expect(plan.groups).toEqual([["product_name", "unit_price"]]);
  });

  it("整合ルールで加工前の個数が揃わなければ、除外後に揃っても適用しない", () => {
    const plan = buildTestDataPlan(
      {
        columns: [
          { name: "product_name", kind: "choices", choices: ["A", "B", ""], notes: "" },
          { name: "unit_price", kind: "choices", choices: ["1", "2"], notes: "" },
        ],
        consistency_rules: [{ columns: ["product_name", "unit_price"], description: "対応" }],
      },
      ctx(),
    );
    expect(plan.groups).toEqual([]);
    expect(plan.warnings.some((w) => w.code === "misaligned")).toBe(true);
  });

  it("整数列は小数・非数を除き、文字列は宣言長超過と NULL を除く", () => {
    const plan = buildTestDataPlan(
      {
        columns: [
          { name: "qty", kind: "choices", choices: ["1", "2.5", "1e3", "abc", "-3"], notes: "" },
          { name: "product_name", kind: "choices", choices: ["12345", "123456", "null", "NULL"], notes: "" },
        ],
        consistency_rules: [],
      },
      ctx(),
    );
    expect(plan.columns.qty.choices).toEqual(["1", "-3"]);
    expect(plan.columns.product_name.choices).toEqual(["12345"]);
  });

  it("日時列は書式と実在を検証し、pattern は許可しない", () => {
    const plan = buildTestDataPlan(
      {
        columns: [
          { name: "created", kind: "choices", choices: ["2024-02-29 10:00:00", "2023-02-29 10:00:00", "2024-01-01", "2024-01-01 24:00:00"], notes: "" },
          { name: "birth", kind: "choices", choices: ["2024-13-01", "1999-12-31", "2024-1-1"], notes: "" },
          { name: "at", kind: "pattern", choices: ["10:{n}:00"], notes: "" },
        ],
        consistency_rules: [],
      },
      ctx(),
    );
    expect(plan.columns.created.choices).toEqual(["2024-02-29 10:00:00"]);
    expect(plan.columns.birth.choices).toEqual(["1999-12-31"]);
    expect(plan.columns.at).toBeUndefined();
    expect(isValidTemporal("23:59:59", "time")).toBe(true);
    expect(isValidTemporal("23:60:00", "time")).toBe(false);
  });

  it("pattern は {n} 展開後の長さが宣言長を超えるものを除く", () => {
    const plan = buildTestDataPlan(
      { columns: [{ name: "note", kind: "pattern", choices: ["a{n}", "abcdefg{n}"], notes: "" }], consistency_rules: [] },
      ctx(),
    );
    expect(plan.columns.note.choices).toEqual(["a{n}"]);
  });
});

describe("resolveUniqueColumns (#698 レビュー)", () => {
  it("PostgreSQL / SQLite の単一列 UNIQUE index を拾い、複合は composite に分ける", () => {
    const cs = [col({ name: "id", key: "PRI" }), col({ name: "email" }), col({ name: "a" }), col({ name: "b" })];
    const r = resolveUniqueColumns(cs, [
      { columns: ["email"], unique: true, primary: false },
      { columns: ["a", "b"], unique: true, primary: false },
      { columns: ["b"], unique: false, primary: false },
    ]);
    expect(r.columns).toEqual(["id", "email"]);
    expect(r.composite).toEqual([["a", "b"]]);
  });
});
