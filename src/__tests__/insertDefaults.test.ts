import { describe, it, expect } from "vitest";
import type { TableColumnInfo } from "../api/tauri";
import {
  insertDefaultHint,
  insertFunctionChips,
  stripNonInsertableSeed,
} from "../components/insertDefaults";
import { insertFunctionSql } from "../components/sqlDialect";

// #1357: 行追加モーダルの「既定値 / 自動採番」判定と関数値チップ。方言差 (auto_increment /
// serial / rowid、NOW() / UUID 関数名) を固定する。

function meta(over: Partial<TableColumnInfo> & { name: string }): TableColumnInfo {
  return {
    data_type: "text",
    nullable: true,
    key: "",
    default: null,
    extra: "",
    referenced_table: null,
    referenced_column: null,
    ...over,
  };
}

describe("insertDefaultHint: auto-increment detection", () => {
  it("treats MySQL auto_increment (EXTRA) as auto-generated", () => {
    const id = meta({ name: "id", data_type: "int", key: "PRI", extra: "auto_increment" });
    expect(insertDefaultHint("mysql", id, [id])).toEqual({ kind: "auto" });
  });

  it("treats a PostgreSQL serial column (nextval default) as auto-generated", () => {
    const id = meta({
      name: "id",
      data_type: "integer",
      key: "PRI",
      default: "nextval('users_id_seq'::regclass)",
    });
    expect(insertDefaultHint("postgres", id, [id])).toEqual({ kind: "auto" });
  });

  it("treats a SQLite single INTEGER PRIMARY KEY (rowid alias) as auto-generated", () => {
    const id = meta({ name: "id", data_type: "INTEGER", key: "PRI" });
    const name = meta({ name: "name" });
    expect(insertDefaultHint("sqlite", id, [id, name])).toEqual({ kind: "auto" });
  });

  it("does not treat a composite-key INTEGER column or a non-INTEGER PK as rowid", () => {
    const a = meta({ name: "a", data_type: "INTEGER", key: "PRI" });
    const b = meta({ name: "b", data_type: "INTEGER", key: "PRI" });
    expect(insertDefaultHint("sqlite", a, [a, b])).toBeNull();
    const pk = meta({ name: "pk", data_type: "TEXT", key: "PRI" });
    expect(insertDefaultHint("sqlite", pk, [pk])).toBeNull();
  });

  it("does not treat a MySQL column with a plain default as auto-generated", () => {
    const c = meta({ name: "n", data_type: "int", default: "0" });
    expect(insertDefaultHint("mysql", c, [c])).toEqual({ kind: "default", expr: "0" });
  });
});

describe("insertDefaultHint: DEFAULT expressions", () => {
  it("reports the DEFAULT expression as the database stores it", () => {
    const c = meta({ name: "created", data_type: "timestamp", default: "CURRENT_TIMESTAMP" });
    expect(insertDefaultHint("mysql", c, [c])).toEqual({
      kind: "default",
      expr: "CURRENT_TIMESTAMP",
    });
  });

  it("shows an empty-string default as the quoted empty literal", () => {
    const c = meta({ name: "tag", default: "" });
    expect(insertDefaultHint("mysql", c, [c])).toEqual({ kind: "default", expr: "''" });
  });

  it("returns null when the column has no default and is not auto-generated", () => {
    const c = meta({ name: "note" });
    expect(insertDefaultHint("postgres", c, [c])).toBeNull();
  });

  it("prefers auto-generated over a DEFAULT on the same column", () => {
    const id = meta({ name: "id", data_type: "int", extra: "auto_increment", default: null });
    expect(insertDefaultHint("mysql", id, [id])).toEqual({ kind: "auto" });
  });
});

describe("insertFunctionSql (dialect catalogue)", () => {
  it("uses the standard keywords for every driver", () => {
    for (const driver of ["mysql", "postgres", "sqlite"]) {
      expect(insertFunctionSql(driver, "current_timestamp")).toBe("CURRENT_TIMESTAMP");
      expect(insertFunctionSql(driver, "current_date")).toBe("CURRENT_DATE");
      expect(insertFunctionSql(driver, "current_time")).toBe("CURRENT_TIME");
    }
  });

  it("offers NOW() on MySQL and PostgreSQL but not SQLite", () => {
    expect(insertFunctionSql("mysql", "now")).toBe("NOW()");
    expect(insertFunctionSql("postgres", "now")).toBe("NOW()");
    expect(insertFunctionSql("sqlite", "now")).toBeNull();
  });

  it("maps uuid to the driver's function, and to nothing on SQLite", () => {
    expect(insertFunctionSql("mysql", "uuid")).toBe("UUID()");
    expect(insertFunctionSql("postgres", "uuid")).toBe("gen_random_uuid()");
    expect(insertFunctionSql("sqlite", "uuid")).toBeNull();
  });
});

