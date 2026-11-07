import { describe, expect, it } from "vitest";
import {
  extractNativeParams,
  extractQueryParams,
  parsePastedValues,
  scanNativePlaceholders,
  substituteAllParams,
  substituteNativePlaceholders,
  findQuotedParams,
  isNumericParam,
  renderParamValue,
  substituteQueryParams,
} from "../queryParams";

// {{variable}} クエリパラメータの検出と、ドライバ別・型別の安全な展開。
// SQL インジェクション防止が機能の核なので、エスケープ経路を重点的に検証する。

describe("extractQueryParams", () => {
  it("出現順に一意な変数名を抽出する", () => {
    expect(extractQueryParams("SELECT * FROM {{tbl}} WHERE id = {{id}} OR ref = {{id}}")).toEqual([
      "tbl",
      "id",
    ]);
  });

  it("プレースホルダーが無ければ空配列", () => {
    expect(extractQueryParams("SELECT 1")).toEqual([]);
  });

  it("単一の波括弧やスペース入りは検出しない", () => {
    expect(extractQueryParams("SELECT {x}, {{ y }}, {{z}}")).toEqual(["z"]);
  });
});

describe("isNumericParam", () => {
  it("数値リテラルを判定する", () => {
    expect(isNumericParam("5")).toBe(true);
    expect(isNumericParam("-3.14")).toBe(true);
    expect(isNumericParam("1e3")).toBe(true);
    expect(isNumericParam("  42 ")).toBe(true);
    expect(isNumericParam("")).toBe(false);
    expect(isNumericParam("5; DROP TABLE t")).toBe(false);
    expect(isNumericParam("abc")).toBe(false);
  });
});

describe("renderParamValue", () => {
  it("text はクオート文字列としてエスケープする", () => {
    expect(renderParamValue("mysql", "alice", "text")).toBe("'alice'");
    // シングルクオートは二重化される。
    expect(renderParamValue("mysql", "O'Brien", "text")).toBe("'O''Brien'");
    // MySQL ではバックスラッシュも二重化 (Postgres/SQLite は素のまま)。
    expect(renderParamValue("mysql", "a\\b", "text")).toBe("'a\\\\b'");
    expect(renderParamValue("postgres", "a\\b", "text")).toBe("'a\\b'");
  });

  it("text はインジェクション試行を中和する", () => {
    const evil = "x'); DROP TABLE users; --";
    const out = renderParamValue("mysql", evil, "text");
    // 全体が 1 個のクオート文字列に収まり、内側のクオートは二重化されている。
    expect(out).toBe("'x''); DROP TABLE users; --'");
    expect(out.startsWith("'")).toBe(true);
    expect(out.endsWith("'")).toBe(true);
  });

  it("text のシングルクオートエスケープは全 3 方言で同一", () => {
    // シングルクオートの二重化は方言非依存 (バックスラッシュのみ MySQL 固有)。
    for (const driver of ["mysql", "postgres", "sqlite"] as const) {
      expect(renderParamValue(driver, "O'Brien", "text")).toBe("'O''Brien'");
    }
  });

  it("text はバックスラッシュを MySQL でのみ二重化する", () => {
    // Postgres/SQLite は standard_conforming_strings 既定下でバックスラッシュを
    // 通常文字として扱うため、二重化するとデータが壊れる。
    expect(renderParamValue("mysql", "a\\b", "text")).toBe("'a\\\\b'");
    expect(renderParamValue("postgres", "a\\b", "text")).toBe("'a\\b'");
    expect(renderParamValue("sqlite", "a\\b", "text")).toBe("'a\\b'");
  });

  it("text は改行・タブ・Unicode をそのままリテラルに通す", () => {
    // 改行/タブ/マルチバイトはエスケープ対象ではない。クオート文字でなければ
    // 素通しされ、外側のクオートで安全に閉じ込められる。
    expect(renderParamValue("postgres", "line1\nline2\tend", "text")).toBe("'line1\nline2\tend'");
    expect(renderParamValue("mysql", "café—日本語😀", "text")).toBe("'café—日本語😀'");
    // Unicode に紛れたシングルクオートも確実に二重化される。
    expect(renderParamValue("sqlite", "naïve's", "text")).toBe("'naïve''s'");
  });

  it("number は裸の数値、非数値は安全なクオート文字列にフォールバックする", () => {
    expect(renderParamValue("mysql", "100", "number")).toBe("100");
    expect(renderParamValue("mysql", "-2.5", "number")).toBe("-2.5");
    // 数値でない入力は裸で入れず、クオートして無害化する。
    expect(renderParamValue("mysql", "1 OR 1=1", "number")).toBe("'1 OR 1=1'");
  });

  it("identifier はドライバ別のクオート識別子になる", () => {
    expect(renderParamValue("mysql", "users", "identifier")).toBe("`users`");
    expect(renderParamValue("postgres", "users", "identifier")).toBe('"users"');
    expect(renderParamValue("sqlite", "users", "identifier")).toBe('"users"');
    // クオート文字は二重化される。
    expect(renderParamValue("mysql", "ev`il", "identifier")).toBe("`ev``il`");
    expect(renderParamValue("postgres", 'ev"il', "identifier")).toBe('"ev""il"');
  });
});

