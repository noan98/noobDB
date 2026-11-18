import { describe, expect, it } from "vitest";
import {
  buildColumnIndex,
  ddlTargetTables,
  indexLookup,
  type InsertStatement,
  insertArityIssues,
  insertValueHints,
  MAX_HINT_LABEL,
  resolveInsertColumns,
  scanInsertValues,
  truncateLabel,
} from "../components/insertValues";

import type { ColumnLookup } from "../components/insertValues";
const none: ColumnLookup = () => null;

function vals(text: string, stmt: InsertStatement, row = 0): string[] {
  return (stmt.rows[row].values ?? []).map((v) => text.slice(v.from, v.to));
}

describe("scanInsertValues", () => {
  it("列リストと値を対応付ける", () => {
    const sql = "INSERT INTO orders (id, user_id, status) VALUES (1, 42, 'paid')";
    const [s] = scanInsertValues(sql);
    expect(s.table).toBe("orders");
    expect(s.columns?.map((c) => c.name)).toEqual(["id", "user_id", "status"]);
    expect(s.rows).toHaveLength(1);
    expect(vals(sql, s)).toEqual(["1", "42", "'paid'"]);
    expect(s.rows[0].count).toBe(3);
  });

  it("複数タプルと改行", () => {
    const sql = "INSERT INTO t (a,b)\nVALUES\n (1,2),\n (3,4),\n (5,6);";
    const [s] = scanInsertValues(sql);
    expect(s.rows.map((r) => r.count)).toEqual([2, 2, 2]);
    expect(vals(sql, s, 2)).toEqual(["5", "6"]);
  });

  it("関数呼び出し・入れ子の括弧・サブクエリ内のカンマで割らない", () => {
    const sql =
      "INSERT INTO t (a,b,c) VALUES (NOW(), COALESCE(x, (SELECT max(id) FROM u WHERE a IN (1,2))), 3)";
    const [s] = scanInsertValues(sql);
    expect(s.rows[0].count).toBe(3);
    expect(vals(sql, s)[2]).toBe("3");
    expect(vals(sql, s)[0]).toBe("NOW()");
  });

  it("文字列・コメントの中のカンマ・括弧・セミコロンを無視する", () => {
    const sql = "INSERT INTO t (a,b) VALUES ('x,),(;', /* , ) */ 2 -- ,\n)";
    const [s] = scanInsertValues(sql);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].count).toBe(2);
    expect(vals(sql, s)[0]).toBe("'x,),(;'");
  });

  it("'' エスケープと MySQL のバックスラッシュエスケープ", () => {
    const pg = "INSERT INTO t (a,b) VALUES ('it''s, ok', 2)";
    expect(scanInsertValues(pg, { driver: "postgres" })[0].rows[0].count).toBe(2);
    const my = "INSERT INTO t (a,b) VALUES ('a\\', b', 2)";
    expect(scanInsertValues(my, { driver: "mysql" })[0].rows[0].count).toBe(2);
    // PostgreSQL では \\ はエスケープでない: 'a\\' で文字列が閉じる。
    const pg2 = "INSERT INTO t (a,b) VALUES ('a\\', 2)";
    expect(scanInsertValues(pg2, { driver: "postgres" })[0].rows[0].count).toBe(2);
  });

  it("ドライバ別の引用符: バッククォート / ダブルクォート識別子 / $$ 文字列 / [] 識別子", () => {
    const my = 'INSERT INTO `my t` (`a,x`, `b`) VALUES ("p,q", 2)';
    const [m] = scanInsertValues(my, { driver: "mysql" });
    expect(m.table).toBe("my t");
    expect(m.columns?.map((c) => c.name)).toEqual(["a,x", "b"]);
    expect(m.rows[0].count).toBe(2);

    const pg = 'INSERT INTO "Orders" ("Id", "a""b") VALUES ($$x,)$$, $tag$y,($tag$)';
    const [p] = scanInsertValues(pg, { driver: "postgres" });
    expect(p.columns?.map((c) => c.name)).toEqual(["Id", 'a"b']);
    expect(p.rows[0].count).toBe(2);

    const sq = 'INSERT INTO t ([a b], "c") VALUES (1, 2)';
    const [q] = scanInsertValues(sq, { driver: "sqlite" });
    expect(q.columns?.map((c) => c.name)).toEqual(["a b", "c"]);
  });

  it("PostgreSQL の配列リテラルと型キャスト", () => {
    const sql = "INSERT INTO t (a,b,c) VALUES (ARRAY[1,2,3], '{1,2}'::int[], 3)";
    expect(scanInsertValues(sql, { driver: "postgres" })[0].rows[0].count).toBe(3);
  });

  it("MySQL の # コメントは MySQL のときだけ", () => {
    const sql = "INSERT INTO t (a,b) VALUES (1, # ,\n 2)";
    expect(scanInsertValues(sql, { driver: "mysql" })[0].rows[0].count).toBe(2);
  });

  it("修飾名・修飾子・別名・OR REPLACE・VALUE・ROW", () => {
    const [a] = scanInsertValues("INSERT INTO db1.t1 (a) VALUES (1)");
    expect(a.table).toBe("t1");
    expect(a.qualifier).toBe("db1");
    expect(scanInsertValues("INSERT OR REPLACE INTO t (a) VALUES (1)", { driver: "sqlite" })).toHaveLength(1);
    expect(scanInsertValues("REPLACE INTO t (a) VALUES (1)")).toHaveLength(1);
    expect(
      scanInsertValues("INSERT INTO t AS x (a) VALUES (1)", { driver: "postgres" })[0].columns,
    ).toHaveLength(1);
    expect(scanInsertValues("INSERT INTO t (a) VALUE (1)")[0].rows).toHaveLength(1);
    expect(scanInsertValues("INSERT INTO t (a, b) VALUES ROW(1, 2), ROW(3, 4)")[0].rows).toHaveLength(2);
    expect(
      scanInsertValues("INSERT INTO t (a) OVERRIDING SYSTEM VALUE VALUES (1)", { driver: "postgres" })[0]
        .rows,
    ).toHaveLength(1);
  });

  it("前の文の列リストを次の文 (列リスト省略 + OVERRIDING) へ持ち越さない", () => {
    const stmts = scanInsertValues(
      "INSERT INTO t (a) VALUES (1); INSERT INTO t OVERRIDING SYSTEM VALUE VALUES (2, 3);",
      { driver: "postgres" },
    );
    expect(stmts).toHaveLength(2);
    expect(stmts[0].columns).toHaveLength(1);
    expect(stmts[1].columns).toBeNull();
  });

  it("列リスト省略", () => {
    const sql = "INSERT INTO t VALUES (1, 2)";
    const [s] = scanInsertValues(sql);
    expect(s.columns).toBeNull();
    expect(s.rows[0].count).toBe(2);
  });

  it("対象外: SELECT / DEFAULT VALUES / SET / WITH / 括弧のサブクエリ", () => {
    expect(scanInsertValues("INSERT INTO t (a) SELECT 1")).toEqual([]);
    expect(scanInsertValues("INSERT INTO t (a) (SELECT 1)")).toEqual([]);
    expect(scanInsertValues("INSERT INTO t DEFAULT VALUES", { driver: "postgres" })).toEqual([]);
    expect(scanInsertValues("INSERT INTO t SET a = 1")).toEqual([]);
    expect(scanInsertValues("WITH x AS (SELECT 1) INSERT INTO t (a) VALUES (1)")).toEqual([]);
    expect(scanInsertValues("INSERT INTO t (select) VALUES (1)")).toEqual([]);
  });

  it("ON CONFLICT / ON DUPLICATE KEY / RETURNING 以降は読まない", () => {
    const sql = "INSERT INTO t (a,b) VALUES (1,2) ON CONFLICT (a) DO UPDATE SET b = (3,4)";
    const [s] = scanInsertValues(sql, { driver: "postgres" });
    expect(s.rows).toHaveLength(1);
  });

  it("複数の文と、INSERT 以外の文を飛ばす", () => {
    const sql =
      "SELECT 1, (2); INSERT INTO a (x) VALUES (1); UPDATE t SET a=(1,2); INSERT INTO b (y,z) VALUES (1,2);";
    const r = scanInsertValues(sql);
    expect(r.map((s) => s.table)).toEqual(["a", "b"]);
  });

  it("入力途中: 閉じていない行は `;` で打ち切って次の文を飲み込まない", () => {
    const sql = "INSERT INTO a (x,y) VALUES (1,\n; INSERT INTO b (z) VALUES (1)";
    const r = scanInsertValues(sql);
    expect(r.map((s) => s.table)).toEqual(["a", "b"]);
    expect(r[0].rows.map((x) => x.partial)).toEqual([true]);
    expect(r[1].rows).toHaveLength(1);
  });

  it("未終端の文字列・コメントはそこで止まり、例外にならない", () => {
    expect(() => scanInsertValues("INSERT INTO t (a) VALUES ('abc")).not.toThrow();
    expect(scanInsertValues("INSERT INTO t (a) VALUES (1), ('abc")[0].rows.map((x) => x.partial)).toEqual([
      false,
      true,
    ]);
    expect(scanInsertValues("/* x INSERT INTO t (a) VALUES (1)")).toEqual([]);
  });

  it("空の行・空の値", () => {
    expect(scanInsertValues("INSERT INTO t () VALUES ()")[0].rows[0].count).toBe(0);
    expect(scanInsertValues("INSERT INTO t (a,b) VALUES (1,)")[0].rows[0].count).toBe(2);
    expect(scanInsertValues("INSERT INTO t (a,b,c) VALUES (1,,3)")[0].rows[0].count).toBe(3);
  });

  it("to を超えたら止まり、範囲外の行は値を保持しない", () => {
    const rows = Array.from({ length: 100 }, (_, i) => `(${i}, ${i})`).join(",\n");
    const sql = `INSERT INTO t (a,b) VALUES\n${rows};`;
    const from = sql.indexOf("(50, 50)");
    const to = from + 20;
    const [s] = scanInsertValues(sql, { from, to });
    expect(s.rows.length).toBeLessThan(60);
    expect(s.rows[0].values).toBeNull();
    const hit = s.rows.find((r) => r.from === from);
    expect(hit?.values).toHaveLength(2);
  });

  it("maxRows で打ち切る", () => {
    const sql = "INSERT INTO t (a) VALUES (1),(2),(3),(4)";
    const [s] = scanInsertValues(sql, { maxRows: 2 });
    expect(s.rows).toHaveLength(2);
    expect(s.truncated).toBe(true);
  });

  it("1 万行の走査が現実的な時間で終わる", () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => `(${i}, 'name ${i}', NOW(), ${i * 2})`).join(",\n");
    const sql = `INSERT INTO t (id, name, at, n) VALUES\n${rows};`;
    const t0 = performance.now();
    const [s] = scanInsertValues(sql);
    const ms = performance.now() - t0;
    expect(s.rows).toHaveLength(10_000);
    expect(ms).toBeLessThan(2000);
  });
});

