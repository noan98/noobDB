import { describe, expect, it } from "vitest";
import { applyRename, autoTitleOnRun, deriveResultTabTitle } from "../tabTitle";

const U = "無題のクエリ";

describe("deriveResultTabTitle", () => {
  it("先頭の非空行をトリムして使う", () => {
    expect(deriveResultTabTitle("\n  \n  SELECT 1  \nFROM t", U)).toBe("SELECT 1");
  });
  it("空白のみ・空文字は既定名", () => {
    expect(deriveResultTabTitle("", U)).toBe(U);
    expect(deriveResultTabTitle(" \n\t\n", U)).toBe(U);
  });
  it("28 文字ちょうどはそのまま、29 文字以上は 27 文字 + 省略記号", () => {
    const s28 = "a".repeat(28);
    expect(deriveResultTabTitle(s28, U)).toBe(s28);
    expect(deriveResultTabTitle("a".repeat(29), U)).toBe(`${"a".repeat(27)}…`);
  });
});

describe("autoTitleOnRun", () => {
  it("手動リネーム済みは上書きしない", () => {
    expect(autoTitleOnRun({ kind: "query", title: "月次", titleManual: true }, "SELECT 1", U)).toBeNull();
  });
  it("query 以外は対象外", () => {
    expect(autoTitleOnRun({ kind: "table", title: "db.t" }, "SELECT 1", U)).toBeNull();
    expect(autoTitleOnRun({ kind: "explain", title: "EXPLAIN: x" }, "SELECT 1", U)).toBeNull();
  });
  it("自動命名のタブは SQL の先頭行になる", () => {
    expect(autoTitleOnRun({ kind: "query", title: U }, "SELECT * FROM users", U)).toBe("SELECT * FROM users");
  });
  it("空 SQL の実行は既定名に戻す", () => {
    expect(autoTitleOnRun({ kind: "query", title: "SELECT 1" }, "  ", U)).toBe(U);
  });
  it("変化がなければ null", () => {
    expect(autoTitleOnRun({ kind: "query", title: "SELECT 1" }, "SELECT 1", U)).toBeNull();
    expect(autoTitleOnRun({ kind: "query", title: U }, "", U)).toBeNull();
  });
});

describe("applyRename", () => {
  it("入力を手動名として確定する (前後の空白は落とす)", () => {
    expect(applyRename({ kind: "query", title: U }, "  月次  ", "SELECT 1", U)).toEqual({
      title: "月次",
      titleManual: true,
    });
  });
  it("空文字は手動指定を解除して SQL から自動命名し直す", () => {
    expect(applyRename({ kind: "query", title: "月次", titleManual: true }, "   ", "SELECT 1", U)).toEqual({
      title: "SELECT 1",
      titleManual: false,
    });
  });
  it("空文字 + 空 SQL は既定名", () => {
    expect(applyRename({ kind: "query", title: "月次", titleManual: true }, "", "", U)).toEqual({
      title: U,
      titleManual: false,
    });
  });
  it("変更がなければ null", () => {
    expect(applyRename({ kind: "query", title: "月次", titleManual: true }, "月次", "x", U)).toBeNull();
    expect(applyRename({ kind: "query", title: "SELECT 1" }, "", "SELECT 1", U)).toBeNull();
  });
  it("自動命名と同じ文字列でも、明示入力なら手動として固定する", () => {
    expect(applyRename({ kind: "query", title: "SELECT 1" }, "SELECT 1", "SELECT 1", U)).toEqual({
      title: "SELECT 1",
      titleManual: true,
    });
  });
});
