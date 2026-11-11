import { describe, expect, it } from "vitest";
import type { SubsetPreview } from "../api/tauri";
import {
  buildSubsetRequest,
  defaultSubsetScriptName,
  maskableColumns,
  needsWriteConfirm,
  parseBoundedInt,
  previewMatches,
  resolveSubsetMasks,
  subsetWarningMessage,
} from "../components/subsetExtract";

const base = {
  sessionId: "s1",
  database: "shop",
  table: "orders",
  whereClause: "  customer_id = 1 ",
  rootLimit: "500",
  childrenEnabled: false,
  childDepth: "2",
  childLimit: "50",
};

const preview: SubsetPreview = {
  tables: [
    {
      table: "customers",
      rows: 1,
      rootRows: 0,
      childRows: 0,
      parentRows: 1,
      columns: [
        { name: "id", key: true },
        { name: "email", key: false },
      ],
    },
    {
      table: "orders",
      rows: 2,
      rootRows: 2,
      childRows: 0,
      parentRows: 0,
      columns: [
        { name: "id", key: true },
        { name: "customer_id", key: true },
        { name: "memo", key: false },
      ],
    },
  ],
  totalRows: 3,
  cycles: [],
  warnings: [],
};

describe("parseBoundedInt", () => {
  it("accepts only whole numbers in range", () => {
    expect(parseBoundedInt("5", 1, 10)).toBe(5);
    expect(parseBoundedInt(" 10 ", 1, 10)).toBe(10);
    expect(parseBoundedInt("0", 1, 10)).toBeNull();
    expect(parseBoundedInt("11", 1, 10)).toBeNull();
    expect(parseBoundedInt("1.5", 1, 10)).toBeNull();
    expect(parseBoundedInt("-1", 1, 10)).toBeNull();
    expect(parseBoundedInt("", 1, 10)).toBeNull();
  });
});

describe("buildSubsetRequest", () => {
  it("does not follow children unless enabled", () => {
    const r = buildSubsetRequest(base);
    expect(r).toMatchObject({
      table: "orders",
      whereClause: "customer_id = 1",
      rootRowLimit: 500,
      childDepth: 0,
    });
    expect(r?.childRowLimit).toBeNull();
  });
  it("includes depth and limit when children are enabled", () => {
    const r = buildSubsetRequest({ ...base, childrenEnabled: true });
    expect(r).toMatchObject({ childDepth: 2, childRowLimit: 50 });
  });
  it("rejects out-of-range numbers", () => {
    expect(buildSubsetRequest({ ...base, rootLimit: "0" })).toBeNull();
    expect(buildSubsetRequest({ ...base, childrenEnabled: true, childDepth: "6" })).toBeNull();
    // 子を辿らないときは段数の入力値を見ない。
    expect(buildSubsetRequest({ ...base, childDepth: "99" })).not.toBeNull();
  });
  it("empty where becomes null", () => {
    expect(buildSubsetRequest({ ...base, whereClause: "  " })?.whereClause).toBeNull();
  });
});

describe("previewMatches", () => {
  it("is stale once the request changes", () => {
    const r = buildSubsetRequest(base);
    expect(previewMatches(JSON.stringify(r), r)).toBe(true);
    expect(previewMatches(JSON.stringify(r), buildSubsetRequest({ ...base, rootLimit: "1" }))).toBe(false);
    expect(previewMatches(null, r)).toBe(false);
    expect(previewMatches(JSON.stringify(r), null)).toBe(false);
  });
});

describe("masks", () => {
  it("lists only non-key columns", () => {
    expect(maskableColumns(preview).map((c) => c.label)).toEqual(["customers.email", "orders.memo"]);
  });
  it("resolves overrides into table/column masks and ignores disabled", () => {
    const overrides = { "customers.email": { kind: "email" as const, keepStart: 1 }, "orders.memo": null };
    expect(resolveSubsetMasks(preview, true, overrides)).toEqual([
      { table: "customers", column: "email", rule: { kind: "email", keepStart: 1 } },
    ]);
    expect(resolveSubsetMasks(preview, false, overrides)).toEqual([]);
    expect(resolveSubsetMasks(null, true, overrides)).toEqual([]);
  });
});

describe("misc", () => {
  it("maps warnings to message keys", () => {
    expect(subsetWarningMessage({ kind: "cycle", tables: ["a", "b"] })).toEqual({
      key: "subsetWarnCycle",
      params: { tables: "a, b" },
    });
    expect(subsetWarningMessage({ kind: "childTruncated", table: "t", limit: 3 }).key).toBe(
      "subsetWarnChildTruncated",
    );
  });
  it("script name and write confirm", () => {
    expect(defaultSubsetScriptName("my table")).toBe("my_table_subset.sql");
    expect(needsWriteConfirm({ is_production: false, confirm_writes: false })).toBe(false);
    expect(needsWriteConfirm({ is_production: true, confirm_writes: false })).toBe(true);
    expect(needsWriteConfirm({ is_production: false, confirm_writes: true })).toBe(true);
  });
});

describe("サンドボックス出力の起点行数の上限", () => {
  it("サンドボックスでは 5000 行まで、それ以外は 10 万行まで", () => {
    expect(buildSubsetRequest({ ...base, rootLimit: "5000", sandbox: true })?.rootRowLimit).toBe(5000);
    expect(buildSubsetRequest({ ...base, rootLimit: "5001", sandbox: true })).toBeNull();
    expect(buildSubsetRequest({ ...base, rootLimit: "5001" })?.rootRowLimit).toBe(5001);
  });
});
