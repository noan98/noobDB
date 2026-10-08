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
      { label: "x.a", apply: "x.a", type: "property", kind: "cte" },
      { label: "x.b", apply: "x.b", type: "property", kind: "cte" },
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
      { label: "Xy.Mixed Name", apply: '"Xy"."Mixed Name"', type: "property", kind: "cte" },
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

  it("WHERE の別名は SQLite だけ出す (MySQL / PostgreSQL は Unknown column になるので出さない)", () => {
    const t = "SELECT a AS n FROM t WHERE ";
    expect(labels(t, "mysql")).toBeNull();
    expect(labels(t, "sqlite")).toEqual(["n"]);
    expect(labels(t, "postgres")).toBeNull();
  });

  it("HAVING の別名は MySQL / SQLite で出し、PostgreSQL では出さない", () => {
    const t = "SELECT a AS n FROM t GROUP BY a HAVING ";
    expect(labels(t, "mysql")).toEqual(["n"]);
    expect(labels(t, "sqlite")).toEqual(["n"]);
    expect(labels(t, "postgres")).toBeNull();
  });

  it("候補の種別 (kind) を返し、別名は alias として区別する", () => {
    const r = run("SELECT a AS n FROM t ORDER BY ");
    expect(r?.options).toEqual([{ label: "n", apply: "n", type: "variable", kind: "alias" }]);
  });

  it("派生表の候補は derived、CTE は cte の種別を持つ", () => {
    const r = run("WITH x AS (SELECT a FROM t) SELECT * FROM (SELECT b FROM u) d WHERE ");
    expect(r?.options.map((o) => [o.label, o.kind])).toEqual([
      ["x", "cte"],
      ["x.a", "cte"],
      ["d", "derived"],
      ["d.b", "derived"],
    ]);
  });

  it("SELECT 句の中では別名を出さない", () => {
    expect(labels("SELECT a AS n, ")).toBeNull();
  });

  it("式の途中の語は別名と誤認しない (a IS NULL / x BETWEEN 1 AND 2)", () => {
    expect(labels("SELECT a IS NULL FROM t ORDER BY ")).toBeNull();
    expect(labels("SELECT x BETWEEN 1 AND 2 FROM t ORDER BY ")).toBeNull();
  });

  it("SELECT a AS の命名位置では候補を出さない", () => {
    expect(labels("WITH x AS (SELECT a FROM t) SELECT a AS ")).toBeNull();
    expect(labels("WITH x AS (SELECT a FROM t) SELECT a AS n")).toBeNull();
  });

  it("別名は外側の SELECT のものだけ (サブクエリの別名を素の名前で混ぜない)", () => {
    // 派生表 s の列 inner_n は s.inner_n としてのみ出る。素の inner_n は出さない。
    const t = "SELECT * FROM (SELECT a AS inner_n FROM t) s ORDER BY ";
    expect(labels(t)).toEqual(["s", "s.inner_n"]);
  });
});

describe("derivedCompletions: 括弧の中の文脈 (関数・式)", () => {
  it("関数引数の中でも CTE の列を出す", () => {
    expect(labels("WITH x AS (SELECT a, b FROM t) SELECT sum(x.")).toEqual(["x.a", "x.b"]);
  });

  it("式の括弧の中でも句 (WHERE) の文脈で列を出す", () => {
    expect(labels("WITH x AS (SELECT a, b FROM t) SELECT * FROM t WHERE (x.")).toEqual([
      "x.a",
      "x.b",
    ]);
  });

  it("IN リストの途中でも外側の WHERE の文脈で列を出す", () => {
    expect(
      labels("WITH x AS (SELECT a, b FROM t) SELECT * FROM t WHERE x.a IN (1, x."),
    ).toEqual(["x.a", "x.b"]);
  });

  it("関数引数の中の派生表の別名を出す", () => {
    expect(labels("SELECT * FROM (SELECT a FROM t) d WHERE coalesce(d.")).toEqual(["d.a"]);
  });
});

