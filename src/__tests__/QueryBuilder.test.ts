import { describe, it, expect } from "vitest";
import {
  quoteValue,
  quoteValueForColumn,
  computeBuilderBlockedReason,
  isLimitInvalid,
  showsNoWhereBand,
  isNullValueOnNotNullColumn,
  isRequiredColumn,
  buildSql,
  removeWhereCondition,
  hasAmbiguousAndOr,
  isOffsetInvalid,
  normalizeOffset,
  type WhereCondition,
  type ColumnValuePair,
  type OrderByItem,
} from "../components/QueryBuilder";
import type { TableColumnInfo } from "../api/tauri";

/** buildSql の長い位置引数を名前付きオプションで組み立てる、テスト専用ヘルパー。
 *  未指定のフィールドはすべて「そのドライバの既定の SELECT」相当の無害な値になる。 */
function buildSelectSql(
  driver: string,
  opts: {
    columns?: TableColumnInfo[];
    database?: string;
    table?: string;
    selectColumns?: string[];
    selectAll?: boolean;
    whereEnabled?: boolean;
    whereConditions?: WhereCondition[];
    orderBy?: OrderByItem[];
    limitEnabled?: boolean;
    limit?: string;
    offset?: string;
  } = {},
): string {
  return buildSql(
    driver,
    opts.columns ?? [],
    "SELECT",
    opts.database ?? "db",
    opts.table ?? "users",
    opts.selectColumns ?? [],
    opts.selectAll ?? true,
    opts.whereEnabled ?? false,
    opts.whereConditions ?? [],
    opts.orderBy ?? [],
    opts.limitEnabled ?? false,
    opts.limit ?? "",
    [],
    [],
    opts.offset,
  );
}

function makeColumnInfo(overrides: Partial<TableColumnInfo> = {}): TableColumnInfo {
  return {
    name: "col",
    data_type: "varchar",
    nullable: true,
    key: "",
    default: null,
    extra: "",
    referenced_table: null,
    referenced_column: null,
    ...overrides,
  };
}

// 修正7 の回帰テスト: バックスラッシュの二重化は MySQL のみ行うべきで、
// PostgreSQL (標準 standard_conforming_strings = on) と SQLite では
// バックスラッシュはただの文字なので二重化してはいけない。
describe("quoteValue", () => {
  it("doubles backslashes for MySQL", () => {
    expect(quoteValue("mysql", "C:\\temp")).toBe("'C:\\\\temp'");
  });

  it("does not double backslashes for PostgreSQL", () => {
    expect(quoteValue("postgres", "C:\\temp")).toBe("'C:\\temp'");
  });

  it("does not double backslashes for SQLite", () => {
    expect(quoteValue("sqlite", "C:\\temp")).toBe("'C:\\temp'");
  });

  it("still doubles single quotes for every driver", () => {
    expect(quoteValue("mysql", "O'Brien")).toBe("'O''Brien'");
    expect(quoteValue("postgres", "O'Brien")).toBe("'O''Brien'");
    expect(quoteValue("sqlite", "O'Brien")).toBe("'O''Brien'");
  });

  it("keeps existing NULL / numeric / boolean special-casing", () => {
    expect(quoteValue("mysql", "")).toBe("''");
    expect(quoteValue("mysql", "null")).toBe("NULL");
    expect(quoteValue("mysql", "42")).toBe("42");
    expect(quoteValue("mysql", "true")).toBe("TRUE");
    expect(quoteValue("sqlite", "true")).toBe("1");
    expect(quoteValue("sqlite", "false")).toBe("0");
  });
});

