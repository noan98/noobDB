import { describe, expect, it } from "vitest";
import type { CloneRowsOutcome, CloneRowsPreview } from "../api/tauri";
import {
  buildCloneRequest,
  buildCloneRule,
  cloneBlockers,
  cloneExpressionError,
  cloneKey,
  cloneMenuDisabledReason,
  cloneNodeExtras,
  cloneToSubsetPreview,
  describeRule,
  mappingsToTsv,
  upsertRule,
} from "../components/cloneRows";

const base = {
  sessionId: "s",
  database: "db",
  table: "orders",
  whereClause: "id IN (1)",
  rootLimit: 1,
  childDepth: "3",
  childLimit: "1000",
};

describe("buildCloneRequest", () => {
  it("builds a request and accepts depth 0", () => {
    expect(buildCloneRequest(base)).toMatchObject({ table: "orders", childDepth: 3, childRowLimit: 1000 });
    expect(buildCloneRequest({ ...base, childDepth: "0" })?.childDepth).toBe(0);
  });
  it("rejects out-of-range or non-numeric input", () => {
    expect(buildCloneRequest({ ...base, childDepth: "6" })).toBeNull();
    expect(buildCloneRequest({ ...base, childDepth: "x" })).toBeNull();
    expect(buildCloneRequest({ ...base, childLimit: "0" })).toBeNull();
    expect(buildCloneRequest({ ...base, childLimit: "10001" })).toBeNull();
  });
  it("keys the preview by request and rules", () => {
    const req = buildCloneRequest(base);
    expect(cloneKey(null, [])).toBeNull();
    expect(cloneKey(req, [])).not.toBe(
      cloneKey(req, [buildCloneRule("t", "c", "null", "") ?? ({} as never)]),
    );
  });
});

describe("rules", () => {
  it("builds expression / value / null rules and rejects empty or multi-statement expressions", () => {
    expect(buildCloneRule("t", "id", "expression", " UUID() ")?.rule).toEqual({
      kind: "expression",
      sql: "UUID()",
    });
    expect(buildCloneRule("t", "id", "expression", "  ")).toBeNull();
    expect(buildCloneRule("t", "id", "expression", "1; DROP TABLE t")).toBeNull();
    expect(buildCloneRule("t", "id", "value", "70")?.rule).toEqual({ kind: "literal", value: "70" });
    expect(buildCloneRule("t", "id", "null", "ignored")?.rule).toEqual({ kind: "literal", value: null });
    expect(buildCloneRule("t", "", "null", "")).toBeNull();
  });
  it("replaces a rule for the same column", () => {
    const a = buildCloneRule("t", "c", "value", "1");
    const b = buildCloneRule("t", "c", "value", "2");
    const other = buildCloneRule("t", "d", "null", "");
    if (!a || !b || !other) throw new Error("rules");
    const rules = upsertRule(upsertRule([a, other], b), b);
    expect(rules).toHaveLength(2);
    expect(rules.find((r) => r.column === "c")).toEqual(b);
    expect(describeRule(b)).toBe('"2"');
    expect(describeRule(other)).toBe("NULL");
  });
});

const preview = (over: Partial<CloneRowsPreview["tables"][number]>): CloneRowsPreview => ({
  tables: [
    {
      table: "orders",
      rows: 1,
      rootRows: 1,
      childRows: 0,
      columns: [],
      keyColumns: [],
      needsPolicy: false,
      conflicts: [],
      ...over,
    },
  ],
  totalRows: 1,
  cycles: [],
  warnings: [],
  ready: true,
});

describe("cloneBlockers", () => {
  it("is empty when nothing blocks", () => {
    expect(cloneBlockers(preview({}))).toEqual([]);
  });
  it("lists missing key policy, unique conflicts, cycles and an empty result", () => {
    const p = preview({ needsPolicy: true, conflicts: [{ index: "uq", columns: ["no"], rows: 2 }] });
    p.cycles = [["a", "b"]];
    expect(cloneBlockers(p).map((b) => b.kind)).toEqual(["cycle", "policy", "conflict"]);
    expect(cloneBlockers({ ...p, totalRows: 0, cycles: [] })[0]).toEqual({ kind: "empty" });
  });
});