describe("substituteQueryParams", () => {
  it("型に応じて全プレースホルダーを置換する", () => {
    const sql = "SELECT * FROM {{tbl}} WHERE id = {{id}} AND name = {{name}}";
    const out = substituteQueryParams(
      sql,
      "mysql",
      { tbl: "users", id: "42", name: "alice" },
      { tbl: "identifier", id: "number", name: "text" },
    );
    expect(out).toBe("SELECT * FROM `users` WHERE id = 42 AND name = 'alice'");
  });

  it("同じ変数の複数出現をすべて置換する", () => {
    const out = substituteQueryParams("SELECT {{x}} WHERE a = {{x}}", "postgres", { x: "v" }, { x: "text" });
    expect(out).toBe("SELECT 'v' WHERE a = 'v'");
  });

  it("値が無い変数はそのまま残す", () => {
    const out = substituteQueryParams("SELECT {{a}}, {{b}}", "mysql", { a: "1" }, { a: "number" });
    expect(out).toBe("SELECT 1, {{b}}");
  });

  it("型未指定の変数は text として扱う", () => {
    const out = substituteQueryParams("SELECT {{a}}", "mysql", { a: "hi" }, {});
    expect(out).toBe("SELECT 'hi'");
  });
});

describe("findQuotedParams (#1615)", () => {
  it("引用符で直接囲まれたプレースホルダだけを初出順で返す", () => {
    expect(findQuotedParams("WHERE a = '{{a}}' AND b = {{b}} AND c = \"{{c}}\" AND a2 = '{{a}}'")).toEqual([
      "a",
      "c",
    ]);
    expect(findQuotedParams("SELECT `{{col}}` FROM t")).toEqual(["col"]);
  });

  it("囲んでいない・文字列の途中・閉じ引用符が違うものは対象外", () => {
    expect(findQuotedParams("WHERE id = {{id}}")).toEqual([]);
    expect(findQuotedParams("LIKE '%{{q}}%'")).toEqual([]);
    expect(findQuotedParams("x = '{{a}}\"")).toEqual([]);
    // 別のリテラルの内側 / コメント内の引用符は拾わない
    expect(findQuotedParams("SELECT 'it''{{a}}''s'")).toEqual([]);
    expect(findQuotedParams("SELECT 1 -- '{{a}}'")).toEqual([]);
    expect(findQuotedParams("SELECT '{{a}}'", "mysql")).toEqual(["a"]);
  });
});