describe("derivedCompletions: 集合演算・ロック語を別名にしない", () => {
  it("別名の無い派生表の直後の EXCEPT / INTERSECT を別名と誤認しない", () => {
    expect(labels("SELECT * FROM (SELECT a FROM t) EXCEPT SELECT ")).toBeNull();
    expect(labels("SELECT * FROM (SELECT a FROM t) INTERSECT SELECT ")).toBeNull();
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

describe("derivedCompletions: PostgreSQL の ORDER BY / GROUP BY は項目の先頭だけ別名", () => {
  const sel = "SELECT a AS n FROM t ";

  it("関数引数・式の途中では別名を出さない (PostgreSQL)", () => {
    expect(labels(`${sel}ORDER BY abs(`, "postgres")).toBeNull();
    expect(labels(`${sel}ORDER BY n + `, "postgres")).toBeNull();
    expect(labels(`${sel}GROUP BY abs(`, "postgres")).toBeNull();
  });

  it("項目の先頭 (BY 直後・カンマ直後) では別名を出す (PostgreSQL)", () => {
    expect(labels(`${sel}ORDER BY `, "postgres")).toEqual(["n"]);
    expect(labels(`${sel}ORDER BY a, `, "postgres")).toEqual(["n"]);
    expect(labels(`${sel}GROUP BY `, "postgres")).toEqual(["n"]);
  });

  it("MySQL / SQLite は関数引数の中でも従来どおり別名を出す", () => {
    expect(labels(`${sel}ORDER BY abs(`, "mysql")).toEqual(["n"]);
    expect(labels(`${sel}ORDER BY abs(`, "sqlite")).toEqual(["n"]);
  });
});

describe("derivedCompletions: 方言つきの文字列・コメント (#1419)", () => {
  it("MySQL のバックスラッシュエスケープ '...\\'...' の後も CTE 補完が効く", () => {
    const text = "WITH x AS (SELECT a FROM t WHERE c = 'a\\'b') SELECT x.";
    expect(labels(text, "mysql")).toEqual(["x.a"]);
  });

  it("MySQL の # コメント (中の ' を含む) の後も CTE 補完が効く", () => {
    const text = "# don't\nWITH x AS (SELECT a FROM t) SELECT x.";
    expect(labels(text, "mysql")).toEqual(["x.a"]);
  });

  it("PostgreSQL のドル引用 $$...$$ (中の ' を含む) の後も CTE 補完が効く", () => {
    const text = "WITH x AS (SELECT a FROM t WHERE c = $$it's$$) SELECT x.";
    expect(labels(text, "postgres")).toEqual(["x.a"]);
  });

  it("PostgreSQL のドル引用の後の派生表補完も効く", () => {
    const text = "SELECT $$it's$$ AS z FROM (SELECT a FROM t) d WHERE d.";
    expect(labels(text, "postgres")).toEqual(["d.a"]);
  });

  it("引用識別子の中の -- や ' は文字列扱いしない", () => {
    const text = 'WITH "a--b" AS (SELECT "it\'s" FROM t) SELECT ';
    // ラベルは引用を外した名前。挿入時は apply 側で引用し直す。
    expect(labels(text, "postgres")).toEqual(["a--b", "a--b.it's"]);
  });
});

describe("derivedCompletions: UNION 等の枝をまたがない (#1419)", () => {
  it("別の枝の派生表の列を出さない", () => {
    expect(labels("SELECT d.a FROM (SELECT a FROM t) d UNION SELECT d.")).toBeNull();
    expect(labels("SELECT d.a FROM (SELECT a FROM t) d UNION ALL SELECT d.")).toBeNull();
  });

  it("同じ枝の派生表は出す", () => {
    expect(
      labels("SELECT a FROM u UNION SELECT * FROM (SELECT b FROM t) d WHERE d."),
    ).toEqual(["d.b"]);
  });

  it("CTE は WITH が全枝に効くので、どの枝でも出す", () => {
    expect(labels("WITH x AS (SELECT a FROM t) SELECT 1 UNION SELECT x.")).toEqual(["x.a"]);
  });

  it("SELECT 別名は同じ枝のものだけ出す (WHERE は SQLite)", () => {
    const t = "SELECT a AS n FROM t UNION SELECT b AS m FROM u WHERE ";
    expect(labels(t, "sqlite")).toEqual(["m"]);
  });

  it("UNION の後ろの ORDER BY (全枝にかかる) では別名を出さない", () => {
    expect(labels("SELECT a AS n FROM t UNION SELECT b AS m FROM u ORDER BY ")).toBeNull();
  });
});

describe("derivedCompletions: 方言の引用と大きな入力 (#1419 再レビュー)", () => {
  it("MySQL の \"...\" は文字列なので、中の FROM (...) e は派生表として見ない", () => {
    const text = 'SELECT * FROM t WHERE note = "FROM (SELECT z FROM q) e" AND e.';
    expect(labels(text, "mysql")).toBeNull();
  });

  it("PostgreSQL / SQLite の \"...\" は識別子のまま (修飾子として使える)", () => {
    const text = 'SELECT * FROM (SELECT z FROM q) e WHERE "e".';
    expect(labels(text, "postgres")).toEqual(['"e".z']);
    expect(labels(text, "sqlite")).toEqual(['"e".z']);
  });

  it("カーソルが文字列の途中で、後ろで閉じていても補完しない (1 回のマスクで判定)", () => {
    const text = "WITH x AS (SELECT a FROM t) SELECT 'x.' AS s";
    const pos = text.indexOf("x.") + 2;
    expect(derivedCompletions({ driver: "mysql", text, pos })).toBeNull();
  });

  it("大きな 1 文 (約 1MB) でも例外なく、CTE の列を出す", () => {
    const text = `WITH x AS (SELECT a, b FROM t) SELECT ${"a, ".repeat(300000)}x.`;
    expect(text.length).toBeGreaterThan(900_000);
    expect(labels(text)).toEqual(["x.a", "x.b"]);
  });

  it("大きな文書 (約 1MB、多数の文) の末尾でも例外なく補完する", () => {
    const head = "SELECT 1 FROM t WHERE c = 'x';\n".repeat(36000);
    const text = `${head}WITH x AS (SELECT a, b FROM t) SELECT x.`;
    expect(text.length).toBeGreaterThan(900_000);
    expect(labels(text)).toEqual(["x.a", "x.b"]);
  });
});

describe("derivedCompletions: MySQL の \"…\" と空白名・境界 (#1419 再レビュー)", () => {
  it("MySQL では \"abc\" (文字列扱い) を列名にせず、空白の名前を出さない", () => {
    const text = 'WITH x AS (SELECT "abc", b FROM t) SELECT x.';
    expect(labels(text, "mysql")).toEqual(["x.b"]);
  });

  it("MySQL で空白だけに潰れた名前は候補にしない (各箇所)", () => {
    expect(labels('SELECT * FROM (SELECT "k" FROM t) d WHERE d.', "mysql")).toBeNull();
    expect(labels('WITH "x" AS (SELECT a FROM t) SELECT * FROM ', "mysql")).toBeNull();
    // MySQL では "p" は文字列で列名として不正なので、列リスト全体を解釈不能として列を出さない。
    expect(labels('WITH x("p", q) AS (SELECT a, b FROM t) SELECT x.', "mysql")).toBeNull();
    expect(labels('SELECT * FROM (SELECT a FROM t) AS "d" WHERE ', "mysql")).toBeNull();
    expect(labels('SELECT "abc" n, a AS "m" FROM t ORDER BY ', "mysql")).toEqual(["n"]);
  });

  it("PostgreSQL の \"abc\" は従来どおり名前として出る", () => {
    expect(labels('WITH x AS (SELECT "abc", b FROM t) SELECT x.', "postgres")).toEqual([
      'x.abc',
      "x.b",
    ]);
  });

  it("2 文字記号 (-- など) の間に立つカーソルでは補完しない", () => {
    const text = "SELECT x.a -- FROM (SELECT z FROM q) e";
    const pos = text.indexOf("--") + 1;
    expect(derivedCompletions({ driver: "mysql", text, pos })).toBeNull();
  });

  it("$ の直前では補完しない", () => {
    const text = "WITH x AS (SELECT a FROM t) SELECT $$x.$$";
    const pos = text.indexOf("$$x") ;
    expect(derivedCompletions({ driver: "postgres", text, pos })).toBeNull();
  });

  it("長い AND の連続の後の裸の AND でも修飾子候補を出す", () => {
    const cond = " AND x.a <> 0".repeat(30);
    const text = `WITH x AS (SELECT a, b FROM t) SELECT * FROM t WHERE x.a = 1${cond} AND `;
    const got = labels(text) ?? [];
    expect(got).toContain("x.a");
    expect(got).toContain("x");
  });
});
