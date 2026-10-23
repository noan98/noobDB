import { describe, expect, it } from "vitest";
import { buildEditorPlaceholder, pickExampleTable } from "../components/editorPlaceholder";

describe("pickExampleTable", () => {
  it("選択中 > スキーマ先頭 > null の順で選ぶ", () => {
    expect(pickExampleTable({ name: "a" }, { name: "b" }, [{ name: "c" }])).toBe("a");
    expect(pickExampleTable(null, { name: "b" }, [{ name: "c" }])).toBe("b");
    expect(pickExampleTable(undefined, null, [{ name: "c" }])).toBe("c");
    expect(pickExampleTable(null, null, [])).toBeNull();
    expect(pickExampleTable(null, null, null)).toBeNull();
  });
});

describe("buildEditorPlaceholder", () => {
  const base = { genericTable: "your_table", hint: "-- Ctrl+Enter to run" };
  it("ドライバに合わせて識別子を引用する", () => {
    expect(buildEditorPlaceholder({ ...base, driver: "mysql", table: "users" })).toBe(
      "SELECT * FROM `users` LIMIT 100;\n-- Ctrl+Enter to run",
    );
    expect(buildEditorPlaceholder({ ...base, driver: "postgres", table: 'we"ird' })).toContain('"we""ird"');
    expect(buildEditorPlaceholder({ ...base, driver: "sqlite", table: "t" })).toContain('"t"');
  });
  it("テーブルが分からなければ汎用の例示", () => {
    expect(buildEditorPlaceholder({ ...base, driver: "mysql", table: null })).toBe(
      "SELECT * FROM your_table LIMIT 100;\n-- Ctrl+Enter to run",
    );
  });
});