// 改善 1 の回帰テスト: 型が分かっているカラムでは値の見た目 (数字/true/false に
// 見えるかどうか) ではなく、カラムの実際の型で literal 化する。VARCHAR 列に
// "123" を入れても数値リテラルにならないことが正しさの核心。
describe("quoteValueForColumn", () => {
  it("always quotes a numeric-looking value on a string column (the correctness fix)", () => {
    const info = makeColumnInfo({ data_type: "varchar" });
    expect(quoteValueForColumn("mysql", "123", info)).toBe("'123'");
    expect(quoteValueForColumn("mysql", "true", info)).toBe("'true'");
  });

  it("emits a bare numeral for a numeric column", () => {
    const info = makeColumnInfo({ data_type: "int" });
    expect(quoteValueForColumn("mysql", "123", info)).toBe("123");
    expect(quoteValueForColumn("mysql", "3.5", info)).toBe("3.5");
    // Non-numeric text on a numeric column falls back to a quoted string
    // (best-effort — the server has the final say, same as `literalFromInput`).
    expect(quoteValueForColumn("mysql", "abc", info)).toBe("'abc'");
  });

  it("emits TRUE/FALSE for a boolean column, 1/0 on SQLite", () => {
    const info = makeColumnInfo({ data_type: "boolean" });
    expect(quoteValueForColumn("mysql", "true", info)).toBe("TRUE");
    expect(quoteValueForColumn("postgres", "false", info)).toBe("FALSE");
    expect(quoteValueForColumn("sqlite", "true", info)).toBe("1");
    // 0/1 spellings are also accepted for a boolean column.
    expect(quoteValueForColumn("mysql", "1", info)).toBe("TRUE");
    expect(quoteValueForColumn("mysql", "0", info)).toBe("FALSE");
  });

  it("treats the NULL keyword the same regardless of column type", () => {
    const info = makeColumnInfo({ data_type: "int" });
    expect(quoteValueForColumn("mysql", "null", info)).toBe("NULL");
    expect(quoteValueForColumn("mysql", "NULL", info)).toBe("NULL");
  });

  it("quotes a date/time value as a plain string literal", () => {
    const info = makeColumnInfo({ data_type: "datetime" });
    expect(quoteValueForColumn("mysql", "2024-01-01 12:00:00", info)).toBe("'2024-01-01 12:00:00'");
  });

  it("doubles backslashes for MySQL string columns only, matching quoteValue", () => {
    const info = makeColumnInfo({ data_type: "varchar" });
    expect(quoteValueForColumn("mysql", "C:\\temp", info)).toBe("'C:\\\\temp'");
    expect(quoteValueForColumn("postgres", "C:\\temp", info)).toBe("'C:\\temp'");
  });
});

describe("isNullValueOnNotNullColumn", () => {
  it("warns when a NOT NULL column's value is the NULL keyword", () => {
    const info = makeColumnInfo({ nullable: false });
    expect(isNullValueOnNotNullColumn("NULL", info)).toBe(true);
    expect(isNullValueOnNotNullColumn("null", info)).toBe(true);
    expect(isNullValueOnNotNullColumn("  null  ", info)).toBe(true);
  });

  it("does not warn on a nullable column, an unresolved column, or a non-NULL value", () => {
    expect(isNullValueOnNotNullColumn("NULL", makeColumnInfo({ nullable: true }))).toBe(false);
    expect(isNullValueOnNotNullColumn("NULL", undefined)).toBe(false);
    expect(isNullValueOnNotNullColumn("abc", makeColumnInfo({ nullable: false }))).toBe(false);
  });
});

describe("isLimitInvalid", () => {
  it("flags a non-numeric LIMIT while enabled", () => {
    expect(isLimitInvalid(true, "abc")).toBe(true);
    expect(isLimitInvalid(true, "10.5")).toBe(true);
    expect(isLimitInvalid(true, "-5")).toBe(true);
  });

  it("does not flag a valid number, an empty box, or a disabled LIMIT", () => {
    expect(isLimitInvalid(true, "100")).toBe(false);
    expect(isLimitInvalid(true, "")).toBe(false);
    expect(isLimitInvalid(true, "   ")).toBe(false);
    expect(isLimitInvalid(false, "abc")).toBe(false);
  });
});

describe("showsNoWhereBand", () => {
  it("shows the band only for UPDATE/DELETE with WHERE disabled", () => {
    expect(showsNoWhereBand("UPDATE", false)).toBe(true);
    expect(showsNoWhereBand("DELETE", false)).toBe(true);
    expect(showsNoWhereBand("UPDATE", true)).toBe(false);
    expect(showsNoWhereBand("DELETE", true)).toBe(false);
    expect(showsNoWhereBand("SELECT", false)).toBe(false);
    expect(showsNoWhereBand("INSERT", false)).toBe(false);
  });
});

