import { describe, expect, it } from "vitest";
import {
  buildInlineRequest,
  cleanInlineCompletion,
  InlineCompleteCache,
  inlineCompleteAllowed,
  INLINE_AFTER_MAX_LINES,
  INLINE_BEFORE_MAX_CHARS,
  INLINE_BEFORE_MAX_LINES,
  INLINE_DOC_MAX_CHARS,
  INLINE_MAX_SUGGESTION_CHARS,
  INLINE_TIMEOUT_MS,
  headWindow,
  nextWordChunk,
  relevantTables,
  tailWindow,
  shouldShowSuggestion,
} from "../ai/inlineComplete";
import { DEFAULT_AI_SETTINGS, sanitizeAiSettings } from "../ai/aiSettings";

const tables = [
  { name: "users", columns: ["id", "name", "email"] },
  { name: "orders", columns: ["id", "user_id", "total"] },
  { name: "secrets", columns: ["token"] },
];

function req(
  doc: string,
  pos: number = doc.length,
  over: Partial<Parameters<typeof buildInlineRequest>[0]> = {},
) {
  return buildInlineRequest({
    doc,
    pos,
    driver: "mysql",
    maskLiterals: true,
    tables,
    database: "app",
    ...over,
  });
}

describe("inlineCompleteAllowed", () => {
  const ok = { featureEnabled: true, aiAvailable: true, sendScope: "schemaAndSql", isProduction: false };
  it("全部そろったときだけ許可する", () => {
    expect(inlineCompleteAllowed(ok)).toBe(true);
    expect(inlineCompleteAllowed({ ...ok, featureEnabled: false })).toBe(false);
    expect(inlineCompleteAllowed({ ...ok, aiAvailable: false })).toBe(false);
    expect(inlineCompleteAllowed({ ...ok, sendScope: "schemaOnly" })).toBe(false);
    expect(inlineCompleteAllowed({ ...ok, isProduction: true })).toBe(false);
  });
  it("既定の設定はオフ", () => {
    expect(DEFAULT_AI_SETTINGS.inlineComplete).toBe(false);
    expect(sanitizeAiSettings({}).inlineComplete).toBe(false);
    expect(sanitizeAiSettings({ inlineComplete: true }).inlineComplete).toBe(true);
    expect(sanitizeAiSettings({ inlineComplete: "yes" }).inlineComplete).toBe(false);
  });
});

describe("buildInlineRequest", () => {
  it("入力が短いときは送らない", () => {
    expect(req("SE")).toBeNull();
    expect(req("  \n ")).toBeNull();
  });
  it("単語の途中 (直後が識別子文字) では送らない", () => {
    expect(req("SELECT * FROM users", 15)).toBeNull();
  });
  it("直後が非 ASCII の識別子文字 (日本語の列名) でも送らない", () => {
    expect(req("SELECT 名前 FROM users", 8)).toBeNull();
  });
  it("カーソル前後を分けて送り、出てくるテーブルのスキーマだけ載せる", () => {
    const doc = "SELECT * FROM users u JOIN orders o ON o.user_id = u.id WHERE ";
    const r = req(doc);
    expect(r).not.toBeNull();
    expect(r?.prompt).toContain("<before_cursor>\nSELECT * FROM users");
    expect(r?.systemCached).toContain("- users(id, name, email)");
    expect(r?.systemCached).toContain("- orders(id, user_id, total)");
    expect(r?.systemCached).not.toContain("secrets");
    expect(r?.systemCached).not.toContain("token");
  });
  it("カーソル後の SQL も送る", () => {
    const r = req("SELECT  FROM users", 7);
    expect(r?.prompt).toContain("<after_cursor>\n FROM users\n</after_cursor>");
  });
  it("マスク有効なら文字列リテラルの中身を送らない", () => {
    const r = req("SELECT * FROM users WHERE email = 'alice@example.com' AND ");
    expect(r?.prompt).not.toContain("alice@example.com");
    expect(r?.systemCached).not.toContain("alice@example.com");
  });
  it("マスク無効ならそのまま送る", () => {
    const r = req("SELECT * FROM users WHERE email = 'alice@example.com' AND ", undefined, {
      maskLiterals: false,
    });
    expect(r?.prompt).toContain("alice@example.com");
  });
  it("コメントの中身もマスクされる", () => {
    const r = req("-- secret memo\nSELECT * FROM users WHERE ");
    expect(r?.prompt).not.toContain("secret memo");
  });
  it("リテラルの途中では送らない", () => {
    expect(req("SELECT * FROM users WHERE name = 'ali")).toBeNull();
  });
  it("カーソル前は 40 行 / 4KB まで、後ろは 10 行までに切る", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `-- l${i}`).join("\n");
    const before = `${lines}\nSELECT * FROM users WHERE `;
    const r = req(before);
    const sent = r?.prompt.split("<before_cursor>\n")[1].split("\n</before_cursor>")[0] ?? "";
    expect(sent.split("\n").length).toBeLessThanOrEqual(INLINE_BEFORE_MAX_LINES);
    const long = `SELECT ${"a".repeat(INLINE_BEFORE_MAX_CHARS * 2)} FROM users WHERE `;
    const r2 = req(long);
    expect(r2?.prompt.length ?? 0).toBeLessThan(INLINE_BEFORE_MAX_CHARS + 500);
    const after = Array.from({ length: 50 }, (_, i) => `x${i}`).join("\n");
    const r3 = req(`SELECT * FROM users WHERE \n${after}`, 26);
    const sentAfter = r3?.prompt.split("<after_cursor>\n")[1].split("\n</after_cursor>")[0] ?? "";
    expect(sentAfter.split("\n").length).toBeLessThanOrEqual(INLINE_AFTER_MAX_LINES);
  });
  it("同じ入力は同じキャッシュキー、違えば別", () => {
    expect(req("SELECT * FROM users WHERE ")?.cacheKey).toBe(req("SELECT * FROM users WHERE ")?.cacheKey);
    expect(req("SELECT * FROM users WHERE ")?.cacheKey).not.toBe(
      req("SELECT * FROM orders WHERE ")?.cacheKey,
    );
  });
  it("行データを含めない (スキーマは列名のみ)", () => {
    const r = req("SELECT * FROM users WHERE ");
    expect(r?.systemCached).toContain("users(id, name, email)");
  });
});

