import { describe, expect, it } from "vitest";
import {
  buildImpactAnalysisPrompt,
  buildImpactAnalysisSystem,
  findingTableRef,
  IMPACT_ANALYSIS_FORMAT,
  IMPACT_MAX_FOREIGN_KEYS,
  impactTableRefs,
  parseImpactAnalysisResponse,
  riskTone,
  selectRelatedForeignKeys,
  type ImpactAnalysisInput,
} from "../ai/impactAnalysis";

const base: ImpactAnalysisInput = {
  driver: "mysql",
  sql: "UPDATE orders SET status = 'secret-value' WHERE customer_id = 7",
  findings: [{ kind: "updateNoWhere", target: "orders" }],
  tables: [
    {
      name: "orders",
      estimatedRows: 12000,
      columns: [
        { name: "id", data_type: "int", nullable: false, key: "PRI", referenced_table: null, referenced_column: null },
        { name: "customer_id", data_type: "int", nullable: false, key: "MUL", referenced_table: "customers", referenced_column: "id" },
      ],
    },
  ],
  foreignKeys: [
    { table: "order_items", column: "order_id", referenced_table: "orders", referenced_column: "id", constraint_name: "fk_items_order" },
  ],
  preflight: { verb: "update", count: 3, allRows: false },
  isProduction: true,
  maskLiterals: true,
  locale: "ja",
};

describe("AI 影響分析の応答形式 (#694)", () => {
  it("全オブジェクトが additionalProperties: false で required を網羅する", () => {
    const check = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const n = node as Record<string, unknown>;
      if (n.type === "object") {
        expect(n.additionalProperties).toBe(false);
        expect([...(n.required as string[])].sort()).toEqual(Object.keys(n.properties as object).sort());
      }
      for (const v of Object.values(n)) check(v);
    };
    check(IMPACT_ANALYSIS_FORMAT.schema);
    expect(IMPACT_ANALYSIS_FORMAT.type).toBe("json_schema");
  });

  it("正しい JSON をパースし、コードフェンスも受け付ける", () => {
    const body = JSON.stringify({
      summary: "S",
      affected_tables: [{ table: "orders", estimated_rows: "~12,000", reason: "R" }],
      cascades: [{ from: "orders", to: "order_items", via: "fk" }],
      risk: "high",
      recommendations: ["backup"],
    });
    const r = parseImpactAnalysisResponse(body);
    expect(r.ok && r.value.risk).toBe("high");
    expect(parseImpactAnalysisResponse("```json\n" + body + "\n```").ok).toBe(true);
  });

  it("形が違う / JSON でない / risk が範囲外なら本文をそのまま返す", () => {
    expect(parseImpactAnalysisResponse("plain")).toEqual({ ok: false, raw: "plain" });
    const bad = JSON.stringify({ summary: "S", affected_tables: [], cascades: [], risk: "extreme", recommendations: [] });
    expect(parseImpactAnalysisResponse(bad)).toEqual({ ok: false, raw: bad });
  });

  it("リスクは意味色の役割に対応する", () => {
    expect(riskTone("high")).toBe("danger");
    expect(riskTone("medium")).toBe("warning");
    expect(riskTone("low")).toBe("success");
  });
});

describe("対象テーブルと関連 FK (#694)", () => {
  it("検出結果の対象 (クォート・db 修飾) をテーブル参照にする", () => {
    expect(findingTableRef({ kind: "drop", target: "`app`.`users`" })).toEqual({ database: "app", table: "users" });
    expect(findingTableRef({ kind: "truncate", target: "orders" })).toEqual({ database: null, table: "orders" });
    expect(findingTableRef({ kind: "drop", target: null })).toBeNull();
  });

  it("DROP / TRUNCATE の対象も SQL 内のテーブルも重複なしで拾う", () => {
    const refs = impactTableRefs(
      "TRUNCATE TABLE orders",
      [{ kind: "truncate", target: "orders" }],
      "mysql",
    );
    expect(refs).toEqual([{ database: null, table: "orders" }]);
    const upd = impactTableRefs("UPDATE a JOIN b ON a.id=b.id SET a.x=1", [{ kind: "updateNoWhere", target: "a" }], "mysql");
    expect(upd.map((r) => r.table)).toEqual(["a", "b"]);
  });

  it("対象テーブルを参照する / される FK だけを大文字小文字無視で残し、上限で切る", () => {
    const fk = (table: string, parent: string) => ({
      table, column: "c", referenced_table: parent, referenced_column: "id", constraint_name: null,
    });
    const out = selectRelatedForeignKeys(
      [fk("Order_Items", "orders"), fk("orders", "customers"), fk("x", "y")],
      ["ORDERS"],
    );
    expect(out.map((f) => f.table)).toEqual(["Order_Items", "orders"]);
    const many = Array.from({ length: 100 }, () => fk("orders", "customers"));
    expect(selectRelatedForeignKeys(many, ["orders"])).toHaveLength(IMPACT_MAX_FOREIGN_KEYS);
  });
});

describe("プロンプト (#694)", () => {
  it("方言・検出理由・プリフライト件数・テーブル・FK・行数推定を含む", () => {
    const p = buildImpactAnalysisPrompt(base);
    expect(p).toContain("Dialect: MySQL");
    expect(p).toContain("UPDATE without WHERE on orders");
    expect(p).toContain("estimated affected rows: 3");
    expect(p).toContain("orders (estimated rows: 12000)");
    expect(p).toContain("customer_id int (key=MUL, not null, -> customers.id)");
    expect(p).toContain("order_items.order_id -> orders.id [fk_items_order]");
    expect(p).toContain("Production connection: yes");
  });

  it("マスク有効ならリテラルを送らず、無効ならそのまま送る", () => {
    expect(buildImpactAnalysisPrompt(base)).not.toContain("secret-value");
    expect(buildImpactAnalysisPrompt({ ...base, maskLiterals: false })).toContain("secret-value");
  });

  it("行データ・セル値に相当するフィールドは入力に混ざっても出力されない", () => {
    const tainted = {
      ...base,
      tables: [
        {
          ...base.tables[0],
          rows: [["ROW_DATA_SENTINEL"]],
          columns: [{ ...base.tables[0].columns[0], default: "DEFAULT_SENTINEL", comment: "COMMENT_SENTINEL" }],
        },
      ],
    } as unknown as ImpactAnalysisInput;
    const p = buildImpactAnalysisPrompt(tainted);
    for (const s of ["ROW_DATA_SENTINEL", "DEFAULT_SENTINEL", "COMMENT_SENTINEL"]) expect(p).not.toContain(s);
  });

  it("システムプロンプトは出力言語を切り替える", () => {
    expect(buildImpactAnalysisSystem("ja")).toContain("Japanese");
    expect(buildImpactAnalysisSystem("en")).toContain("English");
  });
});