// 改善 2-1 の回帰テスト: buildSql がプレースホルダ (<table>/<column>/<value>/
// <values>) を埋め込む条件と 1:1 対応していること。
describe("computeBuilderBlockedReason", () => {
  const emptyWhere: WhereCondition[] = [{ column: "", operator: "=", value: "" }];
  const filledWhere: WhereCondition[] = [{ column: "id", operator: "=", value: "1" }];
  const emptyPair: ColumnValuePair[] = [{ column: "", value: "" }];
  const filledPair: ColumnValuePair[] = [{ column: "name", value: "x" }];

  it("blocks when no table is selected, regardless of kind", () => {
    expect(
      computeBuilderBlockedReason({
        kind: "SELECT",
        table: "",
        whereEnabled: false,
        whereConditions: emptyWhere,
        setPairs: emptyPair,
        insertPairs: emptyPair,
      }),
    ).toBe("qbValidationNoTable");
  });

  it("blocks SELECT with all-columns off and no column chosen (#1615)", () => {
    const base = {
      kind: "SELECT" as const,
      table: "t",
      whereEnabled: false,
      whereConditions: emptyWhere,
      setPairs: emptyPair,
      insertPairs: emptyPair,
    };
    expect(computeBuilderBlockedReason({ ...base, selectAll: false, selectColumns: [] })).toBe(
      "qbValidationNoSelectColumns",
    );
    expect(computeBuilderBlockedReason({ ...base, selectAll: false, selectColumns: ["id"] })).toBeNull();
    expect(computeBuilderBlockedReason({ ...base, selectAll: true, selectColumns: [] })).toBeNull();
    // SELECT 以外には影響しない
    expect(
      computeBuilderBlockedReason({
        ...base,
        kind: "DELETE",
        whereEnabled: true,
        whereConditions: filledWhere,
        selectAll: false,
        selectColumns: [],
      }),
    ).toBeNull();
  });

  it("blocks INSERT with no filled column/value pair", () => {
    expect(
      computeBuilderBlockedReason({
        kind: "INSERT",
        table: "t",
        whereEnabled: false,
        whereConditions: emptyWhere,
        setPairs: emptyPair,
        insertPairs: emptyPair,
      }),
    ).toBe("qbValidationNoInsertValues");
    expect(
      computeBuilderBlockedReason({
        kind: "INSERT",
        table: "t",
        whereEnabled: false,
        whereConditions: emptyWhere,
        setPairs: emptyPair,
        insertPairs: filledPair,
      }),
    ).toBeNull();
  });

  it("blocks UPDATE with no filled SET pair", () => {
    expect(
      computeBuilderBlockedReason({
        kind: "UPDATE",
        table: "t",
        whereEnabled: false,
        whereConditions: emptyWhere,
        setPairs: emptyPair,
        insertPairs: emptyPair,
      }),
    ).toBe("qbValidationNoSetValues");
  });

  it("blocks SELECT/UPDATE/DELETE when WHERE is enabled but every condition is empty", () => {
    expect(
      computeBuilderBlockedReason({
        kind: "SELECT",
        table: "t",
        whereEnabled: true,
        whereConditions: emptyWhere,
        setPairs: emptyPair,
        insertPairs: emptyPair,
      }),
    ).toBe("qbValidationNoWhereConditions");
    expect(
      computeBuilderBlockedReason({
        kind: "DELETE",
        table: "t",
        whereEnabled: true,
        whereConditions: emptyWhere,
        setPairs: emptyPair,
        insertPairs: emptyPair,
      }),
    ).toBe("qbValidationNoWhereConditions");
  });

  it("does not block when WHERE is disabled or has a filled condition", () => {
    expect(
      computeBuilderBlockedReason({
        kind: "DELETE",
        table: "t",
        whereEnabled: false,
        whereConditions: emptyWhere,
        setPairs: emptyPair,
        insertPairs: emptyPair,
      }),
    ).toBeNull();
    expect(
      computeBuilderBlockedReason({
        kind: "SELECT",
        table: "t",
        whereEnabled: true,
        whereConditions: filledWhere,
        setPairs: emptyPair,
        insertPairs: emptyPair,
      }),
    ).toBeNull();
  });

  it("does not require WHERE for INSERT even when enabled would be meaningless", () => {
    expect(
      computeBuilderBlockedReason({
        kind: "INSERT",
        table: "t",
        whereEnabled: true,
        whereConditions: emptyWhere,
        setPairs: emptyPair,
        insertPairs: filledPair,
      }),
    ).toBeNull();
  });
});

