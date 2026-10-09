import { describe, expect, it } from "vitest";
import {
  buildExplainInterpretPrompt,
  buildExplainInterpretSystem,
  EXPLAIN_INTERPRET_FORMAT,
  EXPLAIN_INTERPRET_MAX_PLAN_CHARS,
  explainFormatLabel,
  maskPlanLiterals,
  parseExplainInterpretResponse,
  planForAi,
  type ExplainInterpretInput,
} from "../ai/explainInterpret";

const base: ExplainInterpretInput = {
  driver: "mysql",
  plan: '{"query_block":{"table":{"access_type":"ALL","attached_condition":"(`u`.`name` = \'alice\')"}}}',
  analyze: false,
  sql: "SELECT * FROM users WHERE name = 'alice'",
  tables: [
    {
      name: "users",
      rowEstimate: 1200,
      indexes: [{ name: "PRIMARY", columns: ["id"], unique: true, primary: true, method: "BTREE" }],
    },
  ],
  maskLiterals: true,
};

describe("explainFormatLabel (3 方言の EXPLAIN 形式)", () => {
  it("MySQL は FORMAT=JSON / 実測は EXPLAIN ANALYZE のテキストツリー", () => {
    expect(explainFormatLabel("mysql", false)).toContain("EXPLAIN FORMAT=JSON");
    expect(explainFormatLabel("mysql", true)).toContain("EXPLAIN ANALYZE text tree");
  });
  it("PostgreSQL は JSON / 実測は ANALYZE, BUFFERS", () => {
    expect(explainFormatLabel("postgres", false)).toContain("PostgreSQL EXPLAIN (FORMAT JSON)");
    expect(explainFormatLabel("postgres", true)).toContain("ANALYZE, BUFFERS");
  });
  it("SQLite は EXPLAIN QUERY PLAN", () => {
    expect(explainFormatLabel("sqlite", false)).toContain("EXPLAIN QUERY PLAN");
  });
});

describe("buildExplainInterpretPrompt", () => {
  it("方言ごとに形式の説明が入る", () => {
    for (const [driver, label, needle] of [
      ["mysql", "MySQL", "EXPLAIN FORMAT=JSON"],
      ["postgres", "PostgreSQL", "FORMAT JSON"],
      ["sqlite", "SQLite", "EXPLAIN QUERY PLAN"],
    ] as const) {
      const p = buildExplainInterpretPrompt({ ...base, driver });
      expect(p).toContain(`Dialect: ${label}`);
      expect(p).toContain(needle);
    }
  });

  it("マスク有効なら SQL と計画のリテラルを送らない", () => {
    const p = buildExplainInterpretPrompt(base);
    expect(p).not.toContain("alice");
    expect(p).toContain("SELECT * FROM users");
  });

  it("マスク無効ならそのまま送る", () => {
    const p = buildExplainInterpretPrompt({ ...base, maskLiterals: false });
    expect(p).toContain("alice");
  });

  it("テーブルのインデックスと行数推定を載せ、無ければ省く", () => {
    const p = buildExplainInterpretPrompt(base);
    expect(p).toContain("- users (estimated rows: 1200)");
    expect(p).toContain("index PRIMARY (id) [primary, unique, BTREE]");
    const none = buildExplainInterpretPrompt({
      ...base,
      tables: [{ name: "t", rowEstimate: null, indexes: [] }],
    });
    expect(none).toContain("estimated rows: unknown");
    expect(none).toContain("indexes: none");
    expect(buildExplainInterpretPrompt({ ...base, tables: [] })).not.toContain("Tables referenced");
  });
});

describe("planForAi / maskPlanLiterals", () => {
  it("単引用符リテラルの中身を空にする", () => {
    expect(maskPlanLiterals("Filter: (name = 'a''b') AND (x = 'c')")).toBe("Filter: (name = '') AND (x = '')");
  });
  it("上限を超えたら切り詰める", () => {
    const out = planForAi("x".repeat(EXPLAIN_INTERPRET_MAX_PLAN_CHARS + 10), false);
    expect(out.endsWith("(truncated)")).toBe(true);
    expect(out.length).toBeLessThan(EXPLAIN_INTERPRET_MAX_PLAN_CHARS + 30);
  });
});

describe("buildExplainInterpretSystem", () => {
  it("言語と方言を指示する", () => {
    expect(buildExplainInterpretSystem("ja", "postgres")).toContain("Japanese");
    expect(buildExplainInterpretSystem("en", "sqlite")).toContain("English");
    expect(buildExplainInterpretSystem("en", "sqlite")).toContain("SQLite");
  });
});

describe("EXPLAIN_INTERPRET_FORMAT", () => {
  it("全オブジェクトが additionalProperties: false", () => {
    const s = EXPLAIN_INTERPRET_FORMAT.schema;
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.bottlenecks.items.additionalProperties).toBe(false);
    expect(s.properties.suggestions.items.additionalProperties).toBe(false);
    expect(s.properties.bottlenecks.items.properties.severity.enum).toEqual(["high", "medium", "low"]);
  });
});

describe("parseExplainInterpretResponse", () => {
  const ok = {
    summary: "S",
    bottlenecks: [{ node: "users", reason: "full scan", severity: "high" }],
    suggestions: [
      { kind: "ddl", sql: " CREATE INDEX i ON users(name) ", rationale: "R" },
      { kind: "rewrite", sql: "   ", rationale: "empty" },
    ],
  };
  it("妥当な JSON を受け付け、空 SQL の提案は落とす", () => {
    const r = parseExplainInterpretResponse(JSON.stringify(ok));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.suggestions).toHaveLength(1);
      expect(r.value.suggestions[0].sql).toBe("CREATE INDEX i ON users(name)");
    }
  });
  it("コードフェンス付きも受け付ける", () => {
    expect(parseExplainInterpretResponse("```json\n" + JSON.stringify(ok) + "\n```").ok).toBe(true);
  });
  it("不正な severity / kind / JSON でない本文は raw を返す", () => {
    const bad = { ...ok, bottlenecks: [{ node: "n", reason: "r", severity: "critical" }] };
    expect(parseExplainInterpretResponse(JSON.stringify(bad))).toEqual({ ok: false, raw: JSON.stringify(bad) });
    const bad2 = { ...ok, suggestions: [{ kind: "drop", sql: "x", rationale: "r" }] };
    expect(parseExplainInterpretResponse(JSON.stringify(bad2)).ok).toBe(false);
    expect(parseExplainInterpretResponse("plain")).toEqual({ ok: false, raw: "plain" });
  });
});
