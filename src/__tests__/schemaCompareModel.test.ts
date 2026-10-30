import { describe, it, expect } from "vitest";
import {
  countTableItems,
  DEFAULT_DIFF_FILTERS,
  filterTables,
  groupTables,
  resolveSelectedTable,
  statementsForTable,
} from "../components/schemaCompareModel";
import type { TableDiff } from "../api/tauri";

const tbl = (name: string, status: TableDiff["status"]): TableDiff => ({ name, status, columns: [] });
const TABLES = [
  tbl("users", "same"),
  tbl("orders", "different"),
  tbl("logs", "source_only"),
  tbl("old", "target_only"),
];

describe("schemaCompareModel", () => {
  it("既定の絞り込みは同一のテーブルだけを隠す", () => {
    expect(filterTables(TABLES, DEFAULT_DIFF_FILTERS, "").map((t) => t.name)).toEqual([
      "orders",
      "logs",
      "old",
    ]);
  });

  it("テーブル名は大小を無視した部分一致で絞る", () => {
    expect(filterTables(TABLES, { ...DEFAULT_DIFF_FILTERS, same: true }, " OR ").map((t) => t.name)).toEqual([
      "orders",
    ]);
  });

  it("グループは 変更 → 追加 → 削除 → 同一 の順で、空のグループは除く", () => {
    expect(groupTables([tbl("a", "target_only"), tbl("b", "different"), tbl("c", "different")])).toEqual([
      { status: "different", tables: [tbl("b", "different"), tbl("c", "different")] },
      { status: "target_only", tables: [tbl("a", "target_only")] },
    ]);
  });

  it("選択が一覧から消えたら先頭へ移り、一覧が空なら null", () => {
    expect(resolveSelectedTable(TABLES, "logs")).toBe("logs");
    expect(resolveSelectedTable(TABLES, "missing")).toBe("users");
    expect(resolveSelectedTable(TABLES, null)).toBe("users");
    expect(resolveSelectedTable([], "users")).toBeNull();
  });

  it("テーブル内の項目を状態ごとに数える", () => {
    const table: TableDiff = {
      name: "t",
      status: "different",
      columns: [
        { name: "a", status: "source_only", source: null, target: null, changed_fields: [] },
        { name: "b", status: "different", source: null, target: null, changed_fields: ["data_type"] },
      ],
      indexes: [{ name: "i", status: "target_only", source: null, target: null }],
    };
    expect(countTableItems(table)).toEqual({ source_only: 1, different: 1, target_only: 1, same: 0 });
  });

  it("指定テーブルの同期文だけを元の順序で返す", () => {
    const plan = {
      statements: [
        { sql: "a", table: "x", kind: "add_column" as const, destructive: false },
        { sql: "b", table: "y", kind: "add_column" as const, destructive: false },
        { sql: "c", table: "x", kind: "drop_column" as const, destructive: true },
      ],
      warnings: [],
    };
    expect(statementsForTable(plan, "x").map((s) => s.sql)).toEqual(["a", "c"]);
    expect(statementsForTable(null, "x")).toEqual([]);
  });
});