describe("resolveInsertColumns", () => {
  it("明示リスト優先、無ければスキーマ", () => {
    const [a] = scanInsertValues("INSERT INTO t (x, y) VALUES (1, 2)");
    expect(resolveInsertColumns(a, () => ["p", "q"])).toEqual(["x", "y"]);
    const [b] = scanInsertValues("INSERT INTO t VALUES (1, 2)");
    expect(resolveInsertColumns(b, (t) => (t === "t" ? ["p", "q"] : null))).toEqual(["p", "q"]);
    expect(resolveInsertColumns(b, none)).toBeNull();
  });
});

describe("insertValueHints", () => {
  const sql = "INSERT INTO t (a, b, c) VALUES (1, 2, 3),\n(4, 5, 6),\n(7, 8, 9);";
  const stmts = scanInsertValues(sql);

  it("cursor: カーソルのある行のタプルだけ", () => {
    const cursor = sql.indexOf("(4, 5, 6)") + 4;
    const h = insertValueHints(sql, stmts, { mode: "cursor", cursor, lookup: none });
    expect(h.map((x) => x.label)).toEqual(["a", "b", "c"]);
    expect(h.map((x) => sql.slice(x.from, x.to))).toEqual(["4", "5", "6"]);
    expect(h[0].pos).toBe(h[0].from);
  });

  it("always: 全タプル", () => {
    const h = insertValueHints(sql, stmts, { mode: "always", lookup: none });
    expect(h).toHaveLength(9);
  });

  it("複数行にまたがるタプルはどの行にカーソルがあっても全値", () => {
    const s2 = "INSERT INTO t (a, b, c) VALUES (\n  1,\n  2,\n  3\n);";
    const st = scanInsertValues(s2);
    const h = insertValueHints(s2, st, { mode: "cursor", cursor: s2.indexOf("2"), lookup: none });
    expect(h.map((x) => x.label)).toEqual(["a", "b", "c"]);
  });

  it("値が列より多いときは余りに付けない・空の値には付けない・上限", () => {
    const s2 = "INSERT INTO t (a, b) VALUES (1, 2, 3), (4,, 6)";
    const st = scanInsertValues(s2);
    const h = insertValueHints(s2, st, { mode: "always", lookup: none });
    expect(h.map((x) => x.label)).toEqual(["a", "b", "a"]);
    expect(insertValueHints(s2, st, { mode: "always", lookup: none, maxHints: 1 })).toHaveLength(1);
  });

  it("列リスト省略時はスキーマの列順を使う", () => {
    const s2 = "INSERT INTO t VALUES (1, 2)";
    const st = scanInsertValues(s2);
    const h = insertValueHints(s2, st, { mode: "always", lookup: () => ["id", "name", "x"] });
    expect(h.map((x) => x.label)).toEqual(["id", "name"]);
    expect(insertValueHints(s2, st, { mode: "always", lookup: none })).toEqual([]);
  });

  it("極端に長い 1 行は always では出さず、カーソルのあるタプルだけ出す", () => {
    const long = `INSERT INTO t (a) VALUES ${Array.from({ length: 3000 }, (_, i) => `(${i})`).join(",")};`;
    const st = scanInsertValues(long);
    expect(insertValueHints(long, st, { mode: "always", lookup: none })).toEqual([]);
    const cursor = long.indexOf("(1500)") + 2;
    const h = insertValueHints(long, st, { mode: "cursor", cursor, lookup: none });
    expect(h).toHaveLength(1);
    expect(long.slice(h[0].from, h[0].to)).toBe("1500");
  });

  it("長い列名は切り詰める", () => {
    const name = "a".repeat(40);
    expect(Array.from(truncateLabel(name))).toHaveLength(MAX_HINT_LABEL);
    expect(truncateLabel("id")).toBe("id");
  });
});