describe("窓の切り口が複数行リテラル / コメントの途中でもマスクが効く", () => {
  it("45 行にわたる文字列リテラルの中身を送らない", () => {
    const lines = ["INSERT INTO t VALUES ('line0"];
    for (let i = 1; i < 45; i++) lines.push(`secret-${i}`);
    lines.push("password123'); SELECT * FROM users WHERE id = 1 ");
    const doc = lines.join("\n");
    const r = req(doc);
    expect(r).not.toBeNull();
    expect(r?.prompt).not.toContain("password123");
    expect(r?.prompt).not.toContain("secret-");
    expect(r?.prompt).toContain("SELECT * FROM users");
  });
  it("45 行にわたる /* */ コメントの中身を送らない", () => {
    const doc = `/* hidden\n${Array.from({ length: 45 }, (_, i) => `token ${i}`).join("\n")}\n*/ SELECT a FROM b `;
    const r = req(doc, undefined, { driver: "postgres" });
    expect(r).not.toBeNull();
    expect(r?.prompt).not.toContain("token ");
    expect(r?.prompt).not.toContain("hidden");
  });
  it("閉じ $$ がカーソル後の窓より先にあっても、ドル引用の中では問い合わせない", () => {
    const head = "SELECT $$secret-token\nSELECT * FROM users ";
    const doc = `${head}${" x".repeat(600)}$$;`;
    expect(req(doc, head.length, { driver: "postgres" })).toBeNull();
    expect(req(doc, head.length, { driver: "postgres", maskLiterals: false })).toBeNull();
  });
  it("カーソルより前で閉じたドル引用 (関数本体など) の中身は送らない", () => {
    const head = "SELECT $tag$secret-token\n$tag$ FROM users WHERE ";
    const doc = `${head}${" ".repeat(10)}${"y".repeat(1100)}`;
    const r = req(doc, head.length, { driver: "postgres" });
    expect(r).not.toBeNull();
    expect(r?.prompt).not.toContain("secret-token");
    const body =
      "CREATE FUNCTION f() RETURNS int AS $$\nBEGIN\n  RETURN 1;\nEND;\n$$ LANGUAGE plpgsql;\nSELECT * FROM users WHERE ";
    const r2 = req(`${body}\n${"-- pad\n".repeat(200)}`, body.length, { driver: "postgres" });
    expect(r2).not.toBeNull();
    expect(r2?.prompt).not.toContain("RETURN 1");
  });
  it("マスクがオフでもリテラル / コメントの中では問い合わせない", () => {
    expect(req("SELECT * FROM users WHERE name = 'abc ", undefined, { maskLiterals: false })).toBeNull();
    expect(req("SELECT 1 -- memo ", undefined, { maskLiterals: false })).toBeNull();
    expect(req("SELECT 1 /* memo \n more ", undefined, { maskLiterals: false })).toBeNull();
    expect(req("SELECT * FROM users WHERE ", undefined, { maskLiterals: false })).not.toBeNull();
  });
});

