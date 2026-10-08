import { describe, it, expect } from "vitest";
import { derivedCompletions } from "../components/sqlDerivedCompletion";

/** カーソルは文末 (= 入力直後) に置く。 */
const run = (text: string, driver = "mysql") =>
  derivedCompletions({ driver, text, pos: text.length });

const labels = (text: string, driver = "mysql") =>
  run(text, driver)?.options.map((o) => o.label) ?? null;

describe("derivedCompletions: CTE", () => {
  it("SELECT 句で CTE 名と、その列の修飾子付き候補を出す", () => {
    const text = "WITH x AS (SELECT a, b FROM t) SELECT ";
    const r = run(text);
    expect(r?.from).toBe(text.length);
    expect(r?.options.map((o) => o.label)).toEqual(["x", "x.a", "x.b"]);
  });

  it("`x.` の後は CTE の列だけを出し、from は修飾子の先頭にする", () => {
    const text = "WITH x AS (SELECT a, b FROM t) SELECT x.";
    const r = run(text);
    expect(r?.from).toBe(text.length - 2);
    expect(r?.options).toEqual([
      { label: "x.a", apply: "x.a", type: "property", detail: "CTE" },
      { label: "x.b", apply: "x.b", type: "property", detail: "CTE" },
    ]);
  });

  it("入力途中の列名 (x.b) でも修飾子の先頭から置換する", () => {
    const text = "WITH x AS (SELECT a, b FROM t) SELECT x.b";
    const r = run(text);
    expect(r?.from).toBe(text.length - 3);
    expect(r?.options.map((o) => o.label)).toEqual(["x.a", "x.b"]);
  });

  it("FROM / JOIN の位置では CTE 名だけを出す (列は出さない)", () => {
    const text =
      "WITH x AS (SELECT a FROM t), y AS (SELECT b FROM u) SELECT * FROM ";
    expect(labels(text)).toEqual(["x", "y"]);
    const joined = `${text}x JOIN `;
    expect(labels(joined)).toEqual(["x", "y"]);
  });

  it("FROM の入力途中の語は from をその語の先頭に置く", () => {
    const text = "WITH x AS (SELECT a FROM t) SELECT * FROM x";
    const r = run(text);
    expect(r?.from).toBe(text.length - 1);
    expect(r?.options.map((o) => o.label)).toEqual(["x"]);
  });

  it("`FROM t |` のように表の後ろは CTE 名を出さない", () => {
    expect(labels("WITH x AS (SELECT a FROM t) SELECT * FROM t ")).toBeNull();
  });

  it("SELECT * の CTE は名前だけ出し、列は出さない", () => {
    const text = "WITH x AS (SELECT * FROM t) SELECT ";
    expect(labels(text)).toEqual(["x"]);
    expect(labels("WITH x AS (SELECT * FROM t) SELECT x.")).toBeNull();
  });

  it("t.* を含む CTE も列を出さない", () => {
    expect(labels("WITH x AS (SELECT t.*, a FROM t) SELECT x.")).toBeNull();
  });

  it("明示された列リストを優先する", () => {
    expect(labels("WITH x(p, q) AS (SELECT * FROM t) SELECT x.")).toEqual(["x.p", "x.q"]);
  });

  it("UNION を含む CTE は列を出さない (名前は出す)", () => {
    const text = "WITH x AS (SELECT a FROM t UNION SELECT b FROM u) SELECT ";
    expect(labels(text)).toEqual(["x"]);
    expect(labels("WITH x AS (SELECT a FROM t UNION SELECT b FROM u) SELECT x.")).toBeNull();
  });

  it("名前の無い式 (count(*) や a + b) は列にしない", () => {
    expect(labels("WITH x AS (SELECT count(*), a + b FROM t) SELECT x.")).toBeNull();
  });

  it("定義中の CTE 自身の本体では補完しない", () => {
    expect(labels("WITH x AS (SELECT x.")).toBeNull();
  });

  it("別の文の CTE は見えない", () => {
    expect(labels("WITH x AS (SELECT a FROM t); SELECT x.")).toBeNull();
    expect(labels("SELECT 1; WITH x AS (SELECT a FROM t) SELECT x.")).toEqual(["x.a"]);
  });

  it("後続の CTE は先行する CTE の列を参照できる", () => {
    const text = "WITH x AS (SELECT a FROM t), y AS (SELECT x. FROM x) SELECT 1";
    const cursor = text.indexOf("x. FROM") + 2;
    const r = derivedCompletions({ driver: "mysql", text, pos: cursor });
    expect(r?.options.map((o) => o.label)).toEqual(["x.a"]);
  });

  it("PostgreSQL の引用識別子は引用付きで挿入する", () => {
    const text = 'WITH "Xy" AS (SELECT "Col" AS "Mixed Name" FROM t) SELECT Xy.';
    const r = run(text, "postgres");
    expect(r?.options).toEqual([
      { label: "Xy.Mixed Name", apply: '"Xy"."Mixed Name"', type: "property", detail: "CTE" },
    ]);
  });
});

