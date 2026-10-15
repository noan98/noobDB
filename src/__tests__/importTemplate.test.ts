import { describe, expect, it } from "vitest";
import type { ImportTemplate } from "../api/tauri";
import {
  buildImportTemplate,
  nullModeOf,
  templateSettings,
  templateToMapping,
} from "../components/importTemplate";

const base: ImportTemplate = {
  id: "x",
  profileId: "p1",
  database: "shop",
  table: "orders",
  format: "csv",
  delimiter: ";",
  quote: '"',
  hasHeader: true,
  nullToken: "",
  encoding: "shift_jis",
  sheet: null,
  conflictMode: "update",
  errorMode: "skip",
  keyColumns: ["id"],
  mapping: [
    { column: "id", header: "ID", csvIndex: 0 },
    { column: "total", header: "金額", csvIndex: 2 },
  ],
  updatedAtMs: 1,
};

describe("import template (#1623)", () => {
  it("maps NULL tokens to the UI choice", () => {
    expect(nullModeOf(null)).toEqual({ mode: "none", custom: "NULL" });
    expect(nullModeOf("")).toEqual({ mode: "empty", custom: "NULL" });
    expect(nullModeOf("\\N")).toEqual({ mode: "custom", custom: "\\N" });
  });

  it("restores settings and falls back to defaults for unknown values", () => {
    expect(templateSettings(base)).toMatchObject({
      format: "csv",
      delimiter: ";",
      nullMode: "empty",
      encoding: "shift_jis",
      errorMode: "skip",
      conflictMode: "update",
      keyColumns: ["id"],
    });
    const odd = templateSettings({
      ...base,
      format: "parquet",
      delimiter: "|",
      quote: "ab",
      conflictMode: "?",
    });
    expect(odd).toMatchObject({ format: "csv", delimiter: ",", quote: '"', conflictMode: "insert" });
  });

  it("re-resolves columns by header name when the column order changed", () => {
    const m = templateToMapping(base, ["金額", "備考", "id"], true, ["id", "total", "memo"]);
    expect(m).toEqual({ id: 2, total: 0, memo: null });
  });

  it("falls back to the saved position when the header is gone, but only inside the file width", () => {
    expect(templateToMapping(base, ["a", "b", "c"], true, ["id", "total"])).toEqual({ id: 0, total: 2 });
    expect(templateToMapping(base, ["a", "b"], true, ["id", "total"])).toEqual({ id: 0, total: null });
    // ヘッダー無しのファイルは位置だけで対応づける。
    expect(templateToMapping(base, ["c1", "c2", "c3"], false, ["total"])).toEqual({ total: 2 });
  });

  it("builds a template with header names and no file path", () => {
    const tpl = buildImportTemplate({
      profileId: "p1",
      database: "shop",
      table: "orders",
      settings: {
        format: "csv",
        delimiter: ",",
        quote: '"',
        hasHeader: true,
        nullToken: null,
        encoding: "utf-8",
        sheet: "",
        errorMode: "abort",
        conflictMode: "insert",
        keyColumns: [],
      },
      mapping: [{ column: "id", csvIndex: 1 }],
      headers: ["x", "ID"],
      namedHeaders: true,
    });
    expect(tpl.mapping).toEqual([{ column: "id", header: "ID", csvIndex: 1 }]);
    expect(tpl.nullToken).toBeNull();
    expect(tpl.sheet).toBeNull();
    expect(Object.keys(tpl).some((k) => /path/i.test(k))).toBe(false);
  });
});