describe("tailWindow / headWindow はサロゲートペアを割らない", () => {
  it("境界が絵文字の途中なら 1 文字ずらす", () => {
    expect(headWindow("ab😀cd", 3, 1000)).toBe("ab😀cd");
    expect(headWindow("ab😀cd", 1000, 3)).toBe("ab");
    expect(tailWindow("ab😀cd", 1000, 3)).toBe("cd");
    expect(tailWindow("ab😀cd", 1000, 4)).toBe("😀cd");
  });
});

describe("relevantTables", () => {
  it("大小無視・出現順・重複なし・上限あり", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ name: `t${i}`, columns: ["a"] }));
    const text = many.map((t) => t.name.toUpperCase()).join(" ");
    expect(relevantTables(text, many).length).toBe(8);
    expect(relevantTables("USERS users Users", tables).map((t) => t.name)).toEqual(["users"]);
    // 結果は出現順ではなく名前順 (systemCached を安定させる)。
    expect(relevantTables("users orders", tables).map((t) => t.name)).toEqual(["orders", "users"]);
  });
});

describe("cleanInlineCompletion", () => {
  it("コードフェンスを除く", () => {
    expect(cleanInlineCompletion("```sql\nWHERE id = 1\n```", "SELECT * FROM t ")).toBe("WHERE id = 1");
    expect(cleanInlineCompletion("```\nWHERE id = 1", "SELECT * FROM t ")).toBe("WHERE id = 1");
  });
  it("最大文字数の切り詰めでサロゲートペアを割らない (#1603)", () => {
    const out = cleanInlineCompletion(`${"a".repeat(INLINE_MAX_SUGGESTION_CHARS - 1)}😀tail`, "SELECT ");
    expect(out.length).toBeLessThanOrEqual(INLINE_MAX_SUGGESTION_CHARS);
    expect(/[\uD800-\uDBFF]$/.test(out)).toBe(false);
  });
  it("前置き行を除く", () => {
    expect(cleanInlineCompletion("Here is the completion:\nWHERE id = 1", "SELECT * FROM t ")).toBe(
      "WHERE id = 1",
    );
  });
  it("カーソル前の最終行の繰り返しを除く", () => {
    expect(cleanInlineCompletion("SELECT * FROM users WHERE id = 1", "SELECT * FROM users")).toBe(
      " WHERE id = 1",
    );
  });
  it("空・空白だけは空文字", () => {
    expect(cleanInlineCompletion("  \n ", "SELECT")).toBe("");
    expect(cleanInlineCompletion("```\n```", "SELECT")).toBe("");
  });
  it("先頭の空白は残し、末尾の空白は落とす", () => {
    expect(cleanInlineCompletion(" id = 1  \n", "WHERE")).toBe(" id = 1");
  });
  it("長さの上限で切る", () => {
    const out = cleanInlineCompletion("a\n".repeat(50), "SELECT");
    expect(out.split("\n").length).toBeLessThanOrEqual(6);
    expect(cleanInlineCompletion("x".repeat(2000), "SELECT").length).toBeLessThanOrEqual(400);
  });
});

describe("InlineCompleteCache", () => {
  it("直近 N 件だけ覚え、使われたものは残る", () => {
    const c = new InlineCompleteCache(2);
    c.set("a", "1");
    c.set("b", "2");
    expect(c.get("a")).toBe("1");
    c.set("c", "3");
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe("1");
    expect(c.get("c")).toBe("3");
    expect(c.size).toBe(2);
  });
  it("空文字の結果も区別して覚える", () => {
    const c = new InlineCompleteCache();
    c.set("k", "");
    expect(c.get("k")).toBe("");
    expect(c.get("none")).toBeUndefined();
  });
});

describe("shouldShowSuggestion", () => {
  const base = {
    text: "x",
    requestPos: 5,
    currentPos: 5,
    selectionEmpty: true,
    docVersionUnchanged: true,
    elapsedMs: 100,
  };
  it("条件がそろえば出す", () => {
    expect(shouldShowSuggestion(base)).toBe(true);
  });
  it("空・カーソル移動・選択あり・文書変更・遅延では出さない", () => {
    expect(shouldShowSuggestion({ ...base, text: "" })).toBe(false);
    expect(shouldShowSuggestion({ ...base, currentPos: 6 })).toBe(false);
    expect(shouldShowSuggestion({ ...base, selectionEmpty: false })).toBe(false);
    expect(shouldShowSuggestion({ ...base, docVersionUnchanged: false })).toBe(false);
    expect(shouldShowSuggestion({ ...base, elapsedMs: INLINE_TIMEOUT_MS + 1 })).toBe(false);
    expect(shouldShowSuggestion({ ...base, elapsedMs: INLINE_TIMEOUT_MS })).toBe(true);
  });
});

