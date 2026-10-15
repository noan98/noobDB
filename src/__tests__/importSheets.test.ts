import { describe, expect, it } from "vitest";
import {
  buildSheetRequests,
  checkSheetPlan,
  sheetImportOptions,
  suggestSheetTableName,
  type SheetPlanEntry,
} from "../components/importSheets";
import type { NewColumnDraft } from "../components/newTableInference";

const draft = (name: string, csvIndex = 0, include = true): NewColumnDraft =>
  ({ csvIndex, name, include, type: "text", inferredType: "text" }) as NewColumnDraft;

const entry = (sheet: string, tableName: string, over: Partial<SheetPlanEntry> = {}): SheetPlanEntry => ({
  sheet,
  include: true,
  tableName,
  drafts: [draft("id")],
  ...over,
});

describe("xlsx multi-sheet import planning (#1623)", () => {
  it("suggests table names from sheet names and de-duplicates them", () => {
    const used = new Set<string>();
    const a = suggestSheetTableName("Sales 2026", used);
    used.add(a.toLowerCase());
    expect(a).toBe("Sales_2026");
    expect(suggestSheetTableName("sales_2026", used)).toBe("sales_2026_2");
    expect(suggestSheetTableName("  ", new Set())).toBe("sheet");
    expect(suggestSheetTableName("売上/月次", new Set())).toBe("売上_月次");
  });

  it("flags empty / too-long names, existing tables and duplicates between sheets", () => {
    const entries = [
      entry("A", "orders"),
      entry("B", "Orders"),
      entry("C", "exists_already"),
      entry("D", ""),
      entry("E", "x", { include: false }),
      entry("F", "fine"),
    ];
    const issues = checkSheetPlan("sqlite", entries, ["EXISTS_ALREADY"]);
    expect(issues[0]).toBeNull();
    expect(issues[1]).toEqual({ kind: "duplicate", name: "Orders" });
    expect(issues[2]).toEqual({ kind: "exists", name: "exists_already" });
    expect(issues[3]).toEqual({ kind: "table", error: { kind: "tableNameRequired" } });
    expect(issues[4]).toBeNull();
    expect(issues[5]).toBeNull();
    const long = checkSheetPlan("mysql", [entry("A", "x".repeat(65))], []);
    expect(long[0]).toMatchObject({ kind: "table", error: { kind: "nameTooLong", limit: 64 } });
  });

  it("an excluded sheet does not reserve its table name", () => {
    const issues = checkSheetPlan("sqlite", [entry("A", "t", { include: false }), entry("B", "t")], []);
    expect(issues).toEqual([null, null]);
  });

  it("builds requests for the included sheets only, keeping the workbook order", () => {
    const reqs = buildSheetRequests([
      entry("A", "ta", { drafts: [draft("id", 0), draft("skip", 1, false)] }),
      entry("B", "tb", { include: false }),
      entry("C", "tc", { drafts: [draft("k", 2)] }),
    ]);
    expect(reqs.map((r) => [r.sheet, r.table])).toEqual([
      ["A", "ta"],
      ["C", "tc"],
    ]);
    expect(reqs[0].mapping).toEqual([{ column: "id", csvIndex: 0 }]);
    expect(reqs[0].createTable).toEqual([{ name: "id", type: "text" }]);
  });

  it("forces plain INSERT and clears the sheet in the shared options", () => {
    const opts = sheetImportOptions({
      delimiter: ",",
      quote: '"',
      hasHeader: true,
      encoding: "utf-8",
      sheet: "X",
      conflictMode: "update",
      keyColumns: ["id"],
    });
    expect(opts).toMatchObject({ format: "xlsx", sheet: null, conflictMode: "insert", keyColumns: [] });
  });
});