describe("insertFunctionChips", () => {
  it("offers CURRENT_TIMESTAMP and NOW() for datetime columns on MySQL / PostgreSQL", () => {
    expect(insertFunctionChips("mysql", "DATETIME")).toEqual([
      { fn: "current_timestamp" },
      { fn: "now" },
    ]);
    expect(insertFunctionChips("postgres", "timestamp with time zone")).toEqual([
      { fn: "current_timestamp" },
      { fn: "now" },
    ]);
  });

  it("omits NOW() on SQLite datetime columns", () => {
    expect(insertFunctionChips("sqlite", "DATETIME")).toEqual([
      { fn: "current_timestamp" },
    ]);
  });

  it("offers the date and time keywords for date and time columns", () => {
    expect(insertFunctionChips("mysql", "DATE")).toEqual([{ fn: "current_date" }]);
    expect(insertFunctionChips("postgres", "time")).toEqual([{ fn: "current_time" }]);
  });

  it("offers UUID for PostgreSQL uuid columns and MySQL CHAR(36) columns", () => {
    expect(insertFunctionChips("postgres", "uuid")).toEqual([
      { fn: "uuid" },
    ]);
    expect(insertFunctionChips("mysql", "CHAR(36)")).toEqual([{ fn: "uuid" }]);
    expect(insertFunctionChips("mysql", "VARCHAR(255)")).toEqual([]);
  });

  it("offers UUID for MariaDB uuid columns, with UUID() as the expression", () => {
    expect(insertFunctionChips("mysql", "uuid")).toEqual([{ fn: "uuid" }]);
    expect(insertFunctionChips("mysql", "UUID", "uuid")).toEqual([{ fn: "uuid" }]);
  });

  it("offers nothing for SQLite text or numeric columns", () => {
    expect(insertFunctionChips("sqlite", "TEXT")).toEqual([]);
    expect(insertFunctionChips("sqlite", "INTEGER")).toEqual([]);
    expect(insertFunctionChips("sqlite", "CHAR(36)")).toEqual([]);
  });
});

describe("insertDefaultHint: generated columns (#1357)", () => {
  it("flags MySQL VIRTUAL / STORED generated columns as not insertable", () => {
    const v = meta({ name: "full", data_type: "varchar(64)", extra: "VIRTUAL GENERATED" });
    const s = meta({ name: "slug", data_type: "varchar(64)", extra: "STORED GENERATED" });
    expect(insertDefaultHint("mysql", v, [v])).toEqual({ kind: "generated" });
    expect(insertDefaultHint("mysql", s, [s])).toEqual({ kind: "generated" });
  });

  it("does not mistake MySQL 8 DEFAULT_GENERATED extras for generated columns", () => {
    // MySQL 8.0.13+ の式既定値 (`DEFAULT (expr)`) や ON UPDATE 付き既定値は EXTRA に
    // DEFAULT_GENERATED が出るが、値を入れられる通常の列なので生成列ではない。
    const expr = meta({ name: "a", data_type: "int", extra: "DEFAULT_GENERATED" });
    expect(insertDefaultHint("mysql", expr, [expr])).toBeNull();
    const ts = meta({
      name: "updated_at",
      data_type: "timestamp",
      default: "CURRENT_TIMESTAMP",
      extra: "DEFAULT_GENERATED on update CURRENT_TIMESTAMP",
    });
    expect(insertDefaultHint("mysql", ts, [ts])).toEqual({
      kind: "default",
      expr: "CURRENT_TIMESTAMP",
    });
  });

  it("does not flag an ordinary column as generated", () => {
    const c = meta({ name: "n", data_type: "int", extra: "" });
    expect(insertDefaultHint("mysql", c, [c])).toBeNull();
  });
});

describe("insertFunctionChips: declared type and time-with-zone (#1357)", () => {
  it("uses the table metadata type when the result column type lost its length", () => {
    // 結果列の型は MySQL では "CHAR" (長さなし) になるが、列メタは "char(36)"。
    expect(insertFunctionChips("mysql", "CHAR", "char(36)")).toEqual([{ fn: "uuid" }]);
    expect(insertFunctionChips("mysql", "CHAR")).toEqual([]);
  });

  it("offers CURRENT_TIME for PostgreSQL timetz columns", () => {
    expect(insertFunctionChips("postgres", "timetz")).toEqual([{ fn: "current_time" }]);
    expect(insertFunctionChips("postgres", "time with time zone")).toEqual([{ fn: "current_time" }]);
  });
});

describe("stripNonInsertableSeed (#1357 row duplication)", () => {
  const columns = [
    { name: "id", type_name: "INT" },
    { name: "full", type_name: "VARCHAR" },
    { name: "note", type_name: "VARCHAR" },
  ];
  const table: TableColumnInfo[] = [
    meta({ name: "id", data_type: "int", key: "PRI", extra: "auto_increment" }),
    meta({ name: "full", data_type: "varchar(64)", extra: "VIRTUAL GENERATED" }),
    meta({ name: "note", data_type: "varchar(64)" }),
  ];

  it("drops auto-increment and generated values from the seed, keeps the rest", () => {
    expect(
      stripNonInsertableSeed("mysql", { 0: "42", 1: "x", 2: "keep" }, columns, table),
    ).toEqual({ 2: "keep" });
  });

  it("leaves the seed untouched when there is no table metadata", () => {
    const seed = { 0: "42", 1: "x" };
    expect(stripNonInsertableSeed("mysql", seed, columns, [])).toEqual(seed);
  });
});
