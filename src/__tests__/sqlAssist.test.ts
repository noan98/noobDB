import { describe, expect, it } from "vitest";
import {
  buildSqlAssistPrompt,
  buildSqlAssistSystem,
  countStatements,
  DIFF_MAX_CELLS,
  diffLines,
  hasDiffChanges,
  locateApplyTarget,
  parseSqlExplainResponse,
  parseSqlRewriteResponse,
  restoreMaskedLiterals,
  SQL_ASSIST_TASK,
  SQL_EXPLAIN_FORMAT,
  SQL_REWRITE_FORMAT,
  sqlForApply,
} from "../ai/sqlAssist";

/** 構造化出力スキーマの全オブジェクトが additionalProperties: false を持つ。 */
function everyObjectClosed(node: unknown): boolean {
  if (Array.isArray(node)) return node.every(everyObjectClosed);
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (o.type === "object" && o.additionalProperties !== false) return false;
    return Object.values(o).every(everyObjectClosed);
  }
  return true;
}

describe("構造化出力スキーマ (#695)", () => {
  it("すべてのオブジェクトが additionalProperties: false", () => {
    expect(everyObjectClosed(SQL_EXPLAIN_FORMAT.schema)).toBe(true);
    expect(everyObjectClosed(SQL_REWRITE_FORMAT.schema)).toBe(true);
  });

  it("task は sqlExplain / sqlRewrite (モデル ID は渡さない)", () => {
    expect(SQL_ASSIST_TASK).toEqual({ explain: "sqlExplain", rewrite: "sqlRewrite" });
  });
});

describe("応答のパース", () => {
  const explain = { overview: "O", steps: [{ title: "T", detail: "D" }], caveats: ["C"] };
  const rewrite = {
    rewritten_sql: "SELECT 1",
    changes: [{ what: "w", why: "y" }],
    equivalence_notes: ["n"],
    caveats: [],
  };

  it("解説を zod で検証して返す (コードフェンスも許容)", () => {
    expect(parseSqlExplainResponse(JSON.stringify(explain))).toEqual({ ok: true, value: explain });
    const fenced = "```json\n" + JSON.stringify(explain) + "\n```";
    expect(parseSqlExplainResponse(fenced).ok).toBe(true);
  });

  it("形が違う / JSON でないときは本文をそのまま返す", () => {
    expect(parseSqlExplainResponse("plain")).toEqual({ ok: false, raw: "plain" });
    const bad = JSON.stringify({ overview: "O" });
    expect(parseSqlExplainResponse(bad)).toEqual({ ok: false, raw: bad });
  });

  it("リライトを検証し、rewritten_sql が空なら失敗扱い", () => {
    expect(parseSqlRewriteResponse(JSON.stringify(rewrite))).toEqual({ ok: true, value: rewrite });
    const empty = JSON.stringify({ ...rewrite, rewritten_sql: "  " });
    expect(parseSqlRewriteResponse(empty)).toEqual({ ok: false, raw: empty });
  });
});

describe("プロンプト", () => {
  const tables = [
    {
      name: "users",
      columns: [
        { name: "id", data_type: "int", nullable: false, key: "PRI", referenced_table: null, referenced_column: null },
      ],
    },
  ];

  it("方言・SQL・テーブル定義を含み、マスク有効ならリテラルを送らない", () => {
    const p = buildSqlAssistPrompt({
      kind: "rewrite",
      sql: "SELECT * FROM users WHERE email = 'secret@example.com' -- note",
      driver: "postgres",
      tables,
      maskLiterals: true,
    });
    expect(p).toContain("Dialect: PostgreSQL");
    expect(p).toContain("optimized");
    expect(p).toContain("FROM users");
    expect(p).toContain("- users");
    expect(p).toContain("id int (key=PRI, not null)");
    expect(p).not.toContain("secret@example.com");
    expect(p).not.toContain("note");
  });

  it("マスク無効ならそのまま送る。テーブルが無ければ Referenced tables を出さない", () => {
    const p = buildSqlAssistPrompt({
      kind: "explain",
      sql: "SELECT 'x'",
      driver: "sqlite",
      tables: [],
      maskLiterals: false,
    });
    expect(p).toContain("SELECT 'x'");
    expect(p).toContain("SQLite");
    expect(p).not.toContain("Referenced tables");
  });

  it("system は言語と種別で切り替わり、行データは送らない旨を含む", () => {
    expect(buildSqlAssistSystem("explain", "ja")).toContain("Japanese");
    expect(buildSqlAssistSystem("explain", "en")).toContain("English");
    expect(buildSqlAssistSystem("explain", "en")).toContain("steps");
    expect(buildSqlAssistSystem("rewrite", "en")).toContain("rewritten_sql");
    expect(buildSqlAssistSystem("rewrite", "en")).toContain("never row data");
    // 全文対象でも文の数を変えさせない
    expect(buildSqlAssistSystem("rewrite", "en")).toContain("same number of statements");
    expect(buildSqlAssistSystem("rewrite", "en")).not.toContain("one complete statement");
  });
});

