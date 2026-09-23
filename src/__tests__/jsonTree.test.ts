import { describe, expect, it } from "vitest";
import {
  childCount,
  childSlice,
  formatJsonLossless,
  formatJsonPath,
  JSON_MAX_DEPTH,
  jsonPathSqlExpression,
  jsonPathSqlPredicate,
  nodeAtPath,
  parseJsonLossless,
  pathKey,
  scalarPreview,
  searchJsonTree,
  serializeJson,
  type JsonNode,
} from "../components/jsonTree";

/** JSON / JSONB セルのツリービューア (#1026) の純ロジック。 */
describe("parseJsonLossless / serializeJson", () => {
  it("keeps integers beyond Number.MAX_SAFE_INTEGER verbatim", () => {
    const text = '{"id":9007199254740993,"big":-18446744073709551615,"f":0.1000000000000000055511151231257827}';
    const node = parseJsonLossless(text);
    expect(node).not.toBeNull();
    expect(serializeJson(node!)).toBe(text);
    expect(nodeAtPath(node!, ["id"])).toEqual({ kind: "number", raw: "9007199254740993" });
    // JSON.parse would have rounded it.
    expect(JSON.stringify(JSON.parse(text))).not.toBe(text);
  });

  it("matches JSON.stringify(v, null, 2) layout for safe values", () => {
    const value = { a: [1, 2, { b: null, c: true }], d: "x\n\"y\"", e: {}, f: [], g: -1.5e3 };
    const text = JSON.stringify(value);
    expect(formatJsonLossless(text, 2)).toBe(JSON.stringify(value, null, 2));
    expect(formatJsonLossless(JSON.stringify(value, null, 2))).toBe(text);
  });

  it("formats exponent / fraction spellings without normalising them", () => {
    expect(formatJsonLossless("[1.50, 1E+2, -0, 0e-0]")).toBe("[1.50,1E+2,-0,0e-0]");
  });

  it("rejects invalid JSON", () => {
    for (const bad of ["", "{", "[1,]", "{a:1}", "01", "1.", "[1] x", "'s'", '"\t"', "{\"a\" 1}", "tru", "NaN"]) {
      expect(parseJsonLossless(bad), bad).toBeNull();
    }
  });

  it("accepts surrounding whitespace and scalars", () => {
    expect(parseJsonLossless("  \n[ ]\t")).toEqual({ kind: "array", items: [] });
    expect(parseJsonLossless('"\\u00e9"')).toEqual({ kind: "string", value: "é" });
    expect(parseJsonLossless("null")).toEqual({ kind: "null" });
  });

  it("keeps duplicate keys in order (lossless), nodeAtPath resolves to the last", () => {
    const node = parseJsonLossless('{"a":1,"a":2}')!;
    expect(childCount(node)).toBe(2);
    expect(serializeJson(node)).toBe('{"a":1,"a":2}');
    expect(nodeAtPath(node, ["a"])).toEqual({ kind: "number", raw: "2" });
  });

  it("falls back (null) instead of overflowing the stack on absurd nesting", () => {
    const deep = "[".repeat(JSON_MAX_DEPTH + 5) + "]".repeat(JSON_MAX_DEPTH + 5);
    expect(parseJsonLossless(deep)).toBeNull();
    const ok = "[".repeat(50) + "]".repeat(50);
    expect(parseJsonLossless(ok)).not.toBeNull();
  });
});

describe("childSlice / scalarPreview", () => {
  it("slices large arrays lazily with index segments", () => {
    const node = parseJsonLossless(JSON.stringify(Array.from({ length: 1000 }, (_, i) => i)))!;
    const kids = childSlice(node, 200, 203);
    expect(kids.map((k) => k.segment)).toEqual([200, 201, 202]);
    expect(childSlice(node, 995, 2000)).toHaveLength(5);
  });

  it("truncates long strings and keeps quotes", () => {
    const node: JsonNode = { kind: "string", value: "a".repeat(500) };
    const p = scalarPreview(node, 10);
    expect(p).toBe('"aaaaaaaaaa…"');
    expect(scalarPreview({ kind: "number", raw: "12345678901234567890" })).toBe("12345678901234567890");
  });
});

describe("searchJsonTree", () => {
  const root = parseJsonLossless(
    '{"user":{"name":"Alice","tags":["admin","dev"]},"Owner":"bob","n":9007199254740993}',
  )!;

  it("returns null for empty queries", () => {
    expect(searchJsonTree(root, "  ")).toBeNull();
  });

  it("matches keys and scalar values case-insensitively, in document order", () => {
    const r = searchJsonTree(root, "AD")!;
    expect(r.paths).toEqual([["user", "tags", 0]]);
    expect(r.ancestors).toEqual(new Set([pathKey([]), pathKey(["user"]), pathKey(["user", "tags"])]));

    const keys = searchJsonTree(root, "owner")!;
    expect(keys.paths).toEqual([["Owner"]]);
  });

  it("matches the original number text (no rounding)", () => {
    expect(searchJsonTree(root, "740993")!.paths).toEqual([["n"]]);
  });

  it("truncates at the limit", () => {
    const arr = parseJsonLossless(JSON.stringify(Array.from({ length: 50 }, () => "x")))!;
    const r = searchJsonTree(arr, "x", 10)!;
    expect(r.paths).toHaveLength(10);
    expect(r.truncated).toBe(true);
  });
});