describe("isRequiredColumn", () => {
  it("flags a NOT NULL column with no default and no auto-generation", () => {
    const info = makeColumnInfo({ nullable: false, default: null, extra: "" });
    expect(isRequiredColumn(info)).toBe(true);
  });

  it("does not flag a nullable column", () => {
    expect(isRequiredColumn(makeColumnInfo({ nullable: true, default: null }))).toBe(false);
  });

  it("does not flag a NOT NULL column that has a default value", () => {
    expect(isRequiredColumn(makeColumnInfo({ nullable: false, default: "0" }))).toBe(false);
  });

  it("does not flag an auto-incrementing NOT NULL column", () => {
    expect(
      isRequiredColumn(
        makeColumnInfo({ nullable: false, default: null, extra: "auto_increment", key: "PRI" }),
      ),
    ).toBe(false);
  });

  it("does not flag a generated column", () => {
    expect(
      isRequiredColumn(makeColumnInfo({ nullable: false, default: null, extra: "STORED GENERATED" })),
    ).toBe(false);
  });

  it("treats a missing column (free-typed name) as not required", () => {
    expect(isRequiredColumn(undefined)).toBe(false);
    expect(isRequiredColumn(null)).toBe(false);
  });
});

// ORDER BY (SELECT のみ) の buildSql 回帰テスト。3 ドライバとも ORDER BY は
// LIMIT の前に来る — この並びを固定する。
describe("buildSql — ORDER BY", () => {
  const oneAsc: OrderByItem[] = [{ column: "name", direction: "ASC" }];
  const twoTerms: OrderByItem[] = [
    { column: "name", direction: "ASC" },
    { column: "created_at", direction: "DESC" },
  ];

  it("places ORDER BY after WHERE and before LIMIT for MySQL", () => {
    const out = buildSelectSql("mysql", {
      whereEnabled: true,
      whereConditions: [{ column: "id", operator: "=", value: "1" }],
      orderBy: oneAsc,
      limitEnabled: true,
      limit: "10",
    });
    expect(out).toBe("SELECT * FROM `db`.`users` WHERE `id` = 1 ORDER BY `name` ASC LIMIT 10;");
  });

  it("renders multiple ORDER BY terms comma-separated, quoted per driver", () => {
    expect(buildSelectSql("postgres", { orderBy: twoTerms })).toBe(
      'SELECT * FROM "db"."users" ORDER BY "name" ASC, "created_at" DESC;',
    );
    expect(buildSelectSql("sqlite", { orderBy: twoTerms, database: "" })).toBe(
      'SELECT * FROM "users" ORDER BY "name" ASC, "created_at" DESC;',
    );
  });

  it("omits the ORDER BY clause entirely when every row has a blank column", () => {
    const blank: OrderByItem[] = [{ column: "", direction: "ASC" }];
    expect(buildSelectSql("mysql", { orderBy: blank })).toBe("SELECT * FROM `db`.`users`;");
  });

  it("ignores a blank row while keeping a filled one alongside it", () => {
    const mixed: OrderByItem[] = [{ column: "", direction: "DESC" }, ...oneAsc];
    expect(buildSelectSql("mysql", { orderBy: mixed })).toBe(
      "SELECT * FROM `db`.`users` ORDER BY `name` ASC;",
    );
  });
});

describe("INSERT の空欄は DEFAULT (#1527)", () => {
  const cols = [
    makeColumnInfo({ name: "status", data_type: "varchar", default: "new" }),
    makeColumnInfo({ name: "note", data_type: "varchar", default: null }),
  ];
  const insert = (driver: string, pairs: ColumnValuePair[]) =>
    buildSql(driver, cols, "INSERT", "db", "t", [], true, false, [], [], false, "", [], pairs);

  it("MySQL / PostgreSQL は DEFAULT キーワードを出す", () => {
    const pairs = [
      { column: "status", value: "" },
      { column: "note", value: "x" },
    ];
    expect(insert("mysql", pairs)).toBe("INSERT INTO `db`.`t` (`status`, `note`) VALUES (DEFAULT, 'x');");
    expect(insert("postgres", pairs)).toBe(
      'INSERT INTO "db"."t" ("status", "note") VALUES (DEFAULT, \'x\');',
    );
  });

  it("SQLite は VALUES に DEFAULT を書けないので列ごと省く", () => {
    const pairs = [
      { column: "status", value: "" },
      { column: "note", value: "x" },
    ];
    expect(insert("sqlite", pairs)).toBe('INSERT INTO "t" ("note") VALUES (\'x\');');
    expect(insert("sqlite", [{ column: "status", value: "" }])).toBe('INSERT INTO "t" DEFAULT VALUES;');
  });

  it("既定値の無い列の空欄は従来どおり空文字", () => {
    expect(insert("mysql", [{ column: "note", value: "" }])).toBe(
      "INSERT INTO `db`.`t` (`note`) VALUES ('');",
    );
  });
});

