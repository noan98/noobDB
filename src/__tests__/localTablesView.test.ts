import { describe, expect, it } from "vitest";
import type { LocalTableMeta } from "../api/tauri";
import { parseLocalTableSort, viewLocalTables } from "../components/localTablesView";

const meta = (name: string, rows: number, at: number): LocalTableMeta => ({
  name,
  source_profile: null,
  source_profile_id: null,
  source_sql: "SELECT 1",
  source_driver: null,
  source_database: null,
  fetched_at_ms: at,
  row_count: rows,
});

const tables = [meta("orders_2", 10, 300), meta("Users", 500, 100), meta("orders_10", 10, 200)];
const names = (l: LocalTableMeta[]) => l.map((t) => t.name);

describe("viewLocalTables (#1627)", () => {
  it("絞り込みは名前の部分一致 (大文字小文字を区別しない)", () => {
    expect(names(viewLocalTables(tables, "ORDER", "registered"))).toEqual(["orders_2", "orders_10"]);
    expect(names(viewLocalTables(tables, "  user ", "registered"))).toEqual(["Users"]);
    expect(viewLocalTables(tables, "zzz", "registered")).toEqual([]);
    expect(names(viewLocalTables(tables, "   ", "registered"))).toEqual(["orders_2", "Users", "orders_10"]);
  });

  it("並べ替え: 名前は自然順の昇順、行数は多い順、取得日時は新しい順。同値は登録順", () => {
    expect(names(viewLocalTables(tables, "", "name"))).toEqual(["orders_2", "orders_10", "Users"]);
    expect(names(viewLocalTables(tables, "", "rows"))).toEqual(["Users", "orders_2", "orders_10"]);
    expect(names(viewLocalTables(tables, "", "fetched"))).toEqual(["orders_2", "orders_10", "Users"]);
  });

  it("入力の配列は書き換えない", () => {
    const copy = [...tables];
    viewLocalTables(tables, "", "rows");
    expect(tables).toEqual(copy);
  });

  it("parseLocalTableSort は未知の値を registered にする", () => {
    expect(parseLocalTableSort("rows")).toBe("rows");
    expect(parseLocalTableSort("x")).toBe("registered");
  });
});
