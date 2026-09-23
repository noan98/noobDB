import { describe, expect, it } from "vitest";
import type { SchemaObject, Snippet } from "../api/tauri";
import {
  analyzeDefinition,
  findReferences,
  prepareForReferenceScan,
  runWhereUsedScan,
  snippetAppliesToDriver,
  splitHighlightSegments,
  tableQualifiers,
  toReferenceLines,
  unsupportedWhereUsedKinds,
  type WhereUsedTarget,
} from "../components/whereUsed";

/**
 * オブジェクト依存検索 (#1027) の純ロジック。識別子境界 (部分一致しない)・引用・
 * スキーマ修飾・大小無視・コメント/文字列のマスク・列の別名解決を固定する。
 */

const table = (t: string, database = "app"): WhereUsedTarget => ({ database, table: t, column: null });
const col = (t: string, c: string, database = "app"): WhereUsedTarget => ({ database, table: t, column: c });

/** ヒットした箇所の元テキストを返す (位置の検証用)。 */
function hitTexts(sql: string, target: WhereUsedTarget, driver?: string): string[] {
  return findReferences(sql, target, driver).map((h) => sql.slice(h.start, h.end));
}

describe("prepareForReferenceScan", () => {
  it("長さを保ち、コメントと文字列だけを空白にする", () => {
    const sql = "SELECT 'orders' -- orders\nFROM orders /* orders */";
    const out = prepareForReferenceScan(sql, "postgres");
    expect(out.length).toBe(sql.length);
    expect(out).not.toContain("'orders'");
    expect(out.match(/orders/g)?.length).toBe(1);
  });

  it("引用識別子の中身は書き戻す (maskLiterals は空白にする)", () => {
    expect(prepareForReferenceScan('SELECT * FROM "Order Items"', "postgres")).toBe(
      'SELECT * FROM "Order Items"',
    );
    expect(prepareForReferenceScan("SELECT * FROM `order items`", "mysql")).toBe(
      "SELECT * FROM `order items`",
    );
  });

  it("MySQL の二重引用は文字列リテラルのまま", () => {
    expect(prepareForReferenceScan('SELECT "orders"', "mysql")).toBe('SELECT "      "');
  });

  it("PostgreSQL のドル引用本体はコードとして残し、中の文字列/コメントは消す", () => {
    const sql =
      "CREATE FUNCTION f() RETURNS int AS $function$\nBEGIN\n  -- orders\n  RETURN (SELECT count(*) FROM orders WHERE s = 'orders');\nEND\n$function$";
    const out = prepareForReferenceScan(sql, "postgres");
    expect(out.length).toBe(sql.length);
    expect(out.match(/orders/g)?.length).toBe(1);
    expect(out).toContain("FROM orders WHERE");
  });
});

describe("findReferences (テーブル)", () => {
  it("単語境界: 部分文字列にはマッチしない", () => {
    const sql = "SELECT * FROM orders_archive JOIN old_orders ON 1=1 JOIN orders2 ON 1=1";
    expect(hitTexts(sql, table("orders"), "postgres")).toEqual([]);
  });

  it("大小文字を無視し、引用形式を解釈する", () => {
    expect(hitTexts("select * from ORDERS", table("orders"), "postgres")).toEqual(["ORDERS"]);
    expect(hitTexts('select * from "Orders"', table("orders"), "postgres")).toEqual(['"Orders"']);
    expect(hitTexts("select * from `orders`", table("orders"), "mysql")).toEqual(["`orders`"]);
    expect(hitTexts("select * from [orders]", table("orders"), "mssql")).toEqual(["[orders]"]);
    expect(hitTexts('select * from "order ""x"""', table('order "x"'), "postgres")).toEqual([
      '"order ""x"""',
    ]);
  });

  it("コメント・文字列リテラルの中はマッチしない", () => {
    const sql = "SELECT 'from orders' AS s -- orders\n/* orders */ FROM t";
    expect(hitTexts(sql, table("orders"), "postgres")).toEqual([]);
    expect(hitTexts("SELECT 'it\\'s orders' FROM t", table("orders"), "mysql")).toEqual([]);
  });

  it("スキーマ修飾は対象スキーマのときだけ採用する", () => {
    expect(hitTexts("SELECT * FROM app.orders", table("orders"), "mysql")).toEqual(["orders"]);
    expect(hitTexts("SELECT * FROM other.orders", table("orders"), "mysql")).toEqual([]);
    expect(hitTexts('SELECT * FROM "app"."orders"', table("orders"), "postgres")).toEqual([
      '"orders"',
    ]);
    // MSSQL は dbo / db.dbo の両方を同じスキーマとみなす。
    expect(hitTexts("SELECT * FROM dbo.orders", table("orders", "shop"), "mssql")).toEqual(["orders"]);
    expect(hitTexts("SELECT * FROM shop.dbo.[orders]", table("orders", "shop"), "mssql")).toEqual([
      "[orders]",
    ]);
    expect(hitTexts("SELECT * FROM main.orders", table("orders", "main"), "sqlite")).toEqual(["orders"]);
  });

  it("`orders.col` の形の列修飾もテーブル参照として数える", () => {
    expect(hitTexts("SELECT orders.id FROM x", table("orders"), "postgres")).toEqual(["orders"]);
    expect(hitTexts("SELECT app.orders.id FROM x", table("orders"), "postgres")).toEqual(["orders"]);
  });

  it("別名の修飾子や列位置の同名はテーブル参照にしない", () => {
    expect(hitTexts("SELECT o.orders FROM t o", table("orders"), "postgres")).toEqual([]);
  });

  it("変数・バインド・位置パラメータ・数値は識別子として扱わない", () => {
    expect(hitTexts("SET @orders = 1; SELECT :orders, @@orders", table("orders"), "mysql")).toEqual([]);
    expect(hitTexts("SELECT x::orders FROM t", table("orders"), "postgres")).toEqual(["orders"]);
    expect(hitTexts("SELECT 1orders FROM t", table("orders"), "postgres")).toEqual([]);
  });

  it("Unicode の識別子でも境界を判定する", () => {
    expect(hitTexts("SELECT * FROM 注文 JOIN 注文明細 ON 1=1", table("注文"), "postgres")).toEqual(["注文"]);
  });
});