// ネイティブプレースホルダ (`?` / `$n` / `:name`) の検出ゴールデン (#2128)。
// 誤検出 (jsonb の ? / ::cast / ドル引用 / 文字列・コメント内) が実害になるので、境界を表で固定する。
const DETECT_VECTORS: { name: string; driver: string; sql: string; keys: string[] }[] = [
  { name: "MySQL ?", driver: "mysql", sql: "SELECT * FROM t WHERE id = ? AND s = ?", keys: ["?1", "?2"] },
  { name: "SQLite ?", driver: "sqlite", sql: "SELECT * FROM t WHERE id = ? AND s = ?", keys: ["?1", "?2"] },
  { name: "SQLite ?NNN", driver: "sqlite", sql: "SELECT ?2, ?1, ?2", keys: ["?2", "?1", "?2"] },
  {
    name: "PG $n",
    driver: "postgres",
    sql: "SELECT * FROM t WHERE id = $1 OR ref = $1 AND x = $2",
    keys: ["$1", "$1", "$2"],
  },
  {
    name: "PG jsonb ? を検出しない",
    driver: "postgres",
    sql: "SELECT * FROM t WHERE d ? 'a' AND d ?| array['b'] AND d ?& array['c']",
    keys: [],
  },
  { name: "PG ::int キャスト", driver: "postgres", sql: "SELECT x::int, y::text FROM t", keys: [] },
  { name: "PG $$ ドル引用内", driver: "postgres", sql: "DO $$ BEGIN PERFORM $1; END $$", keys: [] },
  { name: "PG $tag$ ドル引用内", driver: "postgres", sql: "SELECT $q$ id = $1 and ? and :x $q$", keys: [] },
  { name: "PG $ が識別子の一部", driver: "postgres", sql: "SELECT a$1 FROM t", keys: [] },
  { name: "文字列内の ?", driver: "mysql", sql: "SELECT '?' , \"?\" , `?` FROM t", keys: [] },
  { name: "行コメント内", driver: "mysql", sql: "SELECT 1 -- id = ?\n", keys: [] },
  { name: "ブロックコメント内", driver: "sqlite", sql: "SELECT /* ? :x */ 1", keys: [] },
  { name: "文字列内の $1 / :x", driver: "postgres", sql: "SELECT '$1', ':x'", keys: [] },
  {
    name: ":name",
    driver: "mysql",
    sql: "SELECT * FROM t WHERE a = :id AND b = :Name AND c = :id",
    keys: [":id", ":Name", ":id"],
  },
  { name: ":name (PG)", driver: "postgres", sql: "SELECT :a::int, :b", keys: [":a", ":b"] },
  { name: ":= 代入", driver: "mysql", sql: "SELECT @v := 1", keys: [] },
  { name: "@var / SQLite @name $name", driver: "sqlite", sql: "SELECT @name, $name, @v", keys: [] },
  { name: "配列スライス", driver: "postgres", sql: "SELECT arr[lo:hi], arr[1:2] FROM t", keys: [] },
  { name: "時刻リテラル", driver: "mysql", sql: "SELECT TIME '12:30:00'", keys: [] },
  { name: "PG の配列スライス (空白あり)", driver: "postgres", sql: "SELECT arr[1 : n] FROM t", keys: [] },
  { name: "PG の配列スライス (下限なし)", driver: "postgres", sql: "SELECT arr[:n] FROM t", keys: [] },
  { name: "PG の配列スライス (関数)", driver: "postgres", sql: "SELECT arr[lower(r):hi] FROM t", keys: [] },
  { name: "角括弧の外の :name は拾う", driver: "postgres", sql: "SELECT arr[1], :x FROM t", keys: [":x"] },
  {
    name: "ARRAY[...] の中の :name は拾う",
    driver: "postgres",
    sql: "SELECT ARRAY[:a, :b], :c",
    keys: [":a", ":b", ":c"],
  },
  { name: "入れ子の配列リテラルの中も拾う", driver: "postgres", sql: "SELECT array[[:a]]", keys: [":a"] },
  { name: "式の結果への添字はスライス", driver: "postgres", sql: "SELECT (f(x))[1:n]", keys: [] },
  { name: "PG の E'' 文字列の \\' を越えない", driver: "postgres", sql: "SELECT E'it\\'s ? $1'", keys: [] },
  { name: "MySQL の \\' を越えない", driver: "mysql", sql: "SELECT 'a\\' ? :x'", keys: [] },
  {
    name: "'10:00'::time と $1::int",
    driver: "postgres",
    sql: "SELECT '10:00'::time, $1::int",
    keys: ["$1"],
  },
  {
    name: "SQLite の ?, ?5, ? は ?1, ?5, ?6",
    driver: "sqlite",
    sql: "SELECT ?, ?5, ?",
    keys: ["?1", "?5", "?6"],
  },
  {
    name: "PG の PREPARE は対象外",
    driver: "postgres",
    sql: "PREPARE p(int) AS SELECT * FROM t WHERE id = $1",
    keys: [],
  },
  {
    name: "PREPARE (先頭コメント・小文字)",
    driver: "postgres",
    sql: "-- c\n  /* x */ prepare p AS SELECT $1",
    keys: [],
  },
  {
    name: "CREATE FUNCTION (SQL 標準本体)",
    driver: "postgres",
    sql: "CREATE FUNCTION f(int) RETURNS int LANGUAGE sql RETURN $1 + 1",
    keys: [],
  },
  {
    name: "CREATE OR REPLACE PROCEDURE",
    driver: "postgres",
    sql: "create or replace procedure p(int) language sql as 'select 1'; ",
    keys: [],
  },
  {
    name: "BEGIN ATOMIC 本体は END まで対象外",
    driver: "postgres",
    sql: "CREATE FUNCTION f(int) RETURNS int BEGIN ATOMIC SELECT $1; SELECT $1 + 1; END; SELECT $1",
    keys: ["$1"],
  },
  {
    name: "複文は文ごとに判定する",
    driver: "postgres",
    sql: "PREPARE p AS SELECT $1; SELECT $2",
    keys: ["$2"],
  },
  { name: "PG では ? を拾わない", driver: "postgres", sql: "SELECT ?", keys: [] },
  { name: "SQLite では $1 を拾わない", driver: "sqlite", sql: "SELECT $1", keys: [] },
];

