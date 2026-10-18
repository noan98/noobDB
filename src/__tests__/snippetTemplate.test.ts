import { describe, expect, it } from "vitest";
import { extractQueryParams } from "../queryParams";
import {
  parseSnippetTemplate,
  snippetHasFields,
  snippetPlainText,
  snippetToCodeMirrorTemplate,
} from "../snippetTemplate";

describe("parseSnippetTemplate", () => {
  it("番号付き (既定値あり / なし) と名前付きを分解する", () => {
    expect(parseSnippetTemplate("SELECT ${1:cols} FROM ${2} WHERE ${cond}")).toEqual([
      { kind: "text", text: "SELECT " },
      { kind: "field", key: "n:1", index: 1, name: null, placeholder: "cols" },
      { kind: "text", text: " FROM " },
      { kind: "field", key: "n:2", index: 2, name: null, placeholder: "" },
      { kind: "text", text: " WHERE " },
      { kind: "field", key: "s:cond", index: null, name: "cond", placeholder: "" },
    ]);
  });

  it("空の既定値と 0 番 (最終カーソル位置) を受け付ける", () => {
    const parts = parseSnippetTemplate("${1:}${0}");
    expect(parts).toEqual([
      { kind: "field", key: "n:1", index: 1, name: null, placeholder: "" },
      { kind: "field", key: "n:0", index: 0, name: null, placeholder: "" },
    ]);
  });

  it("既定値には空白・記号・日本語を含められる", () => {
    expect(snippetPlainText("WHERE ${1:created_at >= NOW() - INTERVAL '7 day'} AND ${2:状態 = 1}")).toBe(
      "WHERE created_at >= NOW() - INTERVAL '7 day' AND 状態 = 1",
    );
  });

  it("\\${ は記法を含む本文でだけ文字どおりの ${ になる", () => {
    expect(snippetHasFields("echo \\${1:x}")).toBe(false);
    // 記法を含まない本文は原文のまま (エスケープも解かない)。
    expect(snippetPlainText("echo \\${1:x}")).toBe("echo \\${1:x}");
    expect(snippetPlainText("echo \\${1:x} ${2:y}")).toBe("echo ${1:x} y");
  });
});

describe("後方互換: 既存スニペットを壊さない", () => {
  const legacy = [
    "SELECT * FROM users WHERE id = $1 AND status = $2",
    "CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql",
    "DO $body$ BEGIN PERFORM 1; END $body$",
    "SELECT '{\"a\": 1}'::jsonb #> '{a}'",
    "SELECT * FROM t WHERE name LIKE 'a\\%' -- バックスラッシュ",
    "SELECT * FROM users",
    "SELECT $",
    "SELECT ${",
    "SELECT ${ x } FROM t",
    "SELECT ${1:{}} FROM t",
    "SELECT ${1:abc FROM t",
    "SELECT ${name:default} FROM t",
    "SELECT ${} FROM t",
    "SELECT ${1x} FROM t",
    "SELECT #{1} FROM t",
    "\tSELECT 1\n\tFROM t",
    "SELECT ${1:a\nb} FROM t",
    "SELECT ${1:a\r\nb} FROM t",
    "echo \\${1:x}",
  ];

  it.each(legacy)("記法を含まず本文が変わらない: %s", (sql) => {
    expect(snippetHasFields(sql)).toBe(false);
    expect(snippetPlainText(sql)).toBe(sql);
  });

  it("素の $1 / $$ はタブストップにしない", () => {
    expect(snippetHasFields("WHERE id = $1")).toBe(false);
    expect(snippetHasFields("AS $$ x $$")).toBe(false);
  });

  it("$1 と ${1:x} が同居しても $1 は文字どおり残る", () => {
    expect(snippetPlainText("SELECT ${1:cols} FROM t WHERE id = $1")).toBe(
      "SELECT cols FROM t WHERE id = $1",
    );
  });
});

describe("{{name}} パラメータとの非衝突", () => {
  it("{{name}} 単独はフィールドにならず、パラメータとして抽出できる", () => {
    const sql = "SELECT * FROM t WHERE a = {{id}} AND b = '{{name}}'";
    expect(snippetHasFields(sql)).toBe(false);
    expect(snippetPlainText(sql)).toBe(sql);
    expect(extractQueryParams(snippetPlainText(sql))).toEqual(["id", "name"]);
  });

  it("${{name}} も記法ではなくそのまま残る", () => {
    expect(snippetHasFields("SELECT ${{id}}")).toBe(false);
    expect(snippetPlainText("SELECT ${{id}}")).toBe("SELECT ${{id}}");
  });

  it("フィールドと {{name}} が同居しても両方が生きる", () => {
    const sql = "SELECT ${1:cols} FROM t WHERE id = {{id}}";
    expect(snippetPlainText(sql)).toBe("SELECT cols FROM t WHERE id = {{id}}");
    expect(extractQueryParams(snippetPlainText(sql))).toEqual(["id"]);
    // CodeMirror へは波括弧をエスケープして渡すので、{{id}} がフィールド扱いされない。
    expect(snippetToCodeMirrorTemplate(sql)).toBe("SELECT ${1:cols} FROM t WHERE id = \\{\\{id\\}\\}");
  });

  it("{{1}} のような数字だけのパラメータもフィールドにならない", () => {
    expect(snippetHasFields("{{1}} {1}")).toBe(false);
  });
});

describe("連動 (ミラー) と既定値の解決", () => {
  it("同じ番号は最初の空でない既定値にそろう", () => {
    expect(snippetPlainText("${1:t} a ${1} b ${1:other}")).toBe("t a t b t");
    expect(snippetToCodeMirrorTemplate("${1:t} ${1}")).toBe("${1:t} ${1:t}");
  });

  it("名前付きは名前が既定値で、同名は連動する", () => {
    expect(snippetPlainText("${table} JOIN ${table}")).toBe("table JOIN table");
  });

  it("既定値の無い番号は空文字になる", () => {
    expect(snippetPlainText("a${1}b")).toBe("ab");
  });
});

describe("snippetToCodeMirrorTemplate", () => {
  it("リテラルの波括弧と \\ だけエスケープされ、他は触らない", () => {
    expect(snippetToCodeMirrorTemplate("SELECT '{\"a\":1}' ${1:x} $1 $$ #")).toBe(
      "SELECT '\\{\"a\":1\\}' ${1:x} $1 $$ #",
    );
  });

  it("名前付きフィールドには本文中の最大番号の次から出現順に番号を振る (同名は同番号)", () => {
    expect(snippetToCodeMirrorTemplate("${cols} ${tbl} ${cols}")).toBe("${1:cols} ${2:tbl} ${1:cols}");
    expect(snippetToCodeMirrorTemplate("${1:a} ${tbl} ${3:c}")).toBe("${1:a} ${4:tbl} ${3:c}");
    expect(snippetToCodeMirrorTemplate("${cols}${0}")).toBe("${1:cols}${0}");
  });

  it("\\${ は $\\{ に変換され CodeMirror にフィールドと解釈されない", () => {
    expect(snippetToCodeMirrorTemplate("a \\${1} ${2:b}")).toBe("a $\\{1\\} ${2:b}");
  });
});