describe("insertArityIssues", () => {
  const issues = (
    sql: string,
    driver: string | null = "mysql",
    cursor?: number,
    lookup: ColumnLookup = none,
  ) => insertArityIssues(scanInsertValues(sql, { driver }), { driver, lookup, cursor });

  it("値の数が列数と合わない行を行ごとに報告する", () => {
    const sql = "INSERT INTO t (a,b,c) VALUES (1,2,3),\n(1,2),\n(1,2,3,4);";
    const r = issues(sql);
    expect(r.map((i) => [i.columns, i.values])).toEqual([
      [3, 2],
      [3, 4],
    ]);
    expect(sql.slice(r[0].from, r[0].to)).toBe("(1,2)");
  });

  it("入れ子の関数・文字列のカンマで誤検出しない", () => {
    expect(issues("INSERT INTO t (a,b) VALUES (f(1,2), 'x,y')")).toEqual([]);
  });

  it("列リスト省略: スキーマの列数と比べる。不明なら黙る", () => {
    const lookup = () => ["a", "b", "c"];
    expect(issues("INSERT INTO t VALUES (1,2)", "mysql", undefined, lookup)).toHaveLength(1);
    expect(issues("INSERT INTO t VALUES (1,2,3)", "mysql", undefined, lookup)).toEqual([]);
    expect(issues("INSERT INTO t VALUES (1,2)")).toEqual([]);
  });

  it("PostgreSQL の列リスト省略は少ない分には正常、多いときだけ報告", () => {
    const lookup = () => ["a", "b", "c"];
    expect(issues("INSERT INTO t VALUES (1,2)", "postgres", undefined, lookup)).toEqual([]);
    expect(issues("INSERT INTO t VALUES (1,2,3,4)", "postgres", undefined, lookup)).toHaveLength(1);
    // 明示リストは PostgreSQL でも一致が必要。
    expect(issues("INSERT INTO t (a,b,c) VALUES (1,2)", "postgres")).toHaveLength(1);
  });

  it("() と未完の行と入力中の行は報告しない", () => {
    expect(issues("INSERT INTO t (a) VALUES ()")).toEqual([]);
    const sql = "INSERT INTO t (a,b) VALUES (1)";
    expect(issues(sql, "mysql", sql.indexOf("1"))).toEqual([]);
    expect(issues(`${sql} `, "mysql", sql.length + 1)).toHaveLength(1);
  });

  it("SQLite の FTS 特殊コマンドは対象外", () => {
    expect(issues("INSERT INTO docs(docs) VALUES('optimize')", "sqlite")).toEqual([]);
    expect(issues("INSERT INTO docs(docs, rank) VALUES('rank', 'bm25(10.0)')", "sqlite")).toEqual([]);
  });

  it("上限件数", () => {
    const sql = `INSERT INTO t (a,b) VALUES ${Array.from({ length: 50 }, () => "(1)").join(",")}`;
    const r = insertArityIssues(scanInsertValues(sql), { lookup: none, max: 5 });
    expect(r).toHaveLength(5);
  });
});