describe("scanNativePlaceholders (ゴールデン)", () => {
  for (const v of DETECT_VECTORS) {
    it(v.name, () => {
      expect(scanNativePlaceholders(v.sql, v.driver).map((p) => p.key)).toEqual(v.keys);
    });
  }
});

describe("extractNativeParams", () => {
  it("位置パラメータを番号順、:name を初出順に並べる", () => {
    expect(extractNativeParams("SELECT $2, $1, $2", "postgres")).toEqual(["$1", "$2"]);
    expect(extractNativeParams("SELECT :b, ?, :a, ?, :b", "mysql")).toEqual(["?1", "?2", ":b", ":a"]);
  });
});

describe("substituteNativePlaceholders / substituteAllParams", () => {
  it("NULL はクォート無しの NULL に展開する", () => {
    expect(
      substituteNativePlaceholders(
        "SELECT ? , ?",
        "mysql",
        { "?1": "", "?2": "x" },
        { "?1": "null", "?2": "text" },
      ),
    ).toBe("SELECT NULL , 'x'");
  });

  it("$n は同じ番号を同じ値で全て置き換える", () => {
    expect(
      substituteNativePlaceholders("WHERE a = $1 OR b = $1", "postgres", { $1: "7" }, { $1: "number" }),
    ).toBe("WHERE a = 7 OR b = 7");
  });

  it("負数は括弧で包み、直前の - と合わさって -- コメントにならない", () => {
    expect(substituteNativePlaceholders("SELECT 10-?", "sqlite", { "?1": "-2" }, { "?1": "number" })).toBe(
      "SELECT 10-(-2)",
    );
    expect(substituteNativePlaceholders("SELECT $1", "postgres", { $1: "5" }, { $1: "number" })).toBe(
      "SELECT 5",
    );
  });

  it("値に含まれる ? や引用符でインジェクションしない", () => {
    const out = substituteNativePlaceholders(
      "SELECT ?, ?",
      "mysql",
      { "?1": "x', ?); DROP TABLE t; --", "?2": "ok" },
      { "?1": "text", "?2": "text" },
    );
    expect(out).toBe("SELECT 'x'', ?); DROP TABLE t; --', 'ok'");
  });

  it("値が無いプレースホルダはそのまま残す", () => {
    expect(substituteNativePlaceholders("SELECT ?", "sqlite", {}, {})).toBe("SELECT ?");
  });

  it("{{name}} の挙動は従来どおり (回帰)", () => {
    const sql = "SELECT * FROM {{tbl}} WHERE id = {{id}} AND s = 'a?b'";
    const values = { tbl: "users", id: "5" };
    const types = { tbl: "identifier", id: "number" } as const;
    expect(substituteAllParams(sql, "mysql", values, { ...types })).toBe(
      "SELECT * FROM `users` WHERE id = 5 AND s = 'a?b'",
    );
    expect(extractNativeParams(sql, "mysql")).toEqual([]);
  });

  it("{{name}} と ? の併用は {{}} 展開結果の ? を再検出しない", () => {
    expect(
      substituteAllParams("SELECT {{x}}, ?", "mysql", { x: "a?b", "?1": "1" }, { x: "text", "?1": "number" }),
    ).toBe("SELECT 'a?b', 1");
  });
});

