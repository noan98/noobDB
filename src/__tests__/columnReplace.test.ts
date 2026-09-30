import { describe, it, expect } from "vitest";
import type { CellValue, Column } from "../api/tauri";
import {
  buildColumnReplaceSql,
  columnReplaceUnsupported,
  buildReplacer,
  escapeRegexLiteral,
  isTextColumnType,
  planGridReplace,
  replaceInText,
  type ColumnReplaceSqlInput,
} from "../components/columnReplace";
import { buildUpdateStatements, type PendingEdits, validateCellInput } from "../components/cellEdit";

const cs = { caseSensitive: true, regex: false };
const ci = { caseSensitive: false, regex: false };
const re = { caseSensitive: true, regex: true };

function base(over: Partial<ColumnReplaceSqlInput> = {}): ColumnReplaceSqlInput {
  return {
    driver: "mysql",
    database: "app",
    table: "users",
    column: "url",
    find: "http://",
    replace: "https://",
    options: cs,
    ...over,
  };
}

function sqlOf(input: ColumnReplaceSqlInput): string {
  const r = buildColumnReplaceSql(input);
  if (!r.ok) throw new Error(`unexpected: ${r.reason}`);
  return r.sql;
}

describe("buildColumnReplaceSql: 通常置換 (3 ドライバ)", () => {
  it("MySQL は REPLACE + INSTR で絞り込む", () => {
    expect(sqlOf(base())).toBe(
      "UPDATE `app`.`users` SET `url` = REPLACE(`url`, 'http://', 'https://') WHERE INSTR(`url`, 'http://') > 0;",
    );
  });
  it("PostgreSQL は REPLACE + POSITION", () => {
    expect(sqlOf(base({ driver: "postgres" }))).toBe(
      'UPDATE "app"."users" SET "url" = REPLACE("url", \'http://\', \'https://\') WHERE POSITION(\'http://\' IN "url") > 0;',
    );
  });
  it("SQLite はデータベース修飾なし", () => {
    expect(sqlOf(base({ driver: "sqlite" }))).toBe(
      'UPDATE "users" SET "url" = REPLACE("url", \'http://\', \'https://\') WHERE INSTR("url", \'http://\') > 0;',
    );
  });
  it("MySQL はバックスラッシュと引用符をエスケープ、PostgreSQL / SQLite はバックスラッシュをそのまま", () => {
    const i = { find: "a\\b'", replace: "c\\d" };
    expect(sqlOf(base(i))).toContain("REPLACE(`url`, 'a\\\\b''', 'c\\\\d')");
    expect(sqlOf(base({ ...i, driver: "postgres" }))).toContain("REPLACE(\"url\", 'a\\b''', 'c\\d')");
    expect(sqlOf(base({ ...i, driver: "sqlite" }))).toContain("REPLACE(\"url\", 'a\\b''', 'c\\d')");
  });
  it("識別子の引用符もエスケープする", () => {
    expect(sqlOf(base({ column: "we`ird" }))).toContain("`we``ird`");
    expect(sqlOf(base({ driver: "postgres", column: 'we"ird' }))).toContain('"we""ird"');
  });
  it("空の検索文字列は組み立てない", () => {
    expect(buildColumnReplaceSql(base({ find: "" }))).toEqual({ ok: false, reason: "emptyFind" });
  });
  it("空の置換文字列 (削除) は許可する", () => {
    expect(sqlOf(base({ replace: "" }))).toContain("REPLACE(`url`, 'http://', '')");
  });
  it("extraWhere は括弧で包んで AND 連結する", () => {
    expect(sqlOf(base({ extraWhere: "`id` > 5" }))).toContain(
      "WHERE (`id` > 5) AND INSTR(`url`, 'http://') > 0;",
    );
    expect(sqlOf(base({ extraWhere: "   " }))).toContain("WHERE INSTR(");
  });
});