describe("buildInlineRequest: 文書全体のマスクは 1 回の結果から窓を取る (#1608)", () => {
  it("カーソルの前後にあるリテラルは伏せ、差し込みの 1 文字が送信内容に混ざらない", () => {
    const doc = "SELECT 'before-secret' FROM users WHERE id = 1 \nAND name = 'after-secret'";
    const pos = doc.indexOf("\nAND");
    const r = req(doc, pos);
    expect(r).not.toBeNull();
    expect(r?.prompt).not.toContain("before-secret");
    expect(r?.prompt).not.toContain("after-secret");
    // 差し込んだ識別子文字 (Z) が窓に残らない: 後ろ側は改行から始まる。
    expect(r?.prompt).toContain("<after_cursor>\n\nAND name = ");
    expect(r?.prompt).toContain("WHERE id = 1 \n</before_cursor>");
  });

  it("マスク設定がオフでもリテラルの内側なら null (判定は同じ 1 回のマスクで行う)", () => {
    const doc = "SELECT * FROM users WHERE name = 'ab";
    expect(req(doc, doc.length, { maskLiterals: false })).toBeNull();
  });
});

describe("buildInlineRequest: 文書サイズの上限 (#1608)", () => {
  it("上限以下なら組み立て、超える文書では全文マスクを避けて null を返す", () => {
    const stmt = "SELECT id, name FROM users WHERE ";
    const pad = (n: number) => `/*${" ".repeat(Math.max(0, n - 5))}*/\n`;
    const within = pad(INLINE_DOC_MAX_CHARS - stmt.length) + stmt;
    expect(within.length).toBe(INLINE_DOC_MAX_CHARS);
    expect(req(within)).not.toBeNull();
    const over = pad(INLINE_DOC_MAX_CHARS - stmt.length + 1) + stmt;
    expect(over.length).toBe(INLINE_DOC_MAX_CHARS + 1);
    expect(req(over)).toBeNull();
  });
});

describe("nextWordChunk (#1608)", () => {
  it("先頭の空白を含めて、識別子の連なりまたは記号の連なりを 1 語として切り出す", () => {
    expect(nextWordChunk("WHERE id = 1")).toBe("WHERE");
    expect(nextWordChunk(" id = 1")).toBe(" id");
    expect(nextWordChunk(" = 1")).toBe(" =");
    expect(nextWordChunk(" 1")).toBe(" 1");
    expect(nextWordChunk("user_id, name")).toBe("user_id");
    expect(nextWordChunk("名前 FROM")).toBe("名前");
    expect(nextWordChunk("(a)")).toBe("(");
    expect(nextWordChunk("\n  ORDER")).toBe("\n  ORDER");
  });

  it("空白だけなら全体を返し、空文字は空文字", () => {
    expect(nextWordChunk("   ")).toBe("   ");
    expect(nextWordChunk("")).toBe("");
  });
});

describe("buildInlineRequest: 2 文字記号の間では出さない (#1608 レビュー)", () => {
  it("`--` の間にカーソルがあるとき (コメント内の ' で字句がずれるので) null", () => {
    for (const driver of ["mysql", "postgres"]) {
      const doc = "SELECT * FROM users WHERE id = 1 -- it's a note\nAND name = 'top-secret'";
      const pos = doc.indexOf("--") + 1;
      expect(req(doc, pos, { driver })).toBeNull();
    }
  });

  it("`/*` の間にカーソルがあるとき null。リテラルの中身は送られない", () => {
    for (const driver of ["mysql", "postgres"]) {
      const doc = "SELECT * FROM users /* it's a note */ WHERE name = 'top-secret'";
      const pos = doc.indexOf("/*") + 1;
      expect(req(doc, pos, { driver })).toBeNull();
    }
  });

  it("2 文字記号の間でなければ従来どおり出し、後ろのリテラルは伏せる", () => {
    const doc = "SELECT * FROM users -- it's a note\nWHERE name = 'top-secret'";
    const r = req(`${doc} AND `);
    expect(r).not.toBeNull();
    expect(r?.prompt).not.toContain("top-secret");
  });
});