describe("IN の値が空なら Run をブロックする (#1527)", () => {
  const base = {
    kind: "SELECT" as const,
    table: "t",
    whereEnabled: true,
    setPairs: [],
    insertPairs: [],
  };
  it("空・区切りのみはブロック、値があれば通す", () => {
    expect(
      computeBuilderBlockedReason({
        ...base,
        whereConditions: [{ column: "id", operator: "IN", value: " , " }],
      }),
    ).toBe("qbValidationNoInValues");
    expect(
      computeBuilderBlockedReason({
        ...base,
        whereConditions: [{ column: "id", operator: "in", value: "1,2" }],
      }),
    ).toBeNull();
  });
});

// WHERE の OR / 括弧グループ (#1540)。既存の AND のみの出力が変わらないことを固定する。
describe("buildSql — WHERE の AND / OR とグループ", () => {
  const cond = (column: string, value: string, extra: Partial<WhereCondition> = {}): WhereCondition => ({
    column,
    operator: "=",
    value,
    ...extra,
  });
  const where = (conds: WhereCondition[], driver = "mysql") =>
    buildSelectSql(driver, { whereEnabled: true, whereConditions: conds });

  it("connector / group 指定なし (旧スナップショット) は従来どおり AND のみ", () => {
    expect(where([cond("a", "1"), cond("b", "2"), cond("c", "3")])).toBe(
      "SELECT * FROM `db`.`users` WHERE `a` = 1 AND `b` = 2 AND `c` = 3;",
    );
    expect(where([cond("a", "1", { connector: "AND", groupWithPrevious: false }), cond("b", "2")])).toBe(
      "SELECT * FROM `db`.`users` WHERE `a` = 1 AND `b` = 2;",
    );
  });

  it("OR でつなげる (括弧なしでは SQL の優先順位どおり平坦に出す)", () => {
    expect(where([cond("a", "1"), cond("b", "2", { connector: "OR" })])).toBe(
      "SELECT * FROM `db`.`users` WHERE `a` = 1 OR `b` = 2;",
    );
  });

  it("グループ先頭の connector が前後との結合: A AND (B OR C)", () => {
    expect(
      where([
        cond("a", "1"),
        cond("b", "2", { connector: "AND" }),
        cond("c", "3", { connector: "OR", groupWithPrevious: true }),
      ]),
    ).toBe("SELECT * FROM `db`.`users` WHERE `a` = 1 AND (`b` = 2 OR `c` = 3);");
  });

  it("先頭グループと後続: (A OR B) AND C", () => {
    expect(
      where([
        cond("a", "1"),
        cond("b", "2", { connector: "OR", groupWithPrevious: true }),
        cond("c", "3", { connector: "AND" }),
      ]),
    ).toBe("SELECT * FROM `db`.`users` WHERE (`a` = 1 OR `b` = 2) AND `c` = 3;");
  });

  it("グループが 1 つだけで全体を覆うときは括弧を付けない", () => {
    expect(where([cond("a", "1"), cond("b", "2", { connector: "OR", groupWithPrevious: true })])).toBe(
      "SELECT * FROM `db`.`users` WHERE `a` = 1 OR `b` = 2;",
    );
  });

  it("複数グループ: (A OR B) OR (C AND D)", () => {
    expect(
      where([
        cond("a", "1"),
        cond("b", "2", { connector: "OR", groupWithPrevious: true }),
        cond("c", "3", { connector: "OR" }),
        cond("d", "4", { connector: "AND", groupWithPrevious: true }),
      ]),
    ).toBe("SELECT * FROM `db`.`users` WHERE (`a` = 1 OR `b` = 2) OR (`c` = 3 AND `d` = 4);");
  });

  it("先頭条件の connector / groupWithPrevious は無視する", () => {
    expect(where([cond("a", "1", { connector: "OR", groupWithPrevious: true }), cond("b", "2")])).toBe(
      "SELECT * FROM `db`.`users` WHERE `a` = 1 AND `b` = 2;",
    );
  });

  it("空の列の条件は取り除かれるが、グループは空行を落とす前の並びで確定する", () => {
    expect(
      where([
        cond("a", "1"),
        cond("", "", { connector: "OR" }),
        cond("c", "3", { connector: "OR", groupWithPrevious: true }),
        cond("d", "4"),
      ]),
    ).toBe("SELECT * FROM `db`.`users` WHERE `a` = 1 OR `c` = 3 AND `d` = 4;");
  });

  it("IN / IS NULL を含み、3 ドライバで識別子の引用が揃う", () => {
    const conds: WhereCondition[] = [
      { column: "a", operator: "IN", value: "1, 2" },
      { column: "b", operator: "IS NULL", value: "", connector: "OR" },
    ];
    expect(where(conds, "postgres")).toBe('SELECT * FROM "db"."users" WHERE "a" IN (1, 2) OR "b" IS NULL;');
    expect(buildSelectSql("sqlite", { whereEnabled: true, whereConditions: conds, database: "" })).toBe(
      'SELECT * FROM "users" WHERE "a" IN (1, 2) OR "b" IS NULL;',
    );
  });

  it("UPDATE / DELETE でも OR / グループが効く", () => {
    const sql = buildSql(
      "mysql",
      [],
      "DELETE",
      "db",
      "users",
      [],
      true,
      true,
      [cond("a", "1"), cond("b", "2", { connector: "OR" }), cond("c", "3", { connector: "AND" })],
      [],
      false,
      "",
      [],
      [],
    );
    expect(sql).toBe("DELETE FROM `db`.`users` WHERE `a` = 1 OR `b` = 2 AND `c` = 3;");
  });
});

