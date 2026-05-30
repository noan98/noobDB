import { describe, expect, it } from "vitest";
import {
  extractQueryParams,
  isNumericParam,
  renderParamValue,
  substituteQueryParams,
} from "../queryParams";

// {{variable}} クエリパラメータの検出と、ドライバ別・型別の安全な展開 (#388)。
// SQL インジェクション防止が機能の核なので、エスケープ経路を重点的に検証する。

describe("extractQueryParams", () => {
  it("出現順に一意な変数名を抽出する", () => {
    expect(
      extractQueryParams("SELECT * FROM {{tbl}} WHERE id = {{id}} OR ref = {{id}}"),
    ).toEqual(["tbl", "id"]);
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
    const out = substituteQueryParams(
      "SELECT {{x}} WHERE a = {{x}}",
      "postgres",
      { x: "v" },
      { x: "text" },
    );
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