describe("derivedCompletions: FROM (subquery) の別名", () => {
  it("派生表の列を d.col として出す (SELECT 句でも WHERE でも)", () => {
    expect(labels("SELECT * FROM (SELECT a, b AS c FROM t) d WHERE d.")).toEqual(["d.a", "d.c"]);
    const text = "SELECT d. FROM (SELECT a, b AS c FROM t) d";
    const cursor = text.indexOf("d.") + 2;
    const r = derivedCompletions({ driver: "mysql", text, pos: cursor });
    expect(r?.options.map((o) => o.label)).toEqual(["d.a", "d.c"]);
  });

  it("AS を付けた別名と、表の別名の後ろの位置でも認識する", () => {
    expect(labels("SELECT * FROM (SELECT a FROM t) AS d WHERE d.")).toEqual(["d.a"]);
  });

  it("派生表の別名は修飾子としても候補に出る (列が無くても)", () => {
    expect(labels("SELECT * FROM (SELECT * FROM t) d WHERE ")).toEqual(["d"]);
  });

  it("FROM 句では派生表の別名を表名として出さない", () => {
    expect(labels("SELECT * FROM (SELECT a FROM t) d JOIN ")).toBeNull();
  });

  it("入力中の別名そのものは候補にしない", () => {
    expect(labels("SELECT * FROM (SELECT a FROM t) d")).toBeNull();
  });

  it("別名の無い派生表は対象外", () => {
    expect(labels("SELECT * FROM (SELECT a FROM t) WHERE d.")).toBeNull();
  });

  it("兄弟のサブクエリの中で定義された別名は見せない", () => {
    const text =
      "SELECT * FROM t WHERE x IN (SELECT a FROM (SELECT a FROM u) s) AND s.";
    expect(labels(text)).toBeNull();
  });

  it("SELECT 本体が解釈できない派生表は列を出さない", () => {
    expect(labels("SELECT * FROM (VALUES (1)) v WHERE v.")).toBeNull();
  });
});

describe("derivedCompletions: SELECT 別名", () => {
  const text = "SELECT a, count(*) AS n, b c FROM t ORDER BY ";

  it("ORDER BY では SELECT の別名 (AS 付き・素の別名) を出し、列名は出さない", () => {
    expect(labels(text)).toEqual(["n", "c"]);
  });

  it("GROUP BY でも別名を出す", () => {
    expect(labels("SELECT a AS n FROM t GROUP BY ", "postgres")).toEqual(["n"]);
  });

  it("WHERE の別名は MySQL / SQLite だけ出し、PostgreSQL では出さない", () => {
    const t = "SELECT a AS n FROM t WHERE ";
    expect(labels(t, "mysql")).toEqual(["n"]);
    expect(labels(t, "sqlite")).toEqual(["n"]);
    expect(labels(t, "postgres")).toBeNull();
  });

  it("SELECT 句の中では別名を出さない", () => {
    expect(labels("SELECT a AS n, ")).toBeNull();
  });

  it("式の途中の語は別名と誤認しない (a IS NULL / x BETWEEN 1 AND 2)", () => {
    expect(labels("SELECT a IS NULL FROM t ORDER BY ")).toBeNull();
    expect(labels("SELECT x BETWEEN 1 AND 2 FROM t ORDER BY ")).toBeNull();
  });

  it("別名は外側の SELECT のものだけ (サブクエリの別名を素の名前で混ぜない)", () => {
    // 派生表 s の列 inner_n は s.inner_n としてのみ出る。素の inner_n は出さない。
    const t = "SELECT * FROM (SELECT a AS inner_n FROM t) s ORDER BY ";
    expect(labels(t)).toEqual(["s", "s.inner_n"]);
  });
});

describe("derivedCompletions: 出さない文脈", () => {
  it("文字列リテラルの中では補完しない", () => {
    expect(labels("WITH x AS (SELECT a FROM t) SELECT 'x.")).toBeNull();
    expect(labels("WITH x AS (SELECT a FROM t) SELECT 'a", "mysql")).toBeNull();
  });

  it("コメントの中では補完しない", () => {
    expect(labels("WITH x AS (SELECT a FROM t) -- SELECT x.")).toBeNull();
    expect(labels("WITH x AS (SELECT a FROM t) /* SELECT x.")).toBeNull();
  });

  it("コメントの後ろの本文では補完する", () => {
    expect(labels("WITH x AS (SELECT a FROM t) -- note\nSELECT x.")).toEqual(["x.a"]);
  });

  it("文字列に含まれる WITH は CTE として扱わない", () => {
    expect(labels("SELECT 'WITH x AS (SELECT a FROM t) ' ")).toBeNull();
  });

  it("3 段の修飾子 (db.x.) は扱わない", () => {
    expect(labels("WITH x AS (SELECT a FROM t) SELECT db.x.")).toBeNull();
  });
});
