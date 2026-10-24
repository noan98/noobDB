import { describe, expect, it } from "vitest";
import { rowKeyNote } from "../rowKey";

describe("rowKeyNote", () => {
  it("PK のときは注記を出さない", () => {
    expect(rowKeyNote("primary_key", ["id"])).toBeNull();
    expect(rowKeyNote(undefined, ["id"])).toBeNull();
  });

  it("UNIQUE キーは列名を差し込む", () => {
    expect(rowKeyNote("unique_key", ["a", "b"])).toEqual({ key: "rowKeyUnique", vars: { columns: "a, b" } });
  });

  it("rowid は専用の注記", () => {
    expect(rowKeyNote("rowid", ["rowid"])?.key).toBe("rowKeyRowid");
  });
});
