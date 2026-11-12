import { describe, expect, it } from "vitest";
import type { Column, SubsetPreview } from "../api/tauri";
import {
  buildSubsetPkCondition,
  buildSubsetRequest,
  defaultSubsetScriptName,
  maskableColumns,
  needsWriteConfirm,
  parseBoundedInt,
  previewMatches,
  resolveSubsetMasks,
  subsetMenuDisabledReason,
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

describe("buildSubsetPkCondition (#2265)", () => {
  const col = (name: string, type_name = "INT"): Column => ({ name, type_name }) as Column;
  const cols = [col("id", "BIGINT"), col("code", "VARCHAR"), col("note", "TEXT")];

  it("単一キーは IN で 3 方言のクォートに従う", () => {
    const rows = [
      [1, "a", "x"],
      [2, "b", "y"],
    ];
    const f = (driver: string) => buildSubsetPkCondition({ driver, columns: cols, rows, pkIndices: [0] });
    expect(f("mysql")).toEqual({ ok: true, condition: "`id` IN (1, 2)", rootLimit: 2 });
    expect(f("postgres")).toEqual({ ok: true, condition: '"id" IN (1, 2)', rootLimit: 2 });
    expect(f("sqlite")).toEqual({ ok: true, condition: '"id" IN (1, 2)', rootLimit: 2 });
  });

  it("文字列キーはエスケープされ、MySQL だけバックスラッシュを二重にする", () => {
    const rows = [["O'Re\\x"]];
    const my = buildSubsetPkCondition({
      driver: "mysql",
      columns: [col("code", "VARCHAR")],
      rows,
      pkIndices: [0],
    });
    const pg = buildSubsetPkCondition({
      driver: "postgres",
      columns: [col("code", "VARCHAR")],
      rows,
      pkIndices: [0],
    });
    expect(my).toMatchObject({ condition: "`code` IN ('O''Re\\\\x')" });
    expect(pg).toMatchObject({ condition: "\"code\" IN ('O''Re\\x')" });
  });

  it("2^53 を超える整数キーは文字列のまま欠けずに入る", () => {
    const r = buildSubsetPkCondition({
      driver: "postgres",
      columns: cols,
      rows: [
        ["9007199254740993", "a", ""],
        ["9223372036854775807", "b", ""],
      ],
      pkIndices: [0],
    });
    expect(r).toMatchObject({ ok: true, condition: '"id" IN (9007199254740993, 9223372036854775807)' });
  });

  it("複合キーは行値 IN、SQLite は OR の連結", () => {
    const rows = [
      [1, "a", ""],
      [2, "b", ""],
    ];
    const pg = buildSubsetPkCondition({ driver: "postgres", columns: cols, rows, pkIndices: [0, 1] });
    expect(pg).toMatchObject({ condition: "(\"id\", \"code\") IN ((1, 'a'), (2, 'b'))", rootLimit: 2 });
    const my = buildSubsetPkCondition({ driver: "mysql", columns: cols, rows, pkIndices: [0, 1] });
    expect(my).toMatchObject({ condition: "(`id`, `code`) IN ((1, 'a'), (2, 'b'))" });
    const lite = buildSubsetPkCondition({ driver: "sqlite", columns: cols, rows, pkIndices: [0, 1] });
    expect(lite).toMatchObject({
      condition: '("id" = 1 AND "code" = \'a\') OR ("id" = 2 AND "code" = \'b\')',
    });
  });

  it("NULL を含むキーは IS NULL の述語を OR で足す (IN に入れない)", () => {
    const single = buildSubsetPkCondition({
      driver: "mysql",
      columns: cols,
      rows: [
        [1, "a", ""],
        [null, "b", ""],
      ],
      pkIndices: [0],
    });
    expect(single).toMatchObject({ condition: "`id` IN (1) OR `id` IS NULL", rootLimit: 2 });
    const comp = buildSubsetPkCondition({
      driver: "postgres",
      columns: cols,
      rows: [
        [1, "a", ""],
        [2, null, ""],
      ],
      pkIndices: [0, 1],
    });
    expect(comp).toMatchObject({
      condition: '("id", "code") IN ((1, \'a\')) OR ("id" = 2 AND "code" IS NULL)',
    });
  });

  it("同じキーの行は 1 件にまとめ、件数も重複を除く", () => {
    const r = buildSubsetPkCondition({
      driver: "sqlite",
      columns: cols,
      rows: [
        [1, "a", "x"],
        [1, "a", "y"],
      ],
      pkIndices: [0],
    });
    expect(r).toEqual({ ok: true, condition: '"id" IN (1)', rootLimit: 1 });
  });

  it("主キーなし・行なし・長すぎる条件は理由つきで失敗する", () => {
    expect(
      buildSubsetPkCondition({ driver: "mysql", columns: cols, rows: [[1, "a", ""]], pkIndices: [] }),
    ).toEqual({
      ok: false,
      reason: "noPk",
    });
    expect(buildSubsetPkCondition({ driver: "mysql", columns: cols, rows: [], pkIndices: [0] })).toEqual({
      ok: false,
      reason: "noRows",
    });
    const many = Array.from({ length: 400 }, (_, i) => [1_000_000_000 + i, "a", ""]);
    expect(buildSubsetPkCondition({ driver: "mysql", columns: cols, rows: many, pkIndices: [0] })).toEqual({
      ok: false,
      reason: "tooLong",
    });
  });

  it("真偽値・単精度 float・バイナリ・日時文字列のキー", () => {
    const f = (driver: string, c: Column, v: unknown) =>
      buildSubsetPkCondition({ driver, columns: [c], rows: [[v as never]], pkIndices: [0] });
    // 真偽値は IN に載せず、述語 (PG は = TRUE、他は <> 0) を使う。
    expect(f("postgres", col("flag", "BOOLEAN"), true)).toMatchObject({ condition: '"flag" = TRUE' });
    expect(f("mysql", col("flag", "TINYINT"), false)).toMatchObject({ condition: "`flag` = 0" });
    // 単精度 float は許容差つきの比較。
    const fl = f("postgres", col("x", "float4"), 1.5);
    expect(fl).toMatchObject({ ok: true });
    if (fl.ok) expect(fl.condition).toMatch(/^ABS\("x" - \(1\.5\)\)/);
    // バイナリは 3 方言のリテラル。
    expect(f("mysql", col("b", "BINARY"), "dead")).toMatchObject({ condition: "`b` IN (0xdead)" });
    expect(f("postgres", col("b", "BYTEA"), "dead")).toMatchObject({ condition: "\"b\" IN ('\\xdead')" });
    expect(f("sqlite", col("b", "BLOB"), "dead")).toMatchObject({ condition: "\"b\" IN (X'dead')" });
    // 日時文字列は引用符つきの文字列。
    expect(f("mysql", col("at", "DATETIME"), "2026-01-02 03:04:05")).toMatchObject({
      condition: "`at` IN ('2026-01-02 03:04:05')",
    });
  });

  it("打ち切り: 上限を超える選択は tooLong", () => {
    const rows = Array.from({ length: 5000 }, (_, i) => [i, "a", ""]);
    expect(buildSubsetPkCondition({ driver: "sqlite", columns: cols, rows, pkIndices: [0, 1] })).toEqual({
      ok: false,
      reason: "tooLong",
    });
  });

  it("無効理由は識別キーの種類と結果で振り分ける", () => {
    const ok = { ok: true, condition: "x", rootLimit: 1 } as const;
    const r = (over: Partial<Parameters<typeof subsetMenuDisabledReason>[0]>) =>
      subsetMenuDisabledReason({
        hasTable: true,
        identityStrategy: "primary_key",
        pkMasked: false,
        built: ok,
        ...over,
      });
    expect(r({})).toBeNull();
    expect(r({ identityStrategy: "unique_key" })).toBeNull();
    for (const s of ["rowid", "ctid", "all_columns", "none", undefined]) {
      expect(r({ identityStrategy: s })).toBe("gridExtractSubsetNoPk");
    }
    expect(r({ hasTable: false })).toBe("gridExtractSubsetNoTable");
    expect(r({ pkMasked: true })).toBe("gridExtractSubsetMasked");
    expect(r({ built: { ok: false, reason: "noPk" } })).toBe("gridExtractSubsetNoPk");
    expect(r({ built: { ok: false, reason: "noRows" } })).toBe("gridExtractSubsetNoRows");
    expect(r({ built: { ok: false, reason: "tooLong" } })).toBe("gridExtractSubsetTooMany");
  });

  it("結果はセミコロン・コメントを含まない (checked_row_filter を通る形)", () => {
    const r = buildSubsetPkCondition({
      driver: "mysql",
      columns: cols,
      rows: [[1, "a;b -- c", ""]],
      pkIndices: [0, 1],
    });
    // 文字列リテラル内の `;` / `--` は引用符の中なので許される。引用符の外には出ない。
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.condition.replace(/'[^']*'/g, "")).not.toMatch(/;|--|\/\*/);
  });
});
