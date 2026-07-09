import { describe, expect, it } from "vitest";
import type { TableColumnInfo } from "../api/tauri";
import {
  activeSpecs,
  buildFkSelectSql,
  buildTestDataInsertStatements,
  classifyDataType,
  coerceFixedValue,
  generateRows,
  inferColumnSpec,
  mulberry32,
  parseEnumChoices,
  type ColumnGenSpec,
} from "../components/testDataGen";

function col(overrides: Partial<TableColumnInfo>): TableColumnInfo {
  return {
    name: "c",
    data_type: "varchar(255)",
    nullable: true,
    key: "",
    default: null,
    extra: "",
    referenced_table: null,
    referenced_column: null,
    ...overrides,
  };
}

function spec(overrides: Partial<ColumnGenSpec>): ColumnGenSpec {
  return {
    column: "c",
    dataType: "varchar(255)",
    kind: "string",
    nullable: true,
    strategy: "randomString",
    nullRate: 0,
    fixedValue: "",
    choices: [],
    fkTable: null,
    fkColumn: null,
    length: 8,
    min: 1,
    max: 100,
    serialStart: 1,
    temporal: "datetime",
    ...overrides,
  };
}

describe("classifyDataType", () => {
  it("型宣言文字列を CellKind へ分類する", () => {
    expect(classifyDataType("int(11)")).toBe("number");
    expect(classifyDataType("BIGINT UNSIGNED")).toBe("number");
    expect(classifyDataType("smallint")).toBe("number");
    expect(classifyDataType("serial")).toBe("number");
    expect(classifyDataType("decimal(10,2)")).toBe("decimal");
    expect(classifyDataType("numeric(12,4)")).toBe("decimal");
    expect(classifyDataType("double precision")).toBe("decimal");
    expect(classifyDataType("float")).toBe("decimal");
    expect(classifyDataType("boolean")).toBe("bool");
    expect(classifyDataType("tinyint(1)")).toBe("bool");
    expect(classifyDataType("date")).toBe("date");
    expect(classifyDataType("datetime")).toBe("date");
    expect(classifyDataType("timestamp with time zone")).toBe("date");
    expect(classifyDataType("time")).toBe("time");
    expect(classifyDataType("json")).toBe("json");
    expect(classifyDataType("jsonb")).toBe("json");
    expect(classifyDataType("enum('a','b')")).toBe("enum");
    expect(classifyDataType("set('x','y')")).toBe("enum");
    expect(classifyDataType("blob")).toBe("binary");
    expect(classifyDataType("bytea")).toBe("binary");
    expect(classifyDataType("varbinary(16)")).toBe("binary");
    expect(classifyDataType("varchar(255)")).toBe("string");
    expect(classifyDataType("character varying(50)")).toBe("string");
    expect(classifyDataType("text")).toBe("string");
    // 不明な型は string に落とす。
    expect(classifyDataType("geometry")).toBe("string");
  });
});

describe("parseEnumChoices", () => {
  it("enum/set 宣言から候補値を取り出す", () => {
    expect(parseEnumChoices("enum('a','b','c')")).toEqual(["a", "b", "c"]);
    expect(parseEnumChoices("set('x','y')")).toEqual(["x", "y"]);
    expect(parseEnumChoices("ENUM('L','M','S')")).toEqual(["L", "M", "S"]);
  });
  it("エスケープされたシングルクオートを復元する", () => {
    expect(parseEnumChoices("enum('it''s','ok')")).toEqual(["it's", "ok"]);
  });
  it("ENUM 以外は null", () => {
    expect(parseEnumChoices("varchar(255)")).toBeNull();
    expect(parseEnumChoices("int")).toBeNull();
  });
});