describe("partial 行 (入力中の閉じていないタプル) (#2424 review)", () => {
  it("文書末尾で閉じていない行を途中の行として残す", () => {
    const sql = "INSERT INTO t (a,b,c) VALUES (1, 'x', ";
    const [s] = scanInsertValues(sql);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].partial).toBe(true);
    expect(s.rows[0].count).toBe(2);
    expect(vals(sql, s)).toEqual(["1", "'x'"]);
    // 警告は出さない
    expect(insertArityIssues([s], { lookup: none })).toEqual([]);
  });

  it("`;` で閉じていない行も残し、次の文は読む", () => {
    const sql = "INSERT INTO a (x,y) VALUES (1,\n; INSERT INTO b (z) VALUES (1)";
    const r = scanInsertValues(sql);
    expect(r[0].rows).toHaveLength(1);
    expect(r[0].rows[0].partial).toBe(true);
    expect(r[0].rows[0].count).toBe(1);
    expect(r[1].rows[0].partial).toBe(false);
  });

  it("未終端の文字列の手前までの値は残る", () => {
    const sql = "INSERT INTO t (a,b) VALUES (1, 'abc";
    const [s] = scanInsertValues(sql);
    expect(s.rows[0].partial).toBe(true);
    expect(vals(sql, s)).toEqual(["1"]);
  });

  it("表示範囲の下端で切れたタプルは、そこまでの値をヒントにできる", () => {
    const sql = "INSERT INTO t (a,b,c) VALUES (1, 2, 3), (4, 5, 6)";
    const to = sql.indexOf("5") + 1;
    const text = sql.slice(0, to);
    const stmts = scanInsertValues(text, { to });
    const h = insertValueHints(text, stmts, { mode: "always", lookup: none });
    expect(h.map((x) => x.label)).toEqual(["a", "b", "c", "a", "b"]);
  });
});