describe("buildColumnReplaceSql: 大小無視・正規表現", () => {
  it("PostgreSQL 正規表現は regexp_replace + ~ (大小区別)", () => {
    expect(sqlOf(base({ driver: "postgres", find: "a(\\d+)", replace: "b\\1", options: re }))).toBe(
      'UPDATE "app"."users" SET "url" = regexp_replace("url", \'a(\\d+)\', \'b\\1\', \'g\') WHERE "url" ~ \'a(\\d+)\';',
    );
  });
  it("PostgreSQL 大小無視の通常検索はメタ文字をエスケープし gi / ~*", () => {
    const sql = sqlOf(base({ driver: "postgres", find: "a.b", replace: "x\\y", options: ci }));
    expect(sql).toContain("regexp_replace(\"url\", 'a\\.b', 'x\\\\y', 'gi')");
    expect(sql).toContain("\"url\" ~* 'a\\.b'");
  });
  it("MySQL 8 正規表現は REGEXP_REPLACE (pos 1 / occurrence 0 / match_type)", () => {
    expect(sqlOf(base({ find: "^a+", replace: "$1", options: re }))).toBe(
      "UPDATE `app`.`users` SET `url` = REGEXP_REPLACE(`url`, '^a+', '$1', 1, 0, 'c') WHERE REGEXP_LIKE(`url`, '^a+', 'c');",
    );
    expect(sqlOf(base({ find: "a", options: { caseSensitive: false, regex: true } }))).toContain(
      "REGEXP_REPLACE(`url`, 'a', 'https://', 1, 0, 'i')",
    );
  });
  it("MySQL 大小無視の通常検索は '$' と '\\' を文字どおりに直し、リテラルの二重化も行う", () => {
    const sql = sqlOf(base({ find: "a+b", replace: "$1\\", options: ci }));
    // 置換側: $ → \$、\ → \\、その後 MySQL リテラルとして \ を二重化。
    expect(sql).toContain("'\\\\$1\\\\\\\\'");
    expect(sql).toContain("REGEXP_REPLACE(`url`, 'a\\\\+b'");
  });
  it("SQLite は正規表現・大小無視を拒否する", () => {
    expect(buildColumnReplaceSql(base({ driver: "sqlite", options: re }))).toEqual({
      ok: false,
      reason: "sqliteRegex",
    });
    expect(buildColumnReplaceSql(base({ driver: "sqlite", options: ci }))).toEqual({
      ok: false,
      reason: "sqliteCaseInsensitive",
    });
    expect(columnReplaceUnsupported("sqlite", cs)).toBeNull();
    expect(columnReplaceUnsupported("mysql", re)).toBeNull();
    expect(columnReplaceUnsupported("postgres", ci)).toBeNull();
  });
});

describe("補助関数", () => {
  it("isTextColumnType", () => {
    for (const t of ["VARCHAR", "text", "LONGTEXT", "CHAR", "character varying", "BPCHAR", "nvarchar"]) {
      expect(isTextColumnType(t)).toBe(true);
    }
    for (const t of ["INT", "BLOB", "BYTEA", "JSON", "DATETIME", "", "BINARY", "VARBINARY"]) {
      expect(isTextColumnType(t)).toBe(false);
    }
  });
  it("escapeRegexLiteral", () => {
    expect(escapeRegexLiteral("a.b*c(d)[e]{f}|g^h$i\\j+k?")).toBe(
      "a\\.b\\*c\\(d\\)\\[e\\]\\{f\\}\\|g\\^h\\$i\\\\j\\+k\\?",
    );
  });
  it("replaceInText: 通常は置換文字列を文字どおりに扱う", () => {
    expect(replaceInText("a.b.c", ".", "$&", cs)).toBe("a$&b$&c");
    expect(replaceInText("Foo foo", "foo", "x", ci)).toBe("x x");
    expect(replaceInText("Foo foo", "foo", "x", cs)).toBe("Foo x");
  });
  it("replaceInText: 正規表現は後方参照が使え、不正なら null", () => {
    expect(replaceInText("ab12", "(\\d+)", "<$1>", re)).toBe("ab<12>");
    expect(replaceInText("x", "(", "y", re)).toBeNull();
  });
});