describe("inferColumnSpec", () => {
  it("auto_increment は omit (DB に任せる)", () => {
    const s = inferColumnSpec(col({ data_type: "int(11)", key: "PRI", extra: "auto_increment" }));
    expect(s.strategy).toBe("omit");
  });
  it("PostgreSQL の nextval デフォルトも omit", () => {
    const s = inferColumnSpec(
      col({ data_type: "integer", key: "PRI", default: "nextval('users_id_seq'::regclass)" }),
    );
    expect(s.strategy).toBe("omit");
  });
  it("FK カラムは参照先の既存値からランダム選択", () => {
    const s = inferColumnSpec(
      col({ data_type: "int", referenced_table: "users", referenced_column: "id" }),
    );
    expect(s.strategy).toBe("fkRef");
    expect(s.fkTable).toBe("users");
    expect(s.fkColumn).toBe("id");
  });
  it("ENUM は宣言の候補から choice", () => {
    const s = inferColumnSpec(col({ data_type: "enum('new','done')" }));
    expect(s.strategy).toBe("choice");
    expect(s.choices).toEqual(["new", "done"]);
  });
  it("数値 PK (非自動採番) は連番、文字列 PK は UUID", () => {
    expect(inferColumnSpec(col({ data_type: "int", key: "PRI" })).strategy).toBe("serial");
    expect(inferColumnSpec(col({ data_type: "varchar(36)", key: "PRI" })).strategy).toBe("uuid");
  });
  it("uuid 型は UUID 生成", () => {
    expect(inferColumnSpec(col({ data_type: "uuid" })).strategy).toBe("uuid");
  });
  it("CellKind 別の既定方針", () => {
    expect(inferColumnSpec(col({ data_type: "int" })).strategy).toBe("randomNumber");
    expect(inferColumnSpec(col({ data_type: "decimal(10,2)" })).strategy).toBe("randomNumber");
    expect(inferColumnSpec(col({ data_type: "boolean" })).strategy).toBe("randomBool");
    expect(inferColumnSpec(col({ data_type: "datetime" })).strategy).toBe("randomDate");
    expect(inferColumnSpec(col({ data_type: "time" })).strategy).toBe("randomDate");
    expect(inferColumnSpec(col({ data_type: "json" })).strategy).toBe("fixed");
    expect(inferColumnSpec(col({ data_type: "blob" })).strategy).toBe("omit");
    expect(inferColumnSpec(col({ data_type: "text" })).strategy).toBe("randomString");
  });
  it("varchar の宣言長を超えない文字数を既定にする", () => {
    expect(inferColumnSpec(col({ data_type: "varchar(4)" })).length).toBe(4);
    expect(inferColumnSpec(col({ data_type: "varchar(255)" })).length).toBe(12);
  });
  it("日時の書式を宣言型から推定する", () => {
    expect(inferColumnSpec(col({ data_type: "date" })).temporal).toBe("date");
    expect(inferColumnSpec(col({ data_type: "time" })).temporal).toBe("time");
    expect(inferColumnSpec(col({ data_type: "timestamp" })).temporal).toBe("datetime");
  });
  it("既定の NULL 率は 0", () => {
    expect(inferColumnSpec(col({ nullable: true })).nullRate).toBe(0);
  });
});