describe("PostgreSQL の入れ子ブロックコメント", () => {
  it("postgres は深さを数え、他は最初の */ で閉じる", () => {
    const sql = "INSERT INTO t (a,b) VALUES (1, /* x /* y */ , 9 */ 2)";
    expect(scanInsertValues(sql, { driver: "postgres" })[0].rows[0].count).toBe(2);
    // MySQL では最初の */ で閉じるので、`, 9 */ 2` が値として残る。
    expect(scanInsertValues(sql, { driver: "mysql" })[0].rows[0].count).toBe(3);
  });
});

describe("seek (表示範囲だけを読む)", () => {
  const cols = ["id", "name", "email", "status", "total"];
  const row = (i: number) => `(${i}, 'user_${i}', 'm${i}@x.com', 'paid, ok', ${i * 3.5})`;
  const header = `INSERT INTO orders (${cols.join(",")}) VALUES`;
  const sep: Record<string, string> = { multi: ",\n", dense: ",", indent: ",\n  " };

  for (const style of Object.keys(sep)) {
    it(`${style}: seek と全走査で表示範囲のタプルが一致する`, () => {
      const doc = `${header}\n${Array.from({ length: 10_000 }, (_, i) => row(i)).join(sep[style])};\n`;
      const from = doc.length - 1500;
      const to = doc.length;
      const full = scanInsertValues(doc, { from, to })[0];
      const seek = scanInsertValues(doc, { from, to, seek: true })[0];
      const pick = (s: InsertStatement) => s.rows.filter((r) => r.values).map((r) => [r.from, r.to, r.count]);
      expect(pick(seek)).toEqual(pick(full));
      expect(seek.columns?.map((c) => c.name)).toEqual(cols);
      expect(seek.rows.length).toBeLessThan(100);
    });
  }

  it("複数の文の途中でも、直前の文の先頭から読んで同じ結果になる", () => {
    const small = Array.from({ length: 2000 }, (_, i) => `INSERT INTO a (x,y) VALUES (${i}, ${i});`).join(
      "\n",
    );
    const doc = `${small}\nINSERT INTO b (p,q) VALUES (1, 2),\n(3, 4);`;
    const from = doc.length - 12;
    const seek = scanInsertValues(doc, { from, to: doc.length, seek: true });
    expect(seek.at(-1)?.table).toBe("b");
    expect(seek.at(-1)?.rows.at(-1)?.count).toBe(2);
  });

  it("1.1MB・末尾付近の走査は数十 ms 以内 (全走査の 1/10 未満)", () => {
    const wide = (i: number) =>
      `(${i}, 'user_${i}', 'mail${i}@example.com', 'paid', ${i * 3.5}, NOW(), NULL, 'note with (paren), comma', ${i % 7}, 'x')`;
    const doc = `INSERT INTO orders (a,b,c,d,e,f,g,h,i,j) VALUES\n${Array.from({ length: 10_000 }, (_, i) => wide(i)).join(",\n")};\n`;
    expect(doc.length).toBeGreaterThan(1_000_000);
    const from = doc.length - 3000;
    const run = () => {
      const t0 = performance.now();
      scanInsertValues(doc, { from, to: doc.length, seek: true });
      return performance.now() - t0;
    };
    run();
    const best = Math.min(run(), run(), run());
    expect(best).toBeLessThan(40);
  });
});