describe("findReferences (列)", () => {
  it("テーブル名・別名で修飾された列は直接参照", () => {
    const sql = "SELECT o.status, orders.status FROM orders o";
    const hits = findReferences(sql, col("orders", "status"), "postgres");
    expect(hits.map((h) => sql.slice(h.start, h.end))).toEqual(["status", "status"]);
    expect(hits.every((h) => h.confidence === "direct")).toBe(true);
  });

  it("AS 付きの別名も解決する", () => {
    const sql = "SELECT x.status FROM app.orders AS x";
    expect(findReferences(sql, col("orders", "status"), "postgres")[0].confidence).toBe("direct");
  });

  it("スキーマ修飾された別テーブルの同名列は除外する", () => {
    expect(hitTexts("SELECT app.customers.status FROM app.customers", col("orders", "status"), "postgres")).toEqual([]);
    expect(hitTexts("SELECT other.orders.status FROM t", col("orders", "status"), "postgres")).toEqual([]);
  });

  it("本文が対象テーブルを参照しないなら無修飾・未解決の列は候補止まり", () => {
    const hits = findReferences("SELECT status FROM customers", col("orders", "status"), "postgres");
    expect(hits).toHaveLength(1);
    expect(hits[0].confidence).toBe("possible");
    const trig = findReferences("BEGIN NEW.status := 'x'; END", col("orders", "status"), "postgres");
    expect(trig[0].confidence).toBe("possible");
  });

  it("本文が対象テーブルを参照していれば無修飾の列は直接参照", () => {
    const hits = findReferences("SELECT status FROM orders", col("orders", "status"), "postgres");
    expect(hits[0].confidence).toBe("direct");
  });

  it("部分一致しない", () => {
    expect(hitTexts("SELECT status_code, order_status FROM orders", col("orders", "status"), "postgres")).toEqual([]);
  });
});

describe("splitHighlightSegments", () => {
  it("範囲を強調区間に分け、重なり・逆順・はみ出しを吸収する", () => {
    expect(splitHighlightSegments("FROM orders o", [[5, 11]])).toEqual([
      { text: "FROM ", hit: false },
      { text: "orders", hit: true },
      { text: " o", hit: false },
    ]);
    expect(splitHighlightSegments("abcdef", [[3, 9], [0, 2], [1, 4]])).toEqual([
      { text: "ab", hit: true },
      { text: "cd", hit: true },
      { text: "ef", hit: true },
    ]);
    expect(splitHighlightSegments("abc", [])).toEqual([{ text: "abc", hit: false }]);
  });
});

describe("toReferenceLines", () => {
  it("行番号と行内の範囲へまとめる (前後の空白を落とす)", () => {
    const sql = "SELECT *\n    FROM orders o JOIN orders p ON 1=1\nWHERE 1";
    const lines = toReferenceLines(sql, findReferences(sql, table("orders"), "postgres"));
    expect(lines).toHaveLength(1);
    expect(lines[0].line).toBe(2);
    expect(lines[0].text).toBe("FROM orders o JOIN orders p ON 1=1");
    expect(lines[0].ranges.map(([s, e]) => lines[0].text.slice(s, e))).toEqual(["orders", "orders"]);
  });

  it("長い行はヒット周辺を切り出して省略を示す", () => {
    const sql = `SELECT ${"a, ".repeat(100)}b FROM orders WHERE ${"c = 1 AND ".repeat(40)}1`;
    const [line] = toReferenceLines(sql, findReferences(sql, table("orders"), "postgres"));
    expect(line.clippedStart).toBe(true);
    expect(line.clippedEnd).toBe(true);
    expect(line.text.length).toBeLessThanOrEqual(160);
    const [s, e] = line.ranges[0];
    expect(line.text.slice(s, e)).toBe("orders");
  });
});

