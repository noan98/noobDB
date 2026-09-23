import { describe, expect, it } from "vitest";
import { isSynthesizedTableDdl, TABLE_DDL_KIND } from "../components/tableDdl";

describe("isSynthesizedTableDdl (#1001)", () => {
  it("PostgreSQL / MSSQL はカタログからの再構成 (ベストエフォート)", () => {
    expect(isSynthesizedTableDdl("postgres")).toBe(true);
    expect(isSynthesizedTableDdl("mssql")).toBe(true);
  });

  it("MySQL / SQLite / DuckDB はネイティブ DDL", () => {
    expect(isSynthesizedTableDdl("mysql")).toBe(false);
    expect(isSynthesizedTableDdl("sqlite")).toBe(false);
    expect(isSynthesizedTableDdl("duckdb")).toBe(false);
  });

  it("未接続 (driver 不明) は再構成扱いにしない", () => {
    expect(isSynthesizedTableDdl(null)).toBe(false);
    expect(isSynthesizedTableDdl(undefined)).toBe(false);
  });

  it("バックエンドの object_definition の kind と一致する", () => {
    expect(TABLE_DDL_KIND).toBe("table");
  });
});