describe("mappingsToTsv", () => {
  it("renders old and new keys, composite keys comma-separated", () => {
    const outcome: CloneRowsOutcome = {
      tables: [
        {
          table: "orders",
          rows: 1,
          keyColumns: ["id"],
          mappings: [{ oldKey: [1], newKey: [3], root: true }],
        },
        {
          table: "link",
          rows: 1,
          keyColumns: ["a", "b"],
          mappings: [{ oldKey: [1, null], newKey: [3, "x"], root: false }],
        },
      ],
      totalRows: 2,
      rootTable: "orders",
      rootKeyColumns: ["id"],
      rootNewKeys: [[3]],
      recorded: 2,
      declined: 0,
      declinedTables: [],
      captureEnabled: true,
      batchId: "b",
      warnings: [],
    };
    expect(mappingsToTsv(outcome)).toBe("table\told_key\tnew_key\norders\t1\t3\nlink\t1,NULL\t3,x");
  });
});

describe("cloneMenuDisabledReason", () => {
  it("uses the clone wording for a missing primary key and passes the others through", () => {
    const ok = { ok: true as const, condition: "id IN (1)", rootLimit: 1 };
    expect(
      cloneMenuDisabledReason({ hasTable: true, identityStrategy: "rowid", pkMasked: false, built: ok }),
    ).toBe("gridCloneRowsNoPk");
    expect(
      cloneMenuDisabledReason({
        hasTable: false,
        identityStrategy: "primary_key",
        pkMasked: false,
        built: ok,
      }),
    ).toBe("gridExtractSubsetNoTable");
    expect(
      cloneMenuDisabledReason({
        hasTable: true,
        identityStrategy: "primary_key",
        pkMasked: false,
        built: ok,
      }),
    ).toBeNull();
  });
});

describe("cloneExpressionError", () => {
  it("accepts plain expressions and ';' / {old} only outside quotes", () => {
    expect(cloneExpressionError("")).toBeNull();
    expect(cloneExpressionError("UUID()")).toBeNull();
    expect(cloneExpressionError("{old} || '-copy'")).toBeNull();
    expect(cloneExpressionError("{old} || ';'")).toBeNull();
    expect(cloneExpressionError("'it''s' || {old}")).toBeNull();
  });
  it("rejects a statement separator and {old} inside quotes or comments", () => {
    expect(cloneExpressionError("1; DROP TABLE t")).toBe("cloneRowsErrSemicolon");
    expect(cloneExpressionError("'{old}-copy'")).toBe("cloneRowsErrOldInQuote");
    expect(cloneExpressionError('"{old}"')).toBe("cloneRowsErrOldInQuote");
  });
  it("rejects comments outright, but not comment markers inside quotes", () => {
    expect(cloneExpressionError("1 /* {old} */")).toBe("cloneRowsErrComment");
    expect(cloneExpressionError("/* /* */ {old} */ 1")).toBe("cloneRowsErrComment");
    expect(cloneExpressionError("/*!99999 {old} */")).toBe("cloneRowsErrComment");
    expect(cloneExpressionError("1 -- {old}")).toBe("cloneRowsErrComment");
    expect(cloneExpressionError("'a -- b /* c */'")).toBeNull();
  });
});

describe("cloneToSubsetPreview / cloneNodeExtras (#2323)", () => {
  const p: CloneRowsPreview = {
    tables: [
      {
        table: "orders",
        rows: 1,
        rootRows: 1,
        childRows: 0,
        columns: [{ name: "id", key: true }],
        keyColumns: [{ name: "id", status: "auto" }],
        needsPolicy: false,
        conflicts: [],
      },
      {
        table: "tags",
        rows: 2,
        rootRows: 0,
        childRows: 2,
        columns: [
          { name: "a", key: true },
          { name: "b", key: true },
        ],
        keyColumns: [
          { name: "a", status: "unchanged" },
          { name: "b", status: "unchanged" },
        ],
        needsPolicy: true,
        conflicts: [],
      },
    ],
    totalRows: 3,
    cycles: [],
    warnings: [],
    ready: false,
  };
  it("never goes to the parent side", () => {
    const s = cloneToSubsetPreview(p);
    expect(s.tables.every((t) => t.parentRows === 0)).toBe(true);
    expect(s.totalRows).toBe(3);
  });
  it("maps key status to one chip per status and highlights tables needing a policy", () => {
    const m = cloneNodeExtras(p, (k) => k);
    expect(m.get("orders")).toEqual({
      chips: [{ key: "auto", tone: "success", label: "cloneKeyAuto" }],
      emphasize: false,
    });
    expect(m.get("tags")?.chips).toEqual([{ key: "unchanged", tone: "warning", label: "cloneKeyUnchanged" }]);
    expect(m.get("tags")?.emphasize).toBe(true);
  });
});
