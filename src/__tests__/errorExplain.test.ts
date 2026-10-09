import { describe, expect, it } from "vitest";
import {
  buildErrorExplainPrompt,
  ERROR_EXPLAIN_FORMAT,
  extractTableRefs,
  parseErrorExplainResponse,
  sqlForAi,
} from "../ai/errorExplain";
import { DEFAULT_AI_SETTINGS } from "../ai/aiSettings";
import {
  findSqlRange,
  maskErrorMessage,
  needsSendScopeConfirm,
  resolveTableDatabase,
  sqlForRangeReplace,
} from "../ai/errorExplain";

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


describe("エラー文のマスク (#692)", () => {
  it("SQL のリテラルと一致する部分を伏せ、識別子は残す", () => {
    const sql = "SELECT nme FROM users WHERE email = 'secret@example.com'";
    const out = maskErrorMessage("Unknown column 'nme'; bad value secret@example.com", sql);
    expect(out).toContain("'nme'");
    expect(out).not.toContain("secret@example.com");
  });

  it("既知パターンの値部分を伏せる", () => {
    expect(maskErrorMessage("Duplicate entry 'bob@x.com' for key 'users.email'", "")).toBe(
      "Duplicate entry '…' for key 'users.email'",
    );
    expect(maskErrorMessage("Incorrect integer value: 'abc' for column 'n' at row 1", "")).toBe(
      "Incorrect integer value: '…' for column 'n' at row 1",
    );
    expect(maskErrorMessage("Key (email)=(bob@x.com) already exists.", "")).toBe(
      "Key (email)=(…) already exists.",
    );
    expect(maskErrorMessage("null value ... Failing row contains (1, bob, null).", "")).toBe(
      "null value ... Failing row contains (…).",
    );
  });

  it("プロンプトはマスク有効のときだけエラー文を伏せる", () => {
    const m = "Duplicate entry 'bob' for key 'k'";
    const on = buildErrorExplainPrompt({ ...base, message: m, maskLiterals: true });
    const off = buildErrorExplainPrompt({ ...base, message: m, maskLiterals: false });
    expect(on).not.toContain("'bob'");
    expect(off).toContain("'bob'");
  });
});

describe("失敗した SQL の範囲検索 / 送信範囲 / テーブル抽出の補強 (#692)", () => {
  it("ちょうど 1 箇所のときだけ範囲を返す", () => {
    const text = "SELECT 1;\nSELECT nme FROM users;\nSELECT 2;";
    const r = findSqlRange(text, "SELECT nme FROM users;");
    expect(r && text.slice(r.from, r.to)).toBe("SELECT nme FROM users");
    expect(findSqlRange("SELECT 1; SELECT 1;", "SELECT 1")).toBeNull();
    expect(findSqlRange("SELECT 2", "SELECT 1")).toBeNull();
    expect(findSqlRange("x", "  ")).toBeNull();
  });

  it("schemaOnly のときだけ毎回確認が要る", () => {
    expect(needsSendScopeConfirm("schemaOnly")).toBe(true);
    expect(needsSendScopeConfirm("schemaAndSql")).toBe(false);
  });

  it("SQLite は DB 未指定なら main", () => {
    expect(resolveTableDatabase({ database: null, table: "t" }, null, "sqlite")).toBe("main");
    expect(resolveTableDatabase({ database: null, table: "t" }, null, "mysql")).toBeNull();
    expect(resolveTableDatabase({ database: "a", table: "t" }, "b", "mysql")).toBe("a");
    expect(resolveTableDatabase({ database: null, table: "t" }, "b", "mysql")).toBe("b");
  });

  it("FROM / UPDATE を含む別構文を誤検出せず、INSERT IGNORE / REPLACE INTO を拾う", () => {
    const tables = (sql: string) => extractTableRefs(sql, "mysql").map((r) => r.table);
    expect(tables("SELECT EXTRACT(YEAR FROM created) FROM t")).toEqual(["t"]);
    expect(tables("SELECT 1 FROM a WHERE x IS DISTINCT FROM y")).toEqual(["a"]);
    expect(tables("INSERT INTO t (a) VALUES (1) ON DUPLICATE KEY UPDATE a = 2")).toEqual(["t"]);
    expect(tables("SELECT * FROM t FOR UPDATE")).toEqual(["t"]);
    expect(tables("INSERT IGNORE INTO t (a) VALUES (1)")).toEqual(["t"]);
    expect(tables("REPLACE INTO t (a) VALUES (1)")).toEqual(["t"]);
  });
});

describe("境界・セミコロン・語境界 (#692 再レビュー)", () => {
  it("部分一致 (user が user_list に一致) は範囲にしない", () => {
    expect(findSqlRange("SELECT * FROM user_list", "SELECT * FROM user")).toBeNull();
    expect(findSqlRange("SELECT * FROM user_list WHERE 1", "SELECT * FROM user")).toBeNull();
    const text = "SELECT * FROM user_list;\nSELECT * FROM user;";
    const r = findSqlRange(text, "SELECT * FROM user");
    expect(r && text.slice(r.from, r.to)).toBe("SELECT * FROM user");
  });

  it("範囲置換では末尾の ; を落とす", () => {
    expect(sqlForRangeReplace("SELECT 1;\n")).toBe("SELECT 1");
    expect(sqlForRangeReplace("SELECT 1")).toBe("SELECT 1");
  });

  it("リテラル一致は語境界のみ。識別子の一部は伏せない", () => {
    const sql = "SELECT 1 WHERE a = 'user'";
    expect(maskErrorMessage("Unknown column 'user_id'", sql)).toBe("Unknown column 'user_id'");
    expect(maskErrorMessage("bad value user here", sql)).toBe("bad value … here");
  });

  it("PostgreSQL の invalid input 形式の値を伏せる", () => {
    expect(maskErrorMessage('invalid input syntax for type integer: "abc"', "")).toBe(
      'invalid input syntax for type integer: "…"',
    );
  });
});
