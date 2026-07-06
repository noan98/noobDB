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

  it("極端な数値は指数表記にせず Rust の f64::to_string() と同じ 10 進展開にする", () => {
    // JS の String(v) は絶対値が概ね 1e21 以上/1e-6 未満で指数表記になるが、
    // Rust の f64::to_string() は常にプレーンな 10 進展開を返す。
    const cols: Column[] = [{ name: "v", type_name: "DOUBLE" }];
    expect(buildCsv(cols, [[1e21]])).toBe("v\r\n1000000000000000000000\r\n");
    expect(buildCsv(cols, [[5e-7]])).toBe("v\r\n0.0000005\r\n");
    expect(buildCsv(cols, [[-1.23e-10]])).toBe("v\r\n-0.000000000123\r\n");
    // 通常範囲の値は従来どおり (指数表記にならない)。
    expect(buildCsv(cols, [[2.0]])).toBe("v\r\n2\r\n");
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

  it("キーは UTF-16 コード単位ではなく Unicode コードポイント順でソートされる", () => {
    // U+E000 (BMP, 私用領域) と \u{1F600} (サロゲートペア) は UTF-16 コード単位の
    // 既定比較 (`<`) だと先頭サロゲート (0xD83D=55357) が U+E000 (57344) より小さい
    // ため \u{1F600} が先に来てしまうが、実際のコードポイント値は \u{1F600} (128512) の
    // 方が大きいため E000 が先に来なければならない (Rust の BTreeMap はコードポイント順)。
    const cols: Column[] = [
      { name: "\u{E000}", type_name: "TEXT" },
      { name: "\u{1F600}", type_name: "TEXT" },
    ];
    const out = buildJson(cols, [["pua", "emoji"]]);
    const parsed = JSON.parse(out);
    expect(Object.keys(parsed[0])).toEqual(["\u{E000}", "\u{1F600}"]);
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

  it("バックスラッシュを先にエスケープする", () => {
    // 入力 "a\\|b" (a, \, |, b) は "a\\\|b" (a, \\, \|, b) になる。
    const out = buildMarkdownTable([{ name: "note", type_name: "VARCHAR" }], [["a\\|b"]]);
    expect(out.includes("| a\\\\\\|b |")).toBe(true);
  });

  it("空でもヘッダ + 区切りは出る", () => {
    expect(buildMarkdownTable(columns, [])).toBe("| id | name |\n| --- | --- |\n");
  });

  it("極端な数値は指数表記にせず 10 進展開にする", () => {
    const cols: Column[] = [{ name: "v", type_name: "DOUBLE" }];
    const out = buildMarkdownTable(cols, [[1.5e21]]);
    expect(out.includes("| 1500000000000000000000 |")).toBe(true);
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

  it("極端な数値は指数表記にせず 10 進展開のリテラルにする", () => {
    const cols: Column[] = [{ name: "v", type_name: "DOUBLE" }];
    const out = buildSqlInsert("mysql", "t", cols, [[1e21]]);
    expect(out.includes("(1000000000000000000000)")).toBe(true);
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