// レビュー指摘: 空行・グループ先頭の削除で AND が OR に化けない (#1540)。
describe("WHERE のグループ: 空行と削除", () => {
  const cond = (column: string, extra: Partial<WhereCondition> = {}): WhereCondition => ({
    column,
    operator: "=",
    value: "1",
    ...extra,
  });
  const where = (conds: WhereCondition[]) =>
    buildSelectSql("mysql", { whereEnabled: true, whereConditions: conds });

  it("空行を挟んでも、グループ化した行は独立グループの結合子を保つ (AND が OR に化けない)", () => {
    // a / (空) / c(OR, グループ化) → 空行がグループ先頭なので c は空行のグループに属し、
    // a とは空行の connector (AND) で結ばれる。
    const sql = where([
      cond("a"),
      cond("", { connector: "AND" }),
      cond("c", { connector: "OR", groupWithPrevious: true }),
    ]);
    expect(sql).toContain("WHERE `a` = 1 AND `c` = 1");
    expect(sql).not.toContain(" OR ");
  });

  it("グループ内で最初に残った行の connector は捨てる", () => {
    const sql = where([
      cond("a"),
      cond("", { connector: "AND" }),
      cond("c", { connector: "OR", groupWithPrevious: true }),
      cond("d", { connector: "OR", groupWithPrevious: true }),
    ]);
    expect(sql).toContain("WHERE `a` = 1 AND (`c` = 1 OR `d` = 1)");
  });

  it("グループ全体が空ならそのグループは出さない", () => {
    expect(
      where([cond("a"), cond("", { connector: "OR" }), cond("", { groupWithPrevious: true })]),
    ).toContain("WHERE `a` = 1");
  });

  it("グループ先頭を消すと次の行が昇格し、消した行の connector を引き継ぐ (A AND (B OR C) から B を削除)", () => {
    const list = [
      cond("a"),
      cond("b", { connector: "AND" }),
      cond("c", { connector: "OR", groupWithPrevious: true }),
    ];
    const next = removeWhereCondition(list, 1);
    expect(next.map((c) => c.column)).toEqual(["a", "c"]);
    expect(next[1]).toMatchObject({ groupWithPrevious: false, connector: "AND" });
    expect(where(next)).toContain("WHERE `a` = 1 AND `c` = 1");
  });

  it("グループの途中の行を消してもグループ構造は変わらない", () => {
    const list = [
      cond("a"),
      cond("b", { connector: "AND" }),
      cond("c", { connector: "OR", groupWithPrevious: true }),
      cond("d", { connector: "OR", groupWithPrevious: true }),
    ];
    const next = removeWhereCondition(list, 2);
    expect(next[2]).toMatchObject({ column: "d", groupWithPrevious: true });
  });

  it("先頭行を消したら新しい先頭は独立した行になる", () => {
    const next = removeWhereCondition([cond("a"), cond("b", { groupWithPrevious: true })], 0);
    expect(next).toHaveLength(1);
    expect(next[0].groupWithPrevious).toBe(false);
  });
});

