import { describe, it, expect } from "vitest";
import type { TableColumnInfo } from "../api/tauri";
import { insertDefaultHint, insertFunctionChips } from "../components/insertDefaults";
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
      { fn: "current_timestamp", sql: "CURRENT_TIMESTAMP" },
      { fn: "now", sql: "NOW()" },
    ]);
    expect(insertFunctionChips("postgres", "timestamp with time zone")).toEqual([
      { fn: "current_timestamp", sql: "CURRENT_TIMESTAMP" },
      { fn: "now", sql: "NOW()" },
    ]);
  });

  it("omits NOW() on SQLite datetime columns", () => {
    expect(insertFunctionChips("sqlite", "DATETIME")).toEqual([
      { fn: "current_timestamp", sql: "CURRENT_TIMESTAMP" },
    ]);
  });

  it("offers the date and time keywords for date and time columns", () => {
    expect(insertFunctionChips("mysql", "DATE")).toEqual([{ fn: "current_date", sql: "CURRENT_DATE" }]);
    expect(insertFunctionChips("postgres", "time")).toEqual([{ fn: "current_time", sql: "CURRENT_TIME" }]);
  });

  it("offers UUID for PostgreSQL uuid columns and MySQL CHAR(36) columns", () => {
    expect(insertFunctionChips("postgres", "uuid")).toEqual([
      { fn: "uuid", sql: "gen_random_uuid()" },
    ]);
    expect(insertFunctionChips("mysql", "CHAR(36)")).toEqual([{ fn: "uuid", sql: "UUID()" }]);
    expect(insertFunctionChips("mysql", "VARCHAR(255)")).toEqual([]);
  });

  it("offers nothing for SQLite text or numeric columns", () => {
    expect(insertFunctionChips("sqlite", "TEXT")).toEqual([]);
    expect(insertFunctionChips("sqlite", "INTEGER")).toEqual([]);
    expect(insertFunctionChips("sqlite", "CHAR(36)")).toEqual([]);
  });
});