describe("parsePastedValues", () => {
  it("カンマ区切り: NULL / 数値 / 引用符付き / 引用符内のカンマ", () => {
    expect(parsePastedValues("1, 'a,b', NULL, 'it''s', 'NULL', abc")).toEqual([
      { value: "1", type: "number" },
      { value: "a,b", type: "text" },
      { value: "", type: "null" },
      { value: "it's", type: "text" },
      { value: "NULL", type: "text" },
      { value: "abc", type: "text" },
    ]);
  });

  it("JSON 配列", () => {
    expect(parsePastedValues('[1, "active", null, true]', "mysql")).toEqual([
      { value: "1", type: "number" },
      { value: "active", type: "text" },
      { value: "", type: "null" },
      { value: "1", type: "number" },
    ]);
    expect(parsePastedValues("[true]", "postgres")).toEqual([{ value: "true", type: "text" }]);
  });

  it("JSON の 64bit 整数・小数・指数を丸めずに保つ", () => {
    expect(
      parsePastedValues("[9007199254740993, 12345678901234567890, -0.10, 1.5e3, 2E-2, 0]", "mysql"),
    ).toEqual([
      { value: "9007199254740993", type: "number" },
      { value: "12345678901234567890", type: "number" },
      { value: "-0.10", type: "number" },
      { value: "1.5e3", type: "number" },
      { value: "2E-2", type: "number" },
      { value: "0", type: "number" },
    ]);
  });

  it("JSON の文字列・入れ子・空配列を壊さない", () => {
    expect(parsePastedValues('["a,]\\"b", [1, 2], {"k": 3}, 7]')).toEqual([
      { value: 'a,]"b', type: "text" },
      { value: "[1,2]", type: "text" },
      { value: '{"k":3}', type: "text" },
      { value: "7", type: "number" },
    ]);
    expect(parsePastedValues("[]")).toEqual([]);
  });

  it("カンマ区切り: MySQL は \\' と \\\\ を解釈し、他ドライバは文字どおり", () => {
    expect(parsePastedValues("'it\\'s', 2, 'a\\\\b'", "mysql")).toEqual([
      { value: "it's", type: "text" },
      { value: "2", type: "number" },
      { value: "a\\b", type: "text" },
    ]);
    expect(parsePastedValues("'a\\b'", "postgres")).toEqual([{ value: "a\\b", type: "text" }]);
  });

  it("カンマ区切り: MySQL の \\% と \\_ はバックスラッシュ付きのまま残す (LIKE 用)", () => {
    expect(parsePastedValues("'g\\%h', 'a\\_b'", "mysql")).toEqual([
      { value: "g\\%h", type: "text" },
      { value: "a\\_b", type: "text" },
    ]);
  });

  it("裸の true / false は JSON と同じ規則", () => {
    expect(parsePastedValues("true, FALSE", "postgres")).toEqual([
      { value: "true", type: "text" },
      { value: "false", type: "text" },
    ]);
    expect(parsePastedValues("true, false", "sqlite")).toEqual([
      { value: "1", type: "number" },
      { value: "0", type: "number" },
    ]);
    expect(parsePastedValues("'true'", "sqlite")).toEqual([{ value: "true", type: "text" }]);
  });

  it("空入力は空配列、壊れた JSON は CSV として読む", () => {
    expect(parsePastedValues("  ")).toEqual([]);
    expect(parsePastedValues("[1, 2")).toHaveLength(2);
  });
});
