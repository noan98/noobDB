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

  it("emits TRUE/FALSE for a boolean column, 1/0 on SQLite/MSSQL", () => {
    const info = makeColumnInfo({ data_type: "boolean" });
    expect(quoteValueForColumn("mysql", "true", info)).toBe("TRUE");
    expect(quoteValueForColumn("postgres", "false", info)).toBe("FALSE");
    expect(quoteValueForColumn("sqlite", "true", info)).toBe("1");
    expect(quoteValueForColumn("mssql", "false", info)).toBe("0");
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
    expect(quoteValueForColumn("mysql", "2024-01-01 12:00:00", info)).toBe(
      "'2024-01-01 12:00:00'",
    );
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

// ORDER BY (SELECT のみ) の buildSql 回帰テスト。特に MSSQL は TOP (n) を
// SELECT 直後、ORDER BY を文末に置く必要があり、他の 3 ドライバは LIMIT の
// 前に ORDER BY が来る — この方言差を固定する。
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

  it("MSSQL: TOP goes right after SELECT, ORDER BY still trails the statement", () => {
    const out = buildSelectSql("mssql", {
      orderBy: oneAsc,
      limitEnabled: true,
      limit: "5",
    });
    expect(out).toBe('SELECT TOP (5) * FROM [db].[dbo].[users] ORDER BY [name] ASC;');
  });

  it("MSSQL: ORDER BY without a LIMIT (no TOP) still renders at the end", () => {
    const out = buildSelectSql("mssql", { orderBy: oneAsc });
    expect(out).toBe('SELECT * FROM [db].[dbo].[users] ORDER BY [name] ASC;');
  });

  it("MSSQL: TOP alone (no ORDER BY) is unaffected by the ORDER BY change", () => {
    const out = buildSelectSql("mssql", { limitEnabled: true, limit: "5" });
    expect(out).toBe("SELECT TOP (5) * FROM [db].[dbo].[users];");
  });
});