describe("formatJsonPath", () => {
  it("renders dotted keys, indexes and quoted unsafe keys", () => {
    expect(formatJsonPath([])).toBe("$");
    expect(formatJsonPath(["a", "b", 0])).toBe("$.a.b[0]");
    expect(formatJsonPath(["a b", "1x", "", 'q"k'])).toBe('$."a b"."1x".""."q\\"k"');
  });
});

describe("jsonPathSqlExpression", () => {
  const path = ["a", "b", 0];
  it("PostgreSQL uses -> / ->> chains", () => {
    expect(jsonPathSqlExpression("postgres", "doc", path, true)).toBe(`"doc" -> 'a' -> 'b' ->> 0`);
    expect(jsonPathSqlExpression("postgres", "doc", path, false)).toBe(`"doc" -> 'a' -> 'b' -> 0`);
    // 数字だけのキーは文字列リテラル (キー参照) で、添字 (整数) と区別する。
    expect(jsonPathSqlExpression("postgres", "doc", ["0", "it's"], true)).toBe(`"doc" -> '0' ->> 'it''s'`);
  });
  it("MySQL uses JSON_EXTRACT (+ JSON_UNQUOTE for scalars) with backslash escaping", () => {
    expect(jsonPathSqlExpression("mysql", "doc", path, true)).toBe(
      "JSON_UNQUOTE(JSON_EXTRACT(`doc`, '$.a.b[0]'))",
    );
    expect(jsonPathSqlExpression("mysql", "doc", path, false)).toBe("JSON_EXTRACT(`doc`, '$.a.b[0]')");
    expect(jsonPathSqlExpression("mysql", "doc", ['q"k'], false)).toBe(
      "JSON_EXTRACT(`doc`, '$.\"q\\\\\"k\"')",
    );
  });
  it("SQLite / DuckDB / MSSQL", () => {
    expect(jsonPathSqlExpression("sqlite", "doc", path, true)).toBe(`json_extract("doc", '$.a.b[0]')`);
    expect(jsonPathSqlExpression("duckdb", "doc", path, true)).toBe(`json_extract_string("doc", '$.a.b[0]')`);
    expect(jsonPathSqlExpression("duckdb", "doc", path, false)).toBe(`json_extract("doc", '$.a.b[0]')`);
    expect(jsonPathSqlExpression("mssql", "doc", path, true)).toBe(`JSON_VALUE([doc], N'$.a.b[0]')`);
    expect(jsonPathSqlExpression("mssql", "doc", path, false)).toBe(`JSON_QUERY([doc], N'$.a.b[0]')`);
  });
  it("root path is the column itself", () => {
    expect(jsonPathSqlExpression("postgres", "doc", [], true)).toBe(`"doc"`);
  });
});

describe("jsonPathSqlPredicate", () => {
  const str: JsonNode = { kind: "string", value: "O'Neil" };
  const big: JsonNode = { kind: "number", raw: "9007199254740993" };
  const t: JsonNode = { kind: "boolean", value: true };
  const nul: JsonNode = { kind: "null" };

  it("returns null for containers and the root", () => {
    expect(jsonPathSqlPredicate("postgres", "doc", ["a"], { kind: "array", items: [] })).toBeNull();
    expect(jsonPathSqlPredicate("postgres", "doc", [], str)).toBeNull();
  });

  it("strings", () => {
    expect(jsonPathSqlPredicate("postgres", "doc", ["a"], str)).toBe(`"doc" ->> 'a' = 'O''Neil'`);
    expect(jsonPathSqlPredicate("mssql", "doc", ["a"], str)).toBe(`JSON_VALUE([doc], N'$.a') = N'O''Neil'`);
  });

  it("numbers keep their original text (no rounding)", () => {
    expect(jsonPathSqlPredicate("postgres", "doc", ["n"], big)).toBe(`("doc" ->> 'n')::numeric = 9007199254740993`);
    expect(jsonPathSqlPredicate("mysql", "doc", ["n"], big)).toBe("JSON_EXTRACT(`doc`, '$.n') = 9007199254740993");
    expect(jsonPathSqlPredicate("sqlite", "doc", ["n"], big)).toBe(`json_extract("doc", '$.n') = 9007199254740993`);
    expect(jsonPathSqlPredicate("duckdb", "doc", ["n"], big)).toBe(
      `TRY_CAST(json_extract_string("doc", '$.n') AS DOUBLE) = 9007199254740993`,
    );
    expect(jsonPathSqlPredicate("mssql", "doc", ["n"], big)).toBe(`JSON_VALUE([doc], N'$.n') = N'9007199254740993'`);
  });

  it("booleans (SQLite uses 1/0)", () => {
    expect(jsonPathSqlPredicate("sqlite", "doc", ["b"], t)).toBe(`json_extract("doc", '$.b') = 1`);
    expect(jsonPathSqlPredicate("postgres", "doc", ["b"], t)).toBe(`"doc" ->> 'b' = 'true'`);
  });

  it("null (MySQL distinguishes JSON null via JSON_TYPE)", () => {
    expect(jsonPathSqlPredicate("mysql", "doc", ["x"], nul)).toBe("JSON_TYPE(JSON_EXTRACT(`doc`, '$.x')) = 'NULL'");
    expect(jsonPathSqlPredicate("postgres", "doc", ["x"], nul)).toBe(`"doc" ->> 'x' IS NULL`);
  });
});
