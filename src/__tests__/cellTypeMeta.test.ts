import { describe, it, expect } from "vitest";
import {
  CELL_KIND_META,
  cellKindIcon,
  classifyEmptyValue,
  classifyTypeName,
  EMPTY_BADGE,
  resolveBoolTruthy,
  truncateHexPreview,
  type CellKind,
} from "../components/cellTypeMeta";

const ALL_KINDS: CellKind[] = [
  "number",
  "decimal",
  "bool",
  "date",
  "time",
  "json",
  "enum",
  "binary",
  "string",
];

describe("column type → icon mapping (#474)", () => {
  it("has an icon + label for every CellKind", () => {
    for (const k of ALL_KINDS) {
      const meta = CELL_KIND_META[k];
      expect(meta, `missing meta for ${k}`).toBeTruthy();
      expect(meta.icon).toBeTruthy();
      expect(meta.labelKey).toMatch(/^colType/);
      expect(cellKindIcon(k)).toBe(meta.icon);
    }
  });

  it("uses the same numeric glyph for integer and decimal", () => {
    expect(cellKindIcon("number")).toBe(cellKindIcon("decimal"));
  });
});

describe("classifyTypeName (#748: shared by ResultGrid and dataSearch)", () => {
  it("classifies numeric SQL types", () => {
    expect(classifyTypeName("INT")).toBe("number");
    expect(classifyTypeName("bigint")).toBe("number");
    expect(classifyTypeName("BIGINT UNSIGNED")).toBe("number");
    expect(classifyTypeName("DOUBLE")).toBe("number");
  });

  it("classifies decimal types distinctly from integers", () => {
    expect(classifyTypeName("DECIMAL")).toBe("decimal");
    expect(classifyTypeName("NUMERIC")).toBe("decimal");
  });

  it("classifies boolean, date, time, json, enum and binary", () => {
    expect(classifyTypeName("BOOLEAN")).toBe("bool");
    expect(classifyTypeName("BOOL")).toBe("bool");
    expect(classifyTypeName("DATE")).toBe("date");
    expect(classifyTypeName("TIMESTAMP")).toBe("date");
    expect(classifyTypeName("TIME")).toBe("time");
    expect(classifyTypeName("JSON")).toBe("json");
    expect(classifyTypeName("JSONB")).toBe("json");
    expect(classifyTypeName("ENUM")).toBe("enum");
    expect(classifyTypeName("SET")).toBe("enum");
    expect(classifyTypeName("BLOB")).toBe("binary");
    expect(classifyTypeName("VARBINARY")).toBe("binary");
  });

  it("falls back to string for anything unrecognized (VARCHAR, TEXT, ...)", () => {
    expect(classifyTypeName("VARCHAR")).toBe("string");
    expect(classifyTypeName("TEXT")).toBe("string");
    expect(classifyTypeName("something-unknown")).toBe("string");
  });
});

describe("empty value classification (#474)", () => {
  it("classifies SQL NULL", () => {
    expect(classifyEmptyValue(null)).toBe("null");
    expect(classifyEmptyValue(undefined)).toBe("null");
  });

  it("classifies empty string distinctly from NULL", () => {
    expect(classifyEmptyValue("")).toBe("empty");
  });

  it("classifies empty arrays and objects (whitespace tolerant)", () => {
    expect(classifyEmptyValue("[]")).toBe("empty-array");
    expect(classifyEmptyValue("  [ ]  ".replace(" ", ""))).not.toBe("empty"); // sanity
    expect(classifyEmptyValue("  []  ")).toBe("empty-array");
    expect(classifyEmptyValue("{}")).toBe("empty-object");
    expect(classifyEmptyValue(" {} ")).toBe("empty-object");
  });

  it("returns null for non-empty or non-string values", () => {
    expect(classifyEmptyValue("hello")).toBeNull();
    expect(classifyEmptyValue("[1]")).toBeNull();
    expect(classifyEmptyValue(0)).toBeNull();
    expect(classifyEmptyValue(false)).toBeNull();
  });

  it("exposes a badge glyph + label for each empty kind", () => {
    for (const kind of ["null", "empty", "empty-array", "empty-object"] as const) {
      expect(EMPTY_BADGE[kind].glyph).toBeTruthy();
      expect(EMPTY_BADGE[kind].labelKey).toBeTruthy();
    }
  });
});

describe("resolveBoolTruthy (#647)", () => {
  it("treats the common truthy representations as true", () => {
    expect(resolveBoolTruthy(true)).toBe(true);
    expect(resolveBoolTruthy(1)).toBe(true);
    expect(resolveBoolTruthy("1")).toBe(true);
    expect(resolveBoolTruthy("true")).toBe(true);
    expect(resolveBoolTruthy("TRUE")).toBe(true);
  });

  it("treats everything else as false", () => {
    expect(resolveBoolTruthy(false)).toBe(false);
    expect(resolveBoolTruthy(0)).toBe(false);
    expect(resolveBoolTruthy("0")).toBe(false);
    expect(resolveBoolTruthy("false")).toBe(false);
    expect(resolveBoolTruthy(null)).toBe(false);
    expect(resolveBoolTruthy(undefined)).toBe(false);
    expect(resolveBoolTruthy("")).toBe(false);
  });
});

describe("truncateHexPreview (#647)", () => {
  it("returns the string unchanged when within the limit", () => {
    const hex = "0f".repeat(10); // 20 chars
    expect(truncateHexPreview(hex, 64)).toEqual({ preview: hex, truncated: false });
  });

  it("truncates and appends an ellipsis when over the limit", () => {
    const hex = "ab".repeat(40); // 80 chars
    const result = truncateHexPreview(hex, 64);
    expect(result.truncated).toBe(true);
    expect(result.preview).toBe(`${hex.slice(0, 64)}…`);
    expect(result.preview.length).toBe(65); // 64 chars + ellipsis glyph
  });

  it("treats a value exactly at the limit as not truncated", () => {
    const hex = "a".repeat(64);
    expect(truncateHexPreview(hex, 64)).toEqual({ preview: hex, truncated: false });
  });

  it("defaults maxChars to 64 (grid preview length)", () => {
    const hex = "b".repeat(100);
    expect(truncateHexPreview(hex)).toEqual({
      preview: `${"b".repeat(64)}…`,
      truncated: true,
    });
  });
});