describe("hasAmbiguousAndOr", () => {
  const c = (column: string, extra: Partial<WhereCondition> = {}): WhereCondition => ({
    column,
    operator: "=",
    value: "1",
    ...extra,
  });
  it("AND だけ / OR だけ / 括弧で括った混在は警告しない", () => {
    expect(hasAmbiguousAndOr([c("a"), c("b"), c("c")])).toBe(false);
    expect(hasAmbiguousAndOr([c("a"), c("b", { connector: "OR" }), c("c", { connector: "OR" })])).toBe(false);
    expect(
      hasAmbiguousAndOr([
        c("a"),
        c("b", { connector: "AND" }),
        c("c", { connector: "OR", groupWithPrevious: true }),
      ]),
    ).toBe(false);
  });
  it("単一グループ (括弧が付かない) の中身の AND/OR 混在も警告する: a / b(OR,グループ) / c(AND,グループ)", () => {
    expect(
      hasAmbiguousAndOr([
        c("a"),
        c("b", { connector: "OR", groupWithPrevious: true }),
        c("c", { connector: "AND", groupWithPrevious: true }),
      ]),
    ).toBe(true);
  });
  it("最上位で AND と OR が混ざると警告する", () => {
    expect(hasAmbiguousAndOr([c("a"), c("b", { connector: "OR" }), c("c", { connector: "AND" })])).toBe(true);
  });
});

describe("WHERE の BETWEEN / NOT IN / NOT LIKE (#1627)", () => {
  const where = (c: Partial<WhereCondition> & { operator: string }, columns: TableColumnInfo[] = []) =>
    buildSelectSql("mysql", {
      columns,
      whereEnabled: true,
      whereConditions: [{ column: "age", value: "", ...c }],
    });
  const num = makeColumnInfo({ name: "age", data_type: "int" });
  const str = makeColumnInfo({ name: "name", data_type: "varchar" });

  it("BETWEEN は下端・上端を型に応じて組み立てる", () => {
    expect(where({ operator: "BETWEEN", value: "18", value2: "65" }, [num])).toBe(
      "SELECT * FROM `db`.`users` WHERE `age` BETWEEN 18 AND 65;",
    );
    expect(where({ column: "name", operator: "between", value: "a", value2: "m" }, [str])).toBe(
      "SELECT * FROM `db`.`users` WHERE `name` BETWEEN 'a' AND 'm';",
    );
    // 未入力はプレースホルダ (Run はブロックされる)。
    expect(where({ operator: "BETWEEN", value: "1" }, [num])).toContain("BETWEEN 1 AND <value>");
  });

  it("NOT IN は IN と同じ分割・リテラル化で NOT IN (...) を出す", () => {
    expect(where({ operator: "NOT IN", value: "1, 2 ,3" }, [num])).toContain("`age` NOT IN (1, 2, 3)");
    expect(where({ operator: "not  in", value: "" }, [num])).toContain("NOT IN (<values>)");
  });

  it("NOT LIKE は値をそのまま使う", () => {
    expect(where({ column: "name", operator: "NOT LIKE", value: "a%" }, [str])).toContain(
      "`name` NOT LIKE 'a%'",
    );
  });

  it("含む / 前方一致 / 後方一致は % と _ と \\ をエスケープして ESCAPE 句を付ける", () => {
    const c = (operator: string, value: string, driver = "mysql") =>
      buildSelectSql(driver, {
        columns: [str],
        whereEnabled: true,
        whereConditions: [{ column: "name", operator, value }],
      });
    expect(c("CONTAINS", "50%_off")).toContain("`name` LIKE '%50\\\\%\\\\_off%' ESCAPE '\\\\'");
    expect(c("STARTS WITH", "ab", "postgres")).toContain(`"name" LIKE 'ab%' ESCAPE '\\'`);
    expect(c("ends with", "a\\b", "sqlite")).toContain(`"name" LIKE '%a\\\\b' ESCAPE '\\'`);
  });

  it("PostgreSQL は文字列でない列を CAST してから LIKE する", () => {
    const sql = buildSelectSql("postgres", {
      columns: [num],
      whereEnabled: true,
      whereConditions: [{ column: "age", operator: "CONTAINS", value: "1" }],
    });
    expect(sql).toContain(`CAST("age" AS TEXT) LIKE '%1%' ESCAPE '\\'`);
    // MySQL / SQLite は暗黙変換で動くので CAST しない。
    expect(
      buildSelectSql("mysql", {
        columns: [num],
        whereEnabled: true,
        whereConditions: [{ column: "age", operator: "CONTAINS", value: "1" }],
      }),
    ).not.toContain("CAST");
  });

  it("BETWEEN は両端が揃うまで Run をブロックし、NOT IN は値が無いとブロックする", () => {
    const base = {
      kind: "SELECT" as const,
      table: "users",
      whereEnabled: true,
      setPairs: [],
      insertPairs: [],
    };
    const block = (c: WhereCondition) => computeBuilderBlockedReason({ ...base, whereConditions: [c] });
    expect(block({ column: "age", operator: "BETWEEN", value: "1" })).toBe("qbValidationNoBetweenValues");
    expect(block({ column: "age", operator: "BETWEEN", value: "", value2: "2" })).toBe(
      "qbValidationNoBetweenValues",
    );
    expect(block({ column: "age", operator: "BETWEEN", value: "1", value2: "2" })).toBeNull();
    expect(block({ column: "age", operator: "NOT IN", value: " , " })).toBe("qbValidationNoInValues");
    expect(block({ column: "age", operator: "NOT IN", value: "1" })).toBeNull();
  });
});

