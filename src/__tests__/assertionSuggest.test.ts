import { describe, expect, it } from "vitest";
import {
  ASSERTION_SUGGEST_MAX,
  buildAssertionSuggestPrompt,
  buildAssertionSuggestSystemParts,
  isRegistrableSuggestionSql,
  parseAssertionSuggestResponse,
  selectTableForeignKeys,
  suggestionToDraft,
  type AssertionSuggestInput,
} from "../ai/assertionSuggest";
import { draftToRequest } from "../components/assertions";

const input: AssertionSuggestInput = {
  driver: "postgres",
  database: "app",
  table: "orders",
  locale: "ja",
  columns: [
    { name: "id", data_type: "bigint", nullable: false, key: "PRI", referenced_table: null, referenced_column: null },
    {
      name: "email",
      data_type: "text",
      nullable: true,
      key: "",
      default: "'x'",
      referenced_table: null,
      referenced_column: null,
      comment: "連絡先\nメール",
    },
    { name: "user_id", data_type: "int", nullable: true, key: "MUL", referenced_table: "users", referenced_column: "id" },
  ],
  foreignKeys: [{ table: "orders", column: "user_id", referenced_table: "users", referenced_column: "id" }],
};

describe("buildAssertionSuggestSystemParts (#1477)", () => {
  it("方言名・違反行を返す仕様・列定義・外部キーを固定部分に入れる", () => {
    const { cached, variable } = buildAssertionSuggestSystemParts(input);
    expect(cached).toContain("PostgreSQL");
    expect(cached).toContain("returns the VIOLATING rows");
    expect(cached).toContain("0 rows");
    expect(cached).toContain("read-only");
    expect(cached).toContain("- id bigint | NOT NULL | key=PRI");
    expect(cached).toContain("email text | NULL");
    expect(cached).toContain("comment: 連絡先 メール");
    expect(cached).toContain("FK->users.id");
    expect(cached).toContain("orders.user_id -> users.id");
    expect(cached).toContain("Japanese");
    expect(variable).toBe("Database: app");
  });

  it("3 ドライバそれぞれの方言名が入る", () => {
    for (const [driver, label] of [
      ["mysql", "MySQL"],
      ["postgres", "PostgreSQL"],
      ["sqlite", "SQLite"],
    ] as const) {
      expect(buildAssertionSuggestSystemParts({ ...input, driver }).cached).toContain(`Target dialect: ${label}`);
    }
  });

  it("行データを持つ入力型ではなく、プロンプトにテーブル名だけが入る", () => {
    expect(buildAssertionSuggestPrompt("orders")).toContain('"orders"');
  });
});

describe("プロンプトの注意書き", () => {
  it("結合時の列名重複と SQLite の REGEXP を指示する", () => {
    expect(buildAssertionSuggestSystemParts(input).cached).toContain("never use SELECT *");
    expect(buildAssertionSuggestSystemParts(input).cached).not.toContain("REGEXP");
    expect(buildAssertionSuggestSystemParts({ ...input, driver: "sqlite" }).cached).toContain("REGEXP");
  });
});

describe("selectTableForeignKeys", () => {
  it("対象テーブルが参照する / される外部キーだけに絞る (大文字小文字無視)", () => {
    const fks = [
      { table: "orders", column: "user_id", referenced_table: "users", referenced_column: "id" },
      { table: "items", column: "order_id", referenced_table: "orders", referenced_column: "id" },
      { table: "a", column: "b", referenced_table: "c", referenced_column: "d" },
    ];
    expect(selectTableForeignKeys(fks, "ORDERS").map((f) => f.table)).toEqual(["orders", "items"]);
  });
});

describe("parseAssertionSuggestResponse", () => {
  const body = {
    suggestions: [
      { name: "メール形式", description: "説明", sql: " SELECT * FROM t WHERE email NOT LIKE '%@%' " },
      { name: "", description: "名前なし", sql: "SELECT 1" },
      { name: "空", description: "SQL なし", sql: "  " },
    ],
  };

  it("JSON を解釈し、SQL が空の候補を捨て、空の名前を補う", () => {
    const r = parseAssertionSuggestResponse(JSON.stringify(body));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.suggestions).toHaveLength(2);
    expect(r.suggestions[0].sql).toBe("SELECT * FROM t WHERE email NOT LIKE '%@%'");
    expect(r.suggestions[1].name).toBe("check_2");
  });

  it("コードフェンスで囲まれていても受け付ける", () => {
    const r = parseAssertionSuggestResponse("```json\n" + JSON.stringify(body) + "\n```");
    expect(r.ok).toBe(true);
  });

  it("上限を超える候補は切る", () => {
    const many = {
      suggestions: Array.from({ length: ASSERTION_SUGGEST_MAX + 5 }, (_, i) => ({
        name: `n${i}`,
        description: "",
        sql: "SELECT 1",
      })),
    };
    const r = parseAssertionSuggestResponse(JSON.stringify(many));
    expect(r.ok && r.suggestions.length).toBe(ASSERTION_SUGGEST_MAX);
  });

  it("JSON でない / 形が違うときは生の本文を返す", () => {
    expect(parseAssertionSuggestResponse("nope")).toEqual({ ok: false, raw: "nope" });
    expect(parseAssertionSuggestResponse('{"suggestions":[{"name":1}]}').ok).toBe(false);
  });
});

describe("isRegistrableSuggestionSql (読み取り専用でない候補は登録できない)", () => {
  it.each([
    ["SELECT * FROM t WHERE a < 0", true],
    ["WITH x AS (SELECT 1) SELECT * FROM x", true],
    ["SELECT * FROM t;", true],
    ["SHOW TABLES", false],
    ["EXPLAIN SELECT 1", false],
    ["TABLE t", false],
    ["DELETE FROM t", false],
    ["UPDATE t SET a = 1", false],
    ["DROP TABLE t", false],
    ["SELECT 1; DELETE FROM t", false],
    ["SELECT * FROM t FOR UPDATE", false],
    ["INSERT INTO t VALUES (1)", false],
    ["", false],
    ["   ", false],
  ])("%s -> %s", (sql, expected) => {
    for (const driver of ["mysql", "postgres", "sqlite"]) {
      expect(isRegistrableSuggestionSql(sql, driver)).toBe(expected);
    }
  });
});

describe("suggestionToDraft", () => {
  it("既存のアサーションと同じ保存リクエスト (custom_sql) になる", () => {
    const d = suggestionToDraft({ name: "n", sql: "SELECT * FROM orders WHERE amount < 0" }, "orders", null);
    const r = draftToRequest(d, { id: "p1", group: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.req).toMatchObject({
      name: "n",
      table: "orders",
      schema: null,
      scope: { kind: "profile", profile_id: "p1" },
      rule: { kind: "custom_sql", sql: "SELECT * FROM orders WHERE amount < 0" },
    });
  });
});
