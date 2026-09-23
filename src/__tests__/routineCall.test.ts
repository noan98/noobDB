import { describe, expect, it } from "vitest";
import type { RoutineParameter, RoutineSignature } from "../api/tauri";
import {
  buildRoutineCall,
  isRoutineKind,
  routineArgLiteral,
  routineBaseType,
  routineParamIsArgument,
  routineParamTakesInput,
  routineQualifiedName,
  supportsRoutineExecution,
  validateRoutineInput,
} from "../components/routineCall";

const p = (name: string, mode: string, data_type: string): RoutineParameter => ({ name, mode, data_type });

function sig(partial: Partial<RoutineSignature> & Pick<RoutineSignature, "kind" | "parameters">): RoutineSignature {
  return { name: "r", returns_set: false, return_type: null, ...partial };
}

describe("supportsRoutineExecution / isRoutineKind", () => {
  it("MySQL / PostgreSQL / MSSQL のみ対応 (SQLite / DuckDB は非対応)", () => {
    expect(supportsRoutineExecution("mysql")).toBe(true);
    expect(supportsRoutineExecution("postgres")).toBe(true);
    expect(supportsRoutineExecution("mssql")).toBe(true);
    expect(supportsRoutineExecution("sqlite")).toBe(false);
    expect(supportsRoutineExecution("duckdb")).toBe(false);
  });
  it("procedure / function だけがルーチン", () => {
    expect(isRoutineKind("procedure")).toBe(true);
    expect(isRoutineKind("function")).toBe(true);
    expect(isRoutineKind("view")).toBe(false);
    expect(isRoutineKind("trigger")).toBe(false);
  });
});

describe("パラメータの分類", () => {
  it("OUT / TABLE は入力値を取らない", () => {
    expect(routineParamTakesInput(p("a", "in", "int"))).toBe(true);
    expect(routineParamTakesInput(p("a", "inout", "int"))).toBe(true);
    expect(routineParamTakesInput(p("a", "variadic", "int[]"))).toBe(true);
    expect(routineParamTakesInput(p("a", "out", "int"))).toBe(false);
    expect(routineParamTakesInput(p("a", "table", "int"))).toBe(false);
  });
  it("RETURNS TABLE の出力列はフォームに出さない", () => {
    expect(routineParamIsArgument(p("a", "out", "int"))).toBe(true);
    expect(routineParamIsArgument(p("a", "table", "int"))).toBe(false);
  });
  it("型名は長さ/精度を落として大文字化する", () => {
    expect(routineBaseType("numeric(10,2)")).toBe("NUMERIC");
    expect(routineBaseType("varchar(20)")).toBe("VARCHAR");
    expect(routineBaseType("int unsigned")).toBe("INT UNSIGNED");
    expect(routineBaseType("integer[]")).toBe("INTEGER[]");
  });
});

describe("validateRoutineInput (validateCellInput を共有)", () => {
  it("数値型に非数値は拒否、NULL は許可", () => {
    expect(validateRoutineInput(p("a", "in", "int"), "abc")).toBe("editInvalidNumber");
    expect(validateRoutineInput(p("a", "in", "int"), "42")).toBeNull();
    expect(validateRoutineInput(p("a", "in", "int"), "null")).toBeNull();
  });
  it("日付の形式を検証する", () => {
    expect(validateRoutineInput(p("a", "in", "date"), "2024-13")).toBe("editInvalidDate");
    expect(validateRoutineInput(p("a", "in", "date"), "2024-01-31")).toBeNull();
  });
  it("文字列型の空欄は空文字として許可、OUT は常に OK", () => {
    expect(validateRoutineInput(p("a", "in", "varchar(10)"), "")).toBeNull();
    expect(validateRoutineInput(p("a", "out", "int"), "garbage")).toBeNull();
  });
});

describe("routineArgLiteral (cellEdit のリテラル規約を再利用)", () => {
  it("MySQL は ' を二重化しバックスラッシュもエスケープ", () => {
    expect(routineArgLiteral("mysql", p("a", "in", "varchar(10)"), "O'Re\\illy")).toBe("'O''Re\\\\illy'");
  });
  it("MSSQL は N 接頭辞、BIT は 0/1", () => {
    expect(routineArgLiteral("mssql", p("@a", "in", "nvarchar(10)"), "x'y")).toBe("N'x''y'");
    expect(routineArgLiteral("mssql", p("@a", "in", "bit"), "true")).toBe("1");
  });
  it("PostgreSQL は型キャストを付け、バックスラッシュはそのまま", () => {
    expect(routineArgLiteral("postgres", p("a", "in", "integer"), "5")).toBe("CAST(5 AS integer)");
    expect(routineArgLiteral("postgres", p("a", "in", "text"), "a\\b'c")).toBe("CAST('a\\b''c' AS text)");
    expect(routineArgLiteral("postgres", p("a", "in", "date"), "NULL")).toBe("CAST(NULL AS date)");
    expect(routineArgLiteral("postgres", p("a", "variadic", "integer[]"), "{1,2}")).toBe(
      "VARIADIC CAST('{1,2}' AS integer[])",
    );
  });
  it("数値型でも数値でない入力は文字列として必ずクオートされる (注入不可)", () => {
    expect(routineArgLiteral("mysql", p("a", "in", "int"), "1); DROP TABLE t; --")).toBe(
      "'1); DROP TABLE t; --'",
    );
  });
});

