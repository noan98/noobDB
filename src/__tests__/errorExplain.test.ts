import { describe, expect, it } from "vitest";
import {
  buildErrorExplainPrompt,
  ERROR_EXPLAIN_FORMAT,
  extractTableRefs,
  parseErrorExplainResponse,
  sqlForAi,
} from "../ai/errorExplain";
import { DEFAULT_AI_SETTINGS } from "../ai/aiSettings";

const base = {
  errorKind: "db",
  message: "Unknown column 'nme' in 'field list'",
  sql: "SELECT nme FROM users WHERE email = 'secret@example.com'",
  driver: "mysql",
  tables: [],
  locale: "en" as const,
};

describe("リテラルマスク (#692)", () => {
  it("設定の既定はマスクオン", () => {
    expect(DEFAULT_AI_SETTINGS.maskLiterals).toBe(true);
  });

  it("マスク有効なら文字列リテラルとコメントがプロンプトに入らない", () => {
    const sql = "SELECT * FROM t WHERE a = 'secret' -- note: hunter2";
    const out = buildErrorExplainPrompt({ ...base, sql, maskLiterals: true });
    expect(out).not.toContain("secret");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("SELECT * FROM t WHERE a =");
  });

  it("マスク無効ならリテラルがそのまま入る", () => {
    const out = buildErrorExplainPrompt({ ...base, maskLiterals: false });
    expect(out).toContain("secret@example.com");
  });

  it("識別子は残し、SQL の長さは変えない", () => {
    const sql = "SELECT `nme` FROM `users` WHERE a = 'x'";
    const masked = sqlForAi(sql, "mysql", true);
    expect(masked).toContain("`nme`");
    expect(masked.length).toBe(sql.length);
  });
});

describe("テーブル名抽出", () => {
  it("FROM / JOIN / UPDATE / INSERT INTO / DELETE FROM を拾う", () => {
    expect(extractTableRefs("SELECT * FROM a JOIN b ON a.id = b.id", "mysql").map((r) => r.table)).toEqual([
      "a",
      "b",
    ]);
    expect(extractTableRefs("UPDATE t SET x = 1", "mysql")[0].table).toBe("t");
    expect(extractTableRefs("INSERT INTO t (a) VALUES (1)", "mysql")[0].table).toBe("t");
    expect(extractTableRefs("DELETE FROM t WHERE 1=1", "mysql")[0].table).toBe("t");
  });

  it("db.table と引用識別子を分解する", () => {
    expect(extractTableRefs("SELECT 1 FROM `shop`.`orders`", "mysql")).toEqual([
      { database: "shop", table: "orders" },
    ]);
    expect(extractTableRefs('SELECT 1 FROM "public"."users"', "postgres")).toEqual([
      { database: "public", table: "users" },
    ]);
  });

  it("リテラル・コメント内の FROM は無視し、重複と上限を処理する", () => {
    expect(extractTableRefs("SELECT 'x FROM fake' FROM real -- FROM nope", "mysql").map((r) => r.table)).toEqual([
      "real",
    ]);
    expect(extractTableRefs("SELECT * FROM a, (SELECT 1 FROM a)", "mysql")).toHaveLength(1);
    const many = Array.from({ length: 9 }, (_, i) => `JOIN t${i} ON 1=1`).join(" ");
    expect(extractTableRefs(`SELECT 1 FROM t ${many}`, "mysql")).toHaveLength(5);
  });

  it("見つからなければ空", () => {
    expect(extractTableRefs("SELECT 1", "sqlite")).toEqual([]);
  });
});

describe("プロンプト", () => {
  it("方言・エラー・テーブル定義を含み、行データは含まない", () => {
    const out = buildErrorExplainPrompt({
      ...base,
      maskLiterals: true,
      tables: [
        {
          name: "users",
          columns: [
            { name: "id", data_type: "int", nullable: false, key: "PRI", referenced_table: null, referenced_column: null },
          ],
        },
      ],
    });
    expect(out).toContain("Dialect: MySQL");
    expect(out).toContain("Unknown column");
    expect(out).toContain("users");
    expect(out).toContain("id int (key=PRI, not null)");
  });
});

describe("応答パース", () => {
  const ok = { explanation: "e", cause: "c", suggestedSql: "SELECT 1", notes: ["n"] };

  it("正しい JSON を受け付ける (コードフェンス付きも可)", () => {
    expect(parseErrorExplainResponse(JSON.stringify(ok))).toEqual({ ok: true, value: ok });
    expect(parseErrorExplainResponse("```json\n" + JSON.stringify(ok) + "\n```").ok).toBe(true);
  });

  it("suggestedSql が null / 空なら null", () => {
    const r = parseErrorExplainResponse(JSON.stringify({ ...ok, suggestedSql: "  " }));
    expect(r.ok && r.value.suggestedSql).toBeNull();
  });

  it("形が違う / JSON でないときは本文をそのまま返す", () => {
    expect(parseErrorExplainResponse("not json")).toEqual({ ok: false, raw: "not json" });
    const bad = JSON.stringify({ explanation: "e" });
    expect(parseErrorExplainResponse(bad)).toEqual({ ok: false, raw: bad });
  });

  it("スキーマは必須 4 項目で追加プロパティを許さない", () => {
    expect(ERROR_EXPLAIN_FORMAT.type).toBe("json_schema");
    expect(ERROR_EXPLAIN_FORMAT.schema.required).toEqual(["explanation", "cause", "suggestedSql", "notes"]);
    expect(ERROR_EXPLAIN_FORMAT.schema.additionalProperties).toBe(false);
  });
});