describe("analyzeDefinition", () => {
  it("参照が無ければ null", () => {
    expect(analyzeDefinition("SELECT 1", table("orders"), "postgres")).toBeNull();
  });

  it("直接参照が 1 つでもあれば direct", () => {
    const a = analyzeDefinition("SELECT status FROM orders", col("orders", "status"), "postgres");
    expect(a?.confidence).toBe("direct");
    expect(a?.hitCount).toBe(1);
  });
});

describe("ドライバ別の縮退", () => {
  it("取れない種別を明示する", () => {
    expect(unsupportedWhereUsedKinds("mysql")).toEqual([]);
    expect(unsupportedWhereUsedKinds("postgres")).toEqual([]);
    expect(unsupportedWhereUsedKinds("mssql")).toEqual([]);
    expect(unsupportedWhereUsedKinds("sqlite")).toEqual(["procedure", "function"]);
    expect(unsupportedWhereUsedKinds("duckdb")).toEqual(["procedure", "function", "trigger"]);
  });

  it("修飾子の既定スキーマ", () => {
    expect(tableQualifiers("mssql", "Shop")).toEqual(["shop", "dbo"]);
    expect(tableQualifiers("sqlite", "main")).toEqual(["main"]);
    expect(tableQualifiers("postgres", "public")).toEqual(["public"]);
  });
});

describe("runWhereUsedScan", () => {
  const objects: SchemaObject[] = [
    { kind: "view", name: "v_orders", id: null },
    { kind: "view", name: "orders", id: null },
    { kind: "function", name: "f_total", id: "11" },
    { kind: "procedure", name: "p_secret", id: null },
    { kind: "trigger", name: "t_audit", id: "12" },
    { kind: "function", name: "f_empty", id: null },
  ];
  const defs: Record<string, string> = {
    v_orders: "CREATE VIEW v_orders AS SELECT * FROM orders",
    orders: "CREATE VIEW orders AS SELECT * FROM orders",
    f_total: "CREATE FUNCTION f_total() AS $$ SELECT sum(x) FROM customers $$",
    t_audit: "CREATE TRIGGER t_audit AFTER INSERT ON app.orders FOR EACH ROW EXECUTE FUNCTION f()",
    f_empty: "   ",
  };
  const snippet = (id: string, sql: string, driver: string | null): Snippet => ({
    id,
    name: id,
    folder: null,
    tags: [],
    sql,
    driver,
    scope: { kind: "any" },
  });

  it("定義とスニペットを走査し、失敗・空定義を分けて報告する", async () => {
    const progress: number[] = [];
    const report = await runWhereUsedScan({
      driver: "postgres",
      target: table("orders"),
      listObjects: async () => objects,
      getDefinition: async (o) => {
        if (o.name === "p_secret") throw new Error("permission denied");
        return defs[o.name];
      },
      snippets: [
        snippet("s1", "select * from orders", null),
        snippet("s2", "select * from orders", "mysql"),
        snippet("s3", "select 1", "postgres"),
      ],
      onProgress: (p) => progress.push(p.done),
    });
    expect(report.matches.map((m) => `${m.kind}:${m.name}`)).toEqual([
      "view:v_orders",
      "trigger:t_audit",
      "snippet:s1",
    ]);
    // ビュー自身 (orders) は対象から外す。
    expect(report.scannedObjects).toBe(4);
    expect(report.scannedSnippets).toBe(2);
    expect(report.failed).toEqual([{ kind: "procedure", name: "p_secret", error: "Error: permission denied" }]);
    expect(report.emptyDefinitions).toEqual([{ kind: "function", name: "f_empty" }]);
    expect(report.cancelled).toBe(false);
    expect(progress[progress.length - 1]).toBe(5);
    expect(report.matches[0].lines[0].line).toBe(1);
  });

  it("ドライバが扱わない種別は取りに行かない", async () => {
    const asked: string[] = [];
    await runWhereUsedScan({
      driver: "duckdb",
      target: table("orders"),
      listObjects: async () => objects,
      getDefinition: async (o) => {
        asked.push(o.kind);
        return defs[o.name] ?? "";
      },
      snippets: [],
    });
    expect(new Set(asked)).toEqual(new Set(["view"]));
  });

  it("キャンセルされたら残りを取りに行かず途中結果を返す", async () => {
    const ctrl = new AbortController();
    let calls = 0;
    const report = await runWhereUsedScan({
      driver: "postgres",
      target: table("orders"),
      listObjects: async () => objects,
      getDefinition: async (o) => {
        calls++;
        ctrl.abort();
        return defs[o.name] ?? "";
      },
      snippets: [snippet("s1", "select * from orders", null)],
      signal: ctrl.signal,
      concurrency: 1,
    });
    expect(calls).toBe(1);
    expect(report.cancelled).toBe(true);
    expect(report.scannedSnippets).toBe(0);
    expect(report.matches).toEqual([]);
  });

  it("スニペットのドライバ判定", () => {
    expect(snippetAppliesToDriver(snippet("a", "", null), "mysql")).toBe(true);
    expect(snippetAppliesToDriver(snippet("a", "", "mysql"), "mysql")).toBe(true);
    expect(snippetAppliesToDriver(snippet("a", "", "postgres"), "mysql")).toBe(false);
  });
});