describe("diffLines", () => {
  it("同一なら差分なし", () => {
    const d = diffLines("a\nb", "a\nb");
    expect(d.map((l) => l.type)).toEqual(["same", "same"]);
    expect(hasDiffChanges(d)).toBe(false);
  });

  it("追加 / 削除 / 変更を行単位で出す", () => {
    const d = diffLines("SELECT *\nFROM t\nWHERE a = 1", "SELECT id\nFROM t\nWHERE a = 1\nLIMIT 10");
    expect(d).toEqual([
      { type: "del", text: "SELECT *" },
      { type: "add", text: "SELECT id" },
      { type: "same", text: "FROM t" },
      { type: "same", text: "WHERE a = 1" },
      { type: "add", text: "LIMIT 10" },
    ]);
    expect(hasDiffChanges(d)).toBe(true);
  });

  it("末尾空白と CRLF の違いは差分にしない", () => {
    expect(hasDiffChanges(diffLines("a  \r\nb", "a\nb"))).toBe(false);
  });

  it("中央の入れ替えでも共通行を保つ", () => {
    const d = diffLines("1\n2\n3\n4", "1\nX\n3\n4");
    expect(d.filter((l) => l.type === "same").map((l) => l.text)).toEqual(["1", "3", "4"]);
    expect(d.filter((l) => l.type === "del").map((l) => l.text)).toEqual(["2"]);
    expect(d.filter((l) => l.type === "add").map((l) => l.text)).toEqual(["X"]);
  });

  it("空文字列との diff", () => {
    expect(diffLines("", "a")).toEqual([{ type: "add", text: "a" }]);
    expect(diffLines("a", "")).toEqual([{ type: "del", text: "a" }]);
  });
});

describe("適用範囲", () => {
  it("起動時の範囲に元の SQL が残っていれば exact", () => {
    const doc = "SELECT 1;\nSELECT 2;";
    expect(locateApplyTarget(doc, "SELECT 2", { from: 10, to: 18 })).toEqual({ from: 10, to: 18, exact: true });
    expect(locateApplyTarget("SELECT 1", "SELECT 1", null)).toEqual({ from: 0, to: 8, exact: true });
  });

  it("範囲がずれたら一意に見つかる位置、無ければ全文 (どちらも要確認)", () => {
    const moved = "-- c\nSELECT 2;";
    expect(locateApplyTarget(moved, "SELECT 2", { from: 10, to: 18 })).toEqual({ from: 5, to: 13, exact: false });
    expect(locateApplyTarget("edited", "SELECT 2", { from: 0, to: 8 })).toEqual({ from: 0, to: 6, exact: false });
    // 重複していれば特定できず全文
    const dup = "SELECT 2; SELECT 2;";
    expect(locateApplyTarget(dup, "SELECT 2", { from: 100, to: 108 })).toEqual({ from: 0, to: dup.length, exact: false });
  });

  it("末尾の ; は元の範囲に含まれていたときだけ残す", () => {
    const doc = "SELECT 1;";
    const withSemi = locateApplyTarget(doc, "SELECT 1;", { from: 0, to: 9 });
    expect(sqlForApply("SELECT 2", withSemi, doc)).toBe("SELECT 2;");
    expect(sqlForApply("SELECT 2;;", withSemi, doc)).toBe("SELECT 2;");
    const noSemi = locateApplyTarget(doc, "SELECT 1", { from: 0, to: 8 });
    expect(sqlForApply("SELECT 2;\n", noSemi, doc)).toBe("SELECT 2");
  });
});