describe("planGridReplace", () => {
  const columns: Column[] = [
    { name: "id", type_name: "INT" },
    { name: "url", type_name: "VARCHAR" },
    { name: "n", type_name: "INT" },
  ];
  const rows: CellValue[][] = [
    [1, "http://a.com", 10],
    [2, "https://b.com", 20],
    [3, null, 30],
    [4, "http://c.com http://d.com", 40],
  ];
  const run = (over: Record<string, unknown> = {}) =>
    planGridReplace({
      rows,
      columns,
      pkIndices: [0],
      colIdx: 1,
      find: "http://",
      replace: "https://",
      options: cs,
      isColEditable: () => true,
      validate: (c, v) => validateCellInput(v, columns[c].type_name, true),
      ...over,
    });

  it("ヒットした行だけを置換対象にし、SQL は個別 UPDATE になる", () => {
    const plan = run();
    expect(plan.hitCount).toBe(2);
    expect(plan.rowCount).toBe(2);
    const edits: PendingEdits = {};
    for (const e of plan.applied) (edits[e.rowKey] ??= {})[e.colIdx] = e.value as string;
    const stmts = buildUpdateStatements({
      driver: "mysql",
      database: "app",
      table: "users",
      columns,
      rows,
      pkIndices: [0],
      edits,
    });
    expect(stmts).toEqual([
      "UPDATE `app`.`users` SET `url` = 'https://a.com' WHERE `id` = 1;",
      "UPDATE `app`.`users` SET `url` = 'https://c.com https://d.com' WHERE `id` = 4;",
    ]);
  });
  it("PK が無ければ全ヒットをスキップ", () => {
    const plan = run({ pkIndices: [] });
    expect(plan.applied).toEqual([]);
    expect(plan.skippedNoPk).toBe(2);
  });
  it("編集不可列 (BLOB 等) は全ヒットをスキップ", () => {
    const plan = run({ isColEditable: () => false });
    expect(plan.applied).toEqual([]);
    expect(plan.skippedReadonly).toBe(2);
  });
  it("置換結果が列型に不正なセルはスキップ (数値列)", () => {
    const plan = run({ colIdx: 2, find: "0", replace: "x" });
    expect(plan.hitCount).toBe(4);
    expect(plan.applied).toEqual([]);
    expect(plan.skippedInvalid).toBe(4);
  });
  it("置換結果が 'NULL' になるセルは文字列として書けないのでスキップ", () => {
    const plan = run({ find: "http://a.com", replace: "null" });
    expect(plan.applied).toEqual([]);
    expect(plan.skippedInvalid).toBe(1);
  });
  it("値が変わらないヒット (空マッチの正規表現) は unchanged", () => {
    const plan = run({ find: "^", replace: "", options: re });
    expect(plan.applied).toEqual([]);
    expect(plan.unchanged).toBe(3);
  });
  it("大小無視・正規表現・不正な正規表現", () => {
    expect(run({ find: "HTTP://", options: ci }).applied).toHaveLength(2);
    expect(run({ find: "HTTP://", options: cs }).hitCount).toBe(0);
    expect(run({ find: "http://(\\w)", replace: "$1-", options: re }).applied[0].value).toBe("a-.com");
    expect(run({ find: "(", options: re }).invalidRegex).toBe(true);
  });
  it("空の検索文字列は何もしない", () => {
    expect(run({ find: "" }).hitCount).toBe(0);
  });
});

describe("buildReplacer (#1257)", () => {
  const cs = { caseSensitive: true, regex: false };

  it("replaceInText と同じ結果を、RegExp を 1 回だけコンパイルして返す", () => {
    const cases: Array<[string, string, string, { caseSensitive: boolean; regex: boolean }]> = [
      ["a.b a.b", ".", "-", cs],
      ["Foo foo FOO", "foo", "x", { caseSensitive: false, regex: false }],
      ["a1 b22", "(\\d+)", "<$1>", { caseSensitive: true, regex: true }],
      ["cost $5", "$5", "$&", cs],
    ];
    for (const [text, find, rep, opts] of cases) {
      const replacer = buildReplacer(find, rep, opts);
      expect(replacer, find).not.toBeNull();
      expect(replacer?.(text), find).toBe(replaceInText(text, find, rep, opts));
    }
  });

  it("同じ replacer を繰り返し使っても結果が変わらない (g フラグの lastIndex 持ち越しなし)", () => {
    const replacer = buildReplacer("a", "b", cs);
    expect(replacer?.("aaa")).toBe("bbb");
    expect(replacer?.("aaa")).toBe("bbb");
    expect(replacer?.("xax")).toBe("xbx");
  });

  it("不正な正規表現は null", () => {
    expect(buildReplacer("(", "x", { caseSensitive: true, regex: true })).toBeNull();
  });
});
