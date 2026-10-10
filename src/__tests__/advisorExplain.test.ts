import { describe, expect, it } from "vitest";
import type { HealthFinding } from "../api/tauri";
import {
  ADVISOR_EXPLAIN_FORMAT,
  advisorRelatedTables,
  buildAdvisorExplainPrompt,
  buildAdvisorExplainSystem,
  parseAdvisorExplainResponse,
  verdictTone,
} from "../ai/advisorExplain";

const finding = (over: Partial<HealthFinding> = {}): HealthFinding => ({
  rule: "unused_index",
  severity: "low",
  table: "orders",
  columns: ["note"],
  context: ["idx_note"],
  fix_ddl: "DROP INDEX idx_note ON orders;",
  statistical: true,
  ...over,
});

const valid = {
  why: "W",
  consequence: "C",
  fix_verdict: "caution",
  fix_advice: "A",
  cautions: ["x"],
};

describe("advisorRelatedTables", () => {
  it("対象テーブルだけ (FK 以外のルール)", () => {
    expect(advisorRelatedTables(finding())).toEqual(["orders"]);
  });
  it("fk_missing_index は参照先を足す。大文字小文字違いの重複は足さない", () => {
    const f = finding({ rule: "fk_missing_index", context: ["customers"] });
    expect(advisorRelatedTables(f)).toEqual(["orders", "customers"]);
    expect(advisorRelatedTables(finding({ rule: "fk_missing_index", context: ["ORDERS"] }))).toEqual(["orders"]);
  });
  it("fk_type_mismatch は context[1] の table.列 からテーブルを取る", () => {
    const f = finding({ rule: "fk_type_mismatch", context: ["bigint", "users.id", "int"] });
    expect(advisorRelatedTables(f)).toEqual(["orders", "users"]);
  });
});

describe("buildAdvisorExplainPrompt", () => {
  const input = {
    driver: "postgres",
    finding: finding(),
    tables: [
      {
        name: "orders",
        columns: [
          { name: "id", data_type: "int", nullable: false, key: "PRI", referenced_table: null, referenced_column: null },
        ],
        indexes: [{ name: "idx_note", columns: ["note"], unique: false, primary: false }],
      },
    ],
    maskLiterals: true,
  };

  it("指摘・修正 DDL・列とインデックス定義を含む", () => {
    const p = buildAdvisorExplainPrompt(input);
    expect(p).toContain("Dialect: PostgreSQL");
    expect(p).toContain("- rule: unused_index");
    expect(p).toContain("statistics-based: yes");
    expect(p).toContain("DROP INDEX idx_note ON orders;");
    expect(p).toContain("id int (key=PRI, not null)");
    expect(p).toContain("index idx_note (note)");
  });
  it("リテラルのマスクが有効なら修正 DDL のリテラルを送らない", () => {
    const f = finding({ fix_ddl: "CREATE INDEX i ON t (a) WHERE b = 'top-secret';" });
    expect(buildAdvisorExplainPrompt({ ...input, finding: f })).not.toContain("top-secret");
    expect(buildAdvisorExplainPrompt({ ...input, finding: f, maskLiterals: false })).toContain("top-secret");
  });
  it("修正 DDL が無い指摘はその旨を書く", () => {
    const p = buildAdvisorExplainPrompt({ ...input, finding: finding({ fix_ddl: null }) });
    expect(p).toContain("Proposed fix SQL: none");
  });
});

describe("system / format / parse", () => {
  it("回答言語をロケールに合わせ、統計依存の注意を含む", () => {
    expect(buildAdvisorExplainSystem("ja")).toContain("Japanese");
    expect(buildAdvisorExplainSystem("en")).toContain("English");
    expect(buildAdvisorExplainSystem("en")).toContain("statistics");
  });
  it("format は json_schema で全キー必須", () => {
    expect(ADVISOR_EXPLAIN_FORMAT.type).toBe("json_schema");
    expect(ADVISOR_EXPLAIN_FORMAT.schema.required).toEqual(
      Object.keys(ADVISOR_EXPLAIN_FORMAT.schema.properties),
    );
  });
  it("正しい JSON / コードフェンス付きをパースする", () => {
    expect(parseAdvisorExplainResponse(JSON.stringify(valid))).toEqual({ ok: true, value: valid });
    expect(parseAdvisorExplainResponse("```json\n" + JSON.stringify(valid) + "\n```").ok).toBe(true);
  });
  it("不正な形・JSON でない本文は raw を返す", () => {
    expect(parseAdvisorExplainResponse("plain")).toEqual({ ok: false, raw: "plain" });
    expect(parseAdvisorExplainResponse(JSON.stringify({ ...valid, fix_verdict: "maybe" })).ok).toBe(false);
  });
  it("判定の意味色", () => {
    expect(verdictTone("safe")).toBe("success");
    expect(verdictTone("caution")).toBe("warning");
    expect(verdictTone("avoid")).toBe("danger");
    expect(verdictTone("no_fix")).toBe("info");
  });
});
