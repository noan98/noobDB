import { describe, expect, it } from "vitest";
import type { CellValue, Column } from "../api/tauri";
import {
  buildCsv,
  buildExportContent,
  buildJson,
  buildNdjson,
} from "../components/exportPreview";

const columns: Column[] = [
  { name: "id", type_name: "INT" },
  { name: "name", type_name: "VARCHAR" },
];

const rows: CellValue[][] = [
  [1, "Alice"],
  [2, "Bob, the \"Builder\""],
  [3, null],
];

describe("buildCsv", () => {
  it("クオートと \\r\\n 終端で書き出す", () => {
    const out = buildCsv(columns, rows);
    expect(out).toBe(
      "id,name\r\n" +
        "1,Alice\r\n" +
        '2,"Bob, the ""Builder"""\r\n' +
        "3,\r\n",
    );
  });

  it("空行でもヘッダは出る", () => {
    expect(buildCsv(columns, [])).toBe("id,name\r\n");
  });
});

describe("buildJson", () => {
  it("query なしでは配列、キーはソート済み", () => {
    const out = buildJson(columns, [[1, "Alice"]]);
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toEqual({ id: 1, name: "Alice" });
    // キーはアルファベット順 (id < name) で出力される。
    expect(Object.keys(parsed[0])).toEqual(["id", "name"]);
  });

  it("query ありでは { query, rows } でラップする", () => {
    const out = buildJson(columns, [[1, "Alice"]], "SELECT * FROM users");
    const parsed = JSON.parse(out);
    expect(parsed.query).toBe("SELECT * FROM users");
    expect(parsed.rows[0]).toEqual({ id: 1, name: "Alice" });
  });

  it("空 query ではラップしない", () => {
    expect(buildJson(columns, [[1, "Alice"]], "")).toBe(
      buildJson(columns, [[1, "Alice"]]),
    );
  });
});

describe("buildNdjson", () => {
  it("1 行 1 オブジェクトの \\n 区切り", () => {
    const out = buildNdjson(columns, [
      [1, "Alice"],
      [2, "Bob"],
    ]);
    const lines = out.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ id: 1, name: "Alice" });
    expect(out.endsWith("\n")).toBe(true);
  });

  it("空なら空文字列", () => {
    expect(buildNdjson(columns, [])).toBe("");
  });
});

describe("buildExportContent", () => {
  it("query は JSON のみ反映、CSV/NDJSON では無視", () => {
    const csv = buildExportContent("csv", columns, [[1, "Alice"]], "SELECT 1");
    expect(csv.includes("SELECT 1")).toBe(false);

    const ndjson = buildExportContent("ndjson", columns, [[1, "Alice"]], "SELECT 1");
    expect(ndjson.includes("SELECT 1")).toBe(false);

    const json = buildExportContent("json", columns, [[1, "Alice"]], "SELECT 1");
    expect(JSON.parse(json).query).toBe("SELECT 1");
  });
});