describe("SELECT の OFFSET (#1627)", () => {
  it("LIMIT n OFFSET m を出す。0・空・不正な値は出さない", () => {
    const sql = (offset: string, extra: { limitEnabled?: boolean; limit?: string } = {}) =>
      buildSelectSql("mysql", { limitEnabled: true, limit: "50", offset, ...extra });
    expect(sql("100")).toBe("SELECT * FROM `db`.`users` LIMIT 50 OFFSET 100;");
    expect(sql(" 007 ")).toContain("LIMIT 50 OFFSET 7;");
    expect(sql("0")).toBe("SELECT * FROM `db`.`users` LIMIT 50;");
    expect(sql("")).toBe("SELECT * FROM `db`.`users` LIMIT 50;");
    expect(sql("-1")).toBe("SELECT * FROM `db`.`users` LIMIT 50;");
    expect(sql("1.5")).toBe("SELECT * FROM `db`.`users` LIMIT 50;");
    // 桁数の大きい値も丸めない。
    expect(sql("9007199254740993")).toContain("OFFSET 9007199254740993");
  });

  it("LIMIT が無効・不正なら OFFSET も出さない (MySQL / SQLite は LIMIT なしの OFFSET を受けない)", () => {
    for (const driver of ["mysql", "postgres", "sqlite"]) {
      expect(buildSelectSql(driver, { limitEnabled: false, limit: "50", offset: "10" })).not.toContain(
        "OFFSET",
      );
      expect(buildSelectSql(driver, { limitEnabled: true, limit: "", offset: "10" })).not.toContain("OFFSET");
      expect(buildSelectSql(driver, { limitEnabled: true, limit: "5", offset: "10" })).toContain(
        "LIMIT 5 OFFSET 10",
      );
    }
  });

  it("ORDER BY の後ろに付く", () => {
    expect(
      buildSelectSql("postgres", {
        orderBy: [{ column: "id", direction: "DESC" }],
        limitEnabled: true,
        limit: "10",
        offset: "20",
      }),
    ).toBe('SELECT * FROM "db"."users" ORDER BY "id" DESC LIMIT 10 OFFSET 20;');
  });

  it("normalizeOffset / isOffsetInvalid", () => {
    expect(normalizeOffset("0010")).toBe("10");
    expect(normalizeOffset("000")).toBe("");
    expect(normalizeOffset("x")).toBe("");
    expect(isOffsetInvalid("")).toBe(false);
    expect(isOffsetInvalid("  ")).toBe(false);
    expect(isOffsetInvalid("12")).toBe(false);
    expect(isOffsetInvalid("-3")).toBe(true);
    expect(isOffsetInvalid("1e3")).toBe(true);
  });
});
