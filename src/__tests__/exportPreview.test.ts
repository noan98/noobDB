import { describe, expect, it } from "vitest";
import type { CellValue, Column } from "../api/tauri";
import {
  buildCsv,
  buildExportContent,
  buildJson,
  buildMarkdownTable,
  buildNdjson,
  buildSqlInsert,
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

describe("buildMarkdownTable", () => {
  it("ヘッダ + 区切り + データ行を生成する", () => {
    const out = buildMarkdownTable(columns, [
      [1, "Alice"],
      [2, null],
    ]);
    expect(out).toBe(
      "| id | name |\n" +
        "| --- | --- |\n" +
        "| 1 | Alice |\n" +
        "| 2 |  |\n",
    );
  });

  it("パイプと改行をエスケープする", () => {
    const out = buildMarkdownTable([{ name: "note", type_name: "VARCHAR" }], [["a|b\nc"]]);
    expect(out.includes("| a\\|b<br>c |")).toBe(true);
  });

  it("空でもヘッダ + 区切りは出る", () => {
    expect(buildMarkdownTable(columns, [])).toBe("| id | name |\n| --- | --- |\n");
  });
});

describe("buildSqlInsert", () => {
  it("MySQL: バッククオート識別子 + 文字列リテラル", () => {
    const out = buildSqlInsert("mysql", "users", columns, [
      [1, "Alice"],
      [2, "Bob"],
    ]);
    expect(out).toBe(
      "INSERT INTO `users` (`id`, `name`) VALUES\n" +
        "  (1, 'Alice'),\n" +
        "  (2, 'Bob');\n",
    );
  });

  it("バッチサイズで複数文に分割する", () => {
    const out = buildSqlInsert("postgres", "t", [{ name: "id", type_name: "INT" }], [[1], [2], [3]], 2);
    const stmts = out.trim().split(";\n").filter((s) => s.length > 0);
    expect(stmts.length).toBe(2);
    expect(stmts[0].startsWith('INSERT INTO "t" ("id") VALUES')).toBe(true);
    expect(stmts[1].includes("(3)")).toBe(true);
  });

  it("ドライバ別の文字列/真偽値エスケープ", () => {
    const cols: Column[] = [
      { name: "s", type_name: "TEXT" },
      { name: "flag", type_name: "BOOL" },
    ];
    const my = buildSqlInsert("mysql", "t", cols, [["a'b\\c", true]]);
    expect(my.includes("'a''b\\\\c'")).toBe(true);
    expect(my.includes(", 1)")).toBe(true);
    const pg = buildSqlInsert("postgres", "t", cols, [["a'b\\c", true]]);
    expect(pg.includes("'a''b\\c'")).toBe(true);
    expect(pg.includes(", TRUE)")).toBe(true);
  });

  it("空テーブル名はプレースホルダにフォールバック", () => {
    const out = buildSqlInsert("mysql", "  ", columns, [[1, "a"]]);
    expect(out.startsWith("INSERT INTO `exported_table`")).toBe(true);
  });

  it("空結果は空文字列", () => {
    expect(buildSqlInsert("mysql", "t", columns, [])).toBe("");
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

  it("markdown / sql 形式を ctx 付きで生成する", () => {
    const md = buildExportContent("markdown", columns, [[1, "Alice"]]);
    expect(md.startsWith("| id | name |")).toBe(true);

    const sql = buildExportContent("sql", columns, [[1, "Alice"]], null, {
      driver: "mysql",
      table: "users",
    });
    expect(sql.startsWith("INSERT INTO `users`")).toBe(true);
  });
});