describe("routineQualifiedName", () => {
  it("識別子は quoteIdentFor でエスケープする", () => {
    expect(routineQualifiedName("mysql", "db`x", "p")).toBe("`db``x`.`p`");
    expect(routineQualifiedName("postgres", "public", 'f"n')).toBe('"public"."f""n"');
    expect(routineQualifiedName("mssql", "db", "p]x")).toBe("[db].[dbo].[p]]x]");
  });
});

describe("buildRoutineCall — MySQL", () => {
  it("IN のみのプロシージャは CALL 1 文", () => {
    const r = buildRoutineCall({
      driver: "mysql",
      database: "shop",
      signature: sig({ kind: "procedure", name: "add_order", parameters: [p("id", "in", "int"), p("note", "in", "varchar(20)")] }),
      values: ["7", "hi"],
    });
    expect(r).toEqual({ sql: "CALL `shop`.`add_order`(7, 'hi')", needsSameConnection: false, outputsReturned: true });
  });
  it("OUT / INOUT はセッション変数を使うスクリプトになり、固定接続が必要", () => {
    const r = buildRoutineCall({
      driver: "mysql",
      database: "shop",
      signature: sig({
        kind: "procedure",
        name: "p",
        parameters: [p("a", "in", "int"), p("b", "inout", "int"), p("c", "out", "varchar(5)")],
      }),
      values: ["1", "2", "ignored"],
    });
    expect(r.sql).toBe(
      "SET @`b` = 2;\nCALL `shop`.`p`(1, @`b`, @`c`);\nSELECT @`b` AS `b`, @`c` AS `c`;",
    );
    expect(r.needsSameConnection).toBe(true);
  });
  it("関数は SELECT fn(...) AS fn", () => {
    const r = buildRoutineCall({
      driver: "mysql",
      database: "shop",
      signature: sig({ kind: "function", name: "total", parameters: [p("x", "in", "decimal(10,2)")] }),
      values: ["1.5"],
    });
    expect(r.sql).toBe("SELECT `shop`.`total`(1.5) AS `total`");
  });
});

describe("buildRoutineCall — PostgreSQL", () => {
  it("関数は SELECT * FROM fn(...) で OUT / TABLE 列を引数から除く", () => {
    const r = buildRoutineCall({
      driver: "postgres",
      database: "public",
      signature: sig({
        kind: "function",
        name: "f",
        returns_set: true,
        parameters: [p("a", "in", "integer"), p("o", "out", "text"), p("t", "table", "integer")],
      }),
      values: ["3", "", ""],
    });
    expect(r.sql).toBe('SELECT * FROM "public"."f"(CAST(3 AS integer))');
    expect(r.outputsReturned).toBe(true);
    expect(r.needsSameConnection).toBe(false);
  });
  it("プロシージャの OUT には型付き NULL を渡す (値は結果行で返る)", () => {
    const r = buildRoutineCall({
      driver: "postgres",
      database: "s",
      signature: sig({
        kind: "procedure",
        name: "p",
        parameters: [p("a", "in", "integer"), p("b", "inout", "text"), p("c", "out", "integer")],
      }),
      values: ["1", "x", ""],
    });
    expect(r.sql).toBe(
      'CALL "s"."p"(CAST(1 AS integer), CAST(\'x\' AS text), CAST(NULL AS integer))',
    );
  });
  it("引数なし", () => {
    const r = buildRoutineCall({
      driver: "postgres",
      database: "s",
      signature: sig({ kind: "function", name: "now2", parameters: [] }),
      values: [],
    });
    expect(r.sql).toBe('SELECT * FROM "s"."now2"()');
  });
});

describe("buildRoutineCall — MSSQL", () => {
  it("プロシージャは EXEC (位置指定)、OUTPUT は値を渡すが返らない", () => {
    const r = buildRoutineCall({
      driver: "mssql",
      database: "app",
      signature: sig({ kind: "procedure", name: "p", parameters: [p("@a", "in", "int"), p("@b", "inout", "nvarchar(10)")] }),
      values: ["1", "NULL"],
    });
    expect(r).toEqual({ sql: "EXEC [app].[dbo].[p] 1, NULL", needsSameConnection: false, outputsReturned: false });
  });
  it("引数なしプロシージャ", () => {
    const r = buildRoutineCall({
      driver: "mssql",
      database: "app",
      signature: sig({ kind: "procedure", name: "p", parameters: [] }),
      values: [],
    });
    expect(r.sql).toBe("EXEC [app].[dbo].[p]");
    expect(r.outputsReturned).toBe(true);
  });
  it("スカラー関数は SELECT fn(...) AS fn、テーブル値関数は SELECT * FROM", () => {
    const scalar = buildRoutineCall({
      driver: "mssql",
      database: "app",
      signature: sig({ kind: "function", name: "f", parameters: [p("@s", "in", "nvarchar(5)")] }),
      values: ["a'b"],
    });
    expect(scalar.sql).toBe("SELECT [app].[dbo].[f](N'a''b') AS [f]");
    const tvf = buildRoutineCall({
      driver: "mssql",
      database: "app",
      signature: sig({ kind: "function", name: "tf", returns_set: true, parameters: [p("@n", "in", "int")] }),
      values: ["2"],
    });
    expect(tvf.sql).toBe("SELECT * FROM [app].[dbo].[tf](2)");
  });
});