describe("sqlForApply: 空白の保持", () => {
  it("元の範囲の先頭・末尾の空白 / 改行を保つ", () => {
    const doc = "\n  SELECT 1;\n\n";
    const target = locateApplyTarget(doc, doc, null);
    expect(sqlForApply("SELECT 2", target, doc)).toBe("\n  SELECT 2;\n\n");
    const noSemi = "  SELECT 1  ";
    expect(sqlForApply("SELECT 2;", locateApplyTarget(noSemi, noSemi, null), noSemi)).toBe("  SELECT 2  ");
  });
});

describe("restoreMaskedLiterals", () => {
  it("空白リテラルの個数が元と一致したら出現順に差し戻す", () => {
    const orig = "SELECT * FROM t WHERE a = 'x''y' AND b = 'bob' -- 'c'";
    const prop = "SELECT id FROM t WHERE a = '    ' AND b = '   '";
    expect(restoreMaskedLiterals(orig, prop)).toEqual({
      sql: "SELECT id FROM t WHERE a = 'x''y' AND b = 'bob'",
      status: "restored",
    });
  });

  it("空リテラル '' も数える", () => {
    expect(restoreMaskedLiterals("SELECT '', 'a'", "SELECT '', ' '")).toEqual({
      sql: "SELECT '', 'a'",
      status: "restored",
    });
  });

  it("提案に空白リテラルが無ければ何もしない (none)", () => {
    expect(restoreMaskedLiterals("SELECT 'a'", "SELECT 1")).toEqual({ sql: "SELECT 1", status: "none" });
  });

  it("個数が合わなければ差し戻さず missing", () => {
    const prop = "SELECT ' ' , ' '";
    expect(restoreMaskedLiterals("SELECT 'a'", prop)).toEqual({ sql: prop, status: "missing" });
    expect(restoreMaskedLiterals("SELECT 1", "SELECT ' '")).toEqual({ sql: "SELECT ' '", status: "missing" });
  });

  it("コメント・二重引用符内の引用符はリテラルに数えない", () => {
    expect(restoreMaskedLiterals('SELECT "it\'s", \'a\' /* \'z\' */', "SELECT \" \", ' '")).toEqual({
      sql: "SELECT \" \", 'a'",
      status: "restored",
    });
  });
});

describe("countStatements", () => {
  it("; 区切りの文を数え、コメント / リテラル内の ; と空の文は数えない", () => {
    expect(countStatements("SELECT 1; SELECT ';'; -- a;b\n", "mysql")).toBe(2);
    expect(countStatements("SELECT 1", "postgres")).toBe(1);
    expect(countStatements(" ; ; ", "sqlite")).toBe(0);
  });
});

describe("diffLines: 上限", () => {
  it("n*m が上限を超えたら中央部を全行削除 + 全行追加に落とす", () => {
    const n = Math.ceil(Math.sqrt(DIFF_MAX_CELLS)) + 1;
    const a = ["head", ...Array.from({ length: n }, (_, i) => `a${i}`), "tail"].join("\n");
    const b = ["head", ...Array.from({ length: n }, (_, i) => `b${i}`), "tail"].join("\n");
    const d = diffLines(a, b);
    expect(d).toHaveLength(n * 2 + 2);
    expect(d[0]).toEqual({ type: "same", text: "head" });
    expect(d[d.length - 1]).toEqual({ type: "same", text: "tail" });
    expect(d.filter((l) => l.type === "del")).toHaveLength(n);
    expect(d.filter((l) => l.type === "add")).toHaveLength(n);
  });
});