describe("ddlTargetTables / buildColumnIndex / indexLookup", () => {
  it("CREATE / ALTER / DROP / RENAME の対象表を集める", () => {
    const sql = [
      "DROP TABLE IF EXISTS `users`;",
      'CREATE TABLE IF NOT EXISTS "app"."Orders" (id int);',
      "ALTER TABLE items ADD COLUMN x int;",
      "RENAME TABLE a TO b, c TO d;",
      "ALTER TABLE old RENAME TO fresh;",
      "CREATE TEMPORARY TABLE tmp1 (x int);",
      "INSERT INTO plain VALUES (1);",
    ].join("\n");
    const t = ddlTargetTables(sql);
    for (const n of ["users", "orders", "items", "a", "b", "c", "d", "old", "fresh", "tmp1"])
      expect(t.has(n)).toBe(true);
    expect(t.has("plain")).toBe(false);
    expect(ddlTargetTables("SELECT 1").size).toBe(0);
  });

  it("空白や記号を含む引用符付きの表名を丸ごと拾う", () => {
    const t = ddlTargetTables(
      'ALTER TABLE `order items` ADD COLUMN b int; CREATE TABLE "app"."my-table" (x int); DROP TABLE [old one], `x y`;',
    );
    for (const n of ["order items", "my-table", "old one", "x y"]) expect(t.has(n)).toBe(true);
    expect(t.has("order")).toBe(false);
  });

  it("DDL の対象表の列数は引かない (列リスト省略の INSERT は警告もヒントもしない)", () => {
    const index = buildColumnIndex([{ name: "users", columns: ["id", "name", "mail"] }]);
    const sql = "DROP TABLE IF EXISTS users;\nCREATE TABLE users (id int);\nINSERT INTO users VALUES (1);";
    const stmts = scanInsertValues(sql);
    const withDdl = indexLookup(index, "app", ddlTargetTables(sql));
    expect(insertArityIssues(stmts, { lookup: withDdl })).toEqual([]);
    expect(insertValueHints(sql, stmts, { mode: "always", lookup: withDdl })).toEqual([]);
    // DDL が無ければ従来どおり警告する。
    expect(insertArityIssues(stmts, { lookup: indexLookup(index, "app") })).toHaveLength(1);
    // 明示の列リストは DDL の対象でも検査できる。
    const explicit = scanInsertValues("ALTER TABLE users ADD x int;\nINSERT INTO users (a,b) VALUES (1);");
    expect(insertArityIssues(explicit, { lookup: withDdl })).toHaveLength(1);
  });

  it("大文字小文字違いの同名表は衝突として null、概観で列が空なら schemaTable で補う", () => {
    const index = buildColumnIndex(
      [
        { name: "Users", columns: ["a"] },
        { name: "users", columns: ["a", "b"] },
        { name: "empty", columns: [] },
      ],
      { name: "empty", columns: ["p", "q"] },
    );
    expect(index.get("users")).toBeNull();
    expect(index.get("empty")).toEqual(["p", "q"]);
    expect(indexLookup(index, "app")("users", null)).toBeNull();
    expect(indexLookup(index, "app")("empty", "other")).toBeNull();
    expect(indexLookup(index, "app")("empty", "app")).toEqual(["p", "q"]);
  });
});