describe("mulberry32", () => {
  it("同じシードは同じ列を返す (決定論)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 20; i++) expect(a()).toBe(b());
  });
  it("異なるシードは異なる列を返す", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const sa = Array.from({ length: 5 }, () => a());
    const sb = Array.from({ length: 5 }, () => b());
    expect(sa).not.toEqual(sb);
  });
  it("[0, 1) の範囲に収まる", () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("generateRows", () => {
  it("同じ specs + seed で常に同じ行列を返す (プレビューと投入が一致)", () => {
    const specs = [
      spec({ column: "id", strategy: "serial" }),
      spec({ column: "name", strategy: "randomString", length: 10 }),
      spec({ column: "score", strategy: "randomNumber", kind: "number", min: 1, max: 100 }),
    ];
    expect(generateRows(specs, 20, 12345)).toEqual(generateRows(specs, 20, 12345));
  });
  it("異なるシードは異なる行列を返す", () => {
    const specs = [spec({ column: "name", strategy: "randomString", length: 10 })];
    expect(generateRows(specs, 10, 1)).not.toEqual(generateRows(specs, 10, 2));
  });
  it("連番は serialStart から +1 ずつ", () => {
    const rows = generateRows([spec({ strategy: "serial", serialStart: 100 })], 3, 1);
    expect(rows.map((r) => r[0])).toEqual([100, 101, 102]);
  });
  it("nullRate = 1 は全行 NULL、nullRate = 0 は NULL なし", () => {
    const all = generateRows([spec({ strategy: "randomString", nullRate: 1 })], 50, 3);
    expect(all.every((r) => r[0] === null)).toBe(true);
    const none = generateRows([spec({ strategy: "randomString", nullRate: 0 })], 50, 3);
    expect(none.every((r) => r[0] !== null)).toBe(true);
  });
  it("nullRate = 0.5 はおおよそ半分が NULL (決定論的に検証)", () => {
    const rows = generateRows([spec({ strategy: "randomString", nullRate: 0.5 })], 400, 9);
    const nulls = rows.filter((r) => r[0] === null).length;
    expect(nulls).toBeGreaterThan(120);
    expect(nulls).toBeLessThan(280);
  });
  it("randomNumber は min..max に収まる (整数)", () => {
    const rows = generateRows(
      [spec({ strategy: "randomNumber", kind: "number", min: 5, max: 9 })],
      200,
      11,
    );
    for (const [v] of rows) {
      expect(typeof v).toBe("number");
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThanOrEqual(9);
      expect(Number.isInteger(v)).toBe(true);
    }
  });
  it("decimal 列の randomNumber は小数 2 桁で範囲内", () => {
    const rows = generateRows(
      [spec({ strategy: "randomNumber", kind: "decimal", min: 0, max: 10 })],
      100,
      13,
    );
    for (const [v] of rows) {
      expect(typeof v).toBe("number");
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(10);
      expect(Math.round((v as number) * 100) / 100).toBe(v);
    }
  });
  it("randomString は指定文字数の英数字", () => {
    const rows = generateRows([spec({ strategy: "randomString", length: 7 })], 30, 5);
    for (const [v] of rows) expect(v).toMatch(/^[A-Za-z0-9]{7}$/);
  });
  it("randomDate は書式ごとに正しい形になる", () => {
    const dt = generateRows([spec({ strategy: "randomDate", temporal: "datetime" })], 20, 17);
    for (const [v] of dt) expect(v).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const d = generateRows([spec({ strategy: "randomDate", temporal: "date" })], 20, 17);
    for (const [v] of d) expect(v).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const tm = generateRows([spec({ strategy: "randomDate", temporal: "time" })], 20, 17);
    for (const [v] of tm) expect(v).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
  it("uuid は v4 形式", () => {
    const rows = generateRows([spec({ strategy: "uuid" })], 20, 23);
    for (const [v] of rows) {
      expect(v).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });
  it("randomBool は真偽値", () => {
    const rows = generateRows([spec({ strategy: "randomBool", kind: "bool" })], 50, 29);
    expect(rows.some((r) => r[0] === true)).toBe(true);
    expect(rows.some((r) => r[0] === false)).toBe(true);
  });
  it("choice / fkRef は候補からのみ選び、候補が空なら NULL", () => {
    const rows = generateRows(
      [spec({ strategy: "choice", choices: ["a", "b"] })],
      100,
      31,
    );
    for (const [v] of rows) expect(["a", "b"]).toContain(v);
    const empty = generateRows([spec({ strategy: "fkRef", choices: [] })], 10, 31);
    expect(empty.every((r) => r[0] === null)).toBe(true);
  });
  it("fixed は型に応じて緩く変換される", () => {
    const rows = generateRows(
      [
        spec({ strategy: "fixed", fixedValue: "42", kind: "number" }),
        spec({ strategy: "fixed", fixedValue: "hello", kind: "string" }),
        spec({ strategy: "fixed", fixedValue: "true", kind: "bool" }),
        spec({ strategy: "fixed", fixedValue: "NULL", kind: "string" }),
      ],
      2,
      37,
    );
    expect(rows[0]).toEqual([42, "hello", true, null]);
  });
  it("omit のカラムは行に含まれない", () => {
    const specs = [
      spec({ column: "id", strategy: "omit" }),
      spec({ column: "name", strategy: "fixed", fixedValue: "x" }),
    ];
    expect(activeSpecs(specs).map((s) => s.column)).toEqual(["name"]);
    const rows = generateRows(specs, 2, 1);
    expect(rows[0]).toHaveLength(1);
  });
});

describe("coerceFixedValue", () => {
  it("NULL / 数値 / 真偽の緩い変換", () => {
    expect(coerceFixedValue("null", "string")).toBeNull();
    expect(coerceFixedValue("3.5", "decimal")).toBe(3.5);
    expect(coerceFixedValue("abc", "number")).toBe("abc");
    expect(coerceFixedValue("0", "bool")).toBe(false);
    expect(coerceFixedValue("1", "bool")).toBe(true);
    expect(coerceFixedValue("plain", "string")).toBe("plain");
    expect(coerceFixedValue("", "number")).toBe("");
  });
});

describe("buildTestDataInsertStatements", () => {
  it("MySQL はバッククオート + DB 修飾", () => {
    const sql = buildTestDataInsertStatements("mysql", "shop", "users", ["id", "name"], [[1, "a"]]);
    expect(sql).toEqual(["INSERT INTO `shop`.`users` (`id`, `name`) VALUES (1, 'a')"]);
  });
  it("PostgreSQL はダブルクオート + DB 修飾", () => {
    const sql = buildTestDataInsertStatements("postgres", "public", "users", ["id"], [[1]]);
    expect(sql).toEqual(['INSERT INTO "public"."users" ("id") VALUES (1)']);
  });
  it("SQLite は単一名前空間なので DB 修飾しない", () => {
    const sql = buildTestDataInsertStatements("sqlite", "main", "users", ["id"], [[1]]);
    expect(sql).toEqual(['INSERT INTO "users" ("id") VALUES (1)']);
  });
  it("バッチサイズごとに複数行 INSERT へまとめる", () => {
    const rows = Array.from({ length: 250 }, (_, i) => [i]);
    const sql = buildTestDataInsertStatements("mysql", "db", "t", ["n"], rows, 100);
    expect(sql).toHaveLength(3);
    expect(sql[0].match(/\(/g)?.length).toBe(101); // カラムリスト 1 + 値 100
    expect(sql[2]).toContain("(249)");
  });
  it("NULL / 真偽 / 文字列エスケープをリテラル化する", () => {
    const [sql] = buildTestDataInsertStatements(
      "mysql",
      "db",
      "t",
      ["a", "b", "c"],
      [[null, true, "it's \\ here"]],
    );
    expect(sql).toBe(
      "INSERT INTO `db`.`t` (`a`, `b`, `c`) VALUES (NULL, TRUE, 'it''s \\\\ here')",
    );
  });
  it("PostgreSQL はバックスラッシュを二重化しない", () => {
    const [sql] = buildTestDataInsertStatements("postgres", "db", "t", ["a"], [["x\\y"]]);
    expect(sql).toContain("'x\\y'");
  });
  it("空入力は空配列", () => {
    expect(buildTestDataInsertStatements("mysql", "db", "t", [], [[1]])).toEqual([]);
    expect(buildTestDataInsertStatements("mysql", "db", "t", ["a"], [])).toEqual([]);
  });
});

describe("buildFkSelectSql", () => {
  it("方言別クオートで参照先の既存値を取得する SELECT を作る", () => {
    expect(buildFkSelectSql("mysql", "shop", "users", "id", 500)).toBe(
      "SELECT DISTINCT `id` FROM `shop`.`users` WHERE `id` IS NOT NULL LIMIT 500",
    );
    expect(buildFkSelectSql("postgres", "public", "users", "id", 10)).toBe(
      'SELECT DISTINCT "id" FROM "public"."users" WHERE "id" IS NOT NULL LIMIT 10',
    );
    expect(buildFkSelectSql("sqlite", "main", "users", "id", 10)).toBe(
      'SELECT DISTINCT "id" FROM "users" WHERE "id" IS NOT NULL LIMIT 10',
    );
  });
  it("識別子内のクオート文字をエスケープする", () => {
    expect(buildFkSelectSql("mysql", "d", "we`ird", "c", 1)).toContain("`we``ird`");
  });
});
