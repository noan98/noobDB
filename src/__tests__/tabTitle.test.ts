import { describe, expect, it } from "vitest";
import {
  TAB_RENAME_MAX,
  TAB_TITLE_MAX,
  autoTitleOnRun,
  deriveQueryTabTitle,
  resolveNewTabTitle,
  copyTitle,
  persistedTitleManual,
  resolveRename,
  resolveRestoredTitle,
} from "../tabTitle";

const UNTITLED = "Query";

describe("deriveQueryTabTitle", () => {
  it("先頭の非空行を使う", () => {
    expect(deriveQueryTabTitle("\n  SELECT 1\nFROM t")).toBe("SELECT 1");
  });
  it("空・空白だけ・コメントだけは null", () => {
    expect(deriveQueryTabTitle("")).toBeNull();
    expect(deriveQueryTabTitle("  \n\t")).toBeNull();
    expect(deriveQueryTabTitle("-- メモ\n-- もう一行")).toBeNull();
    expect(deriveQueryTabTitle("/* a\nb */")).toBeNull();
    expect(deriveQueryTabTitle("/* 未終端")).toBeNull();
    expect(deriveQueryTabTitle("# mysql comment")).toBeNull();
  });
  it("先頭のコメントを飛ばして最初のコード行を使う", () => {
    expect(deriveQueryTabTitle("-- 注文集計\nSELECT * FROM orders")).toBe("SELECT * FROM orders");
    expect(deriveQueryTabTitle("/* hdr */ SELECT 2")).toBe("SELECT 2");
    expect(deriveQueryTabTitle("/* x\ny */\nSELECT 3")).toBe("SELECT 3");
  });
  it("空白の連続は 1 つに畳む", () => {
    expect(deriveQueryTabTitle("SELECT   a,\t b")).toBe("SELECT a, b");
  });
  it("長い SQL は TAB_TITLE_MAX 文字に切り詰めて … を付ける", () => {
    const t = deriveQueryTabTitle(`SELECT ${"x".repeat(100)}`);
    expect(t).not.toBeNull();
    expect([...(t as string)]).toHaveLength(TAB_TITLE_MAX);
    expect(t?.endsWith("…")).toBe(true);
    expect(deriveQueryTabTitle("x".repeat(TAB_TITLE_MAX))).toBe("x".repeat(TAB_TITLE_MAX));
  });
});

describe("autoTitleOnRun", () => {
  it("手動命名のタブは上書きしない", () => {
    expect(autoTitleOnRun({ kind: "query", title: "mine", titleManual: true }, "SELECT 1")).toBeNull();
  });
  it("query 以外は対象外", () => {
    expect(autoTitleOnRun({ kind: "table", title: "users" }, "SELECT 1")).toBeNull();
    expect(autoTitleOnRun({ kind: "explain", title: "Explain" }, "SELECT 1")).toBeNull();
  });
  it("自動命名のタブは実行した SQL へ追従する", () => {
    expect(autoTitleOnRun({ kind: "query", title: UNTITLED }, "SELECT 1")).toBe("SELECT 1");
    expect(autoTitleOnRun({ kind: "query", title: "SELECT 1", titleManual: false }, "SELECT 2")).toBe("SELECT 2");
  });
  it("空 / コメントだけ / 同じ名前なら変更しない", () => {
    expect(autoTitleOnRun({ kind: "query", title: "SELECT 1" }, "")).toBeNull();
    expect(autoTitleOnRun({ kind: "query", title: "SELECT 1" }, "-- c")).toBeNull();
    expect(autoTitleOnRun({ kind: "query", title: "SELECT 1" }, "SELECT 1")).toBeNull();
  });
});

describe("resolveNewTabTitle", () => {
  it("無題プレースホルダは SQL から自動命名 (手動ではない)", () => {
    expect(resolveNewTabTitle({ kind: "query", title: UNTITLED, sql: "SELECT 1" }, UNTITLED)).toEqual({
      title: "SELECT 1",
      titleManual: false,
    });
  });
  it("空 SQL ならプレースホルダのまま", () => {
    expect(resolveNewTabTitle({ kind: "query", title: UNTITLED, sql: "" }, UNTITLED)).toEqual({
      title: UNTITLED,
      titleManual: false,
    });
  });
  it("フラグ未指定で SQL 由来でない明示タイトルは手動扱いにして保護する", () => {
    expect(resolveNewTabTitle({ kind: "query", title: "スニペット名", sql: "SELECT 1" }, UNTITLED)).toEqual({
      title: "スニペット名",
      titleManual: true,
    });
  });
  it("フラグ未指定で SQL 由来のタイトルは自動のまま", () => {
    expect(resolveNewTabTitle({ kind: "query", title: "SELECT 1", sql: "SELECT 1" }, UNTITLED)).toEqual({
      title: "SELECT 1",
      titleManual: false,
    });
  });
  it("明示されたフラグは尊重する (復元・複製)", () => {
    expect(
      resolveNewTabTitle({ kind: "query", title: "old", titleManual: false, sql: "SELECT 9" }, UNTITLED),
    ).toEqual({ title: "old", titleManual: false });
    expect(
      resolveNewTabTitle({ kind: "query", title: UNTITLED, titleManual: true, sql: "SELECT 9" }, UNTITLED),
    ).toEqual({ title: UNTITLED, titleManual: true });
  });
  it("query 以外は触らない", () => {
    expect(resolveNewTabTitle({ kind: "explain", title: "Explain: x", sql: "x" }, UNTITLED)).toEqual({
      title: "Explain: x",
      titleManual: undefined,
    });
  });
});

describe("resolveRename", () => {
  const q = { kind: "query" as const, title: "SELECT 1" };
  it("名前を付けると手動扱い", () => {
    expect(resolveRename(q, "  注文集計 ", "SELECT 1", UNTITLED)).toEqual({ title: "注文集計", titleManual: true });
  });
  it("長すぎる名前は TAB_RENAME_MAX 文字に切る", () => {
    const r = resolveRename(q, "a".repeat(TAB_RENAME_MAX + 20), "", UNTITLED);
    expect(r?.title).toHaveLength(TAB_RENAME_MAX);
  });
  it("空にすると自動命名へ戻す (現在の SQL から導出)", () => {
    expect(resolveRename({ ...q, title: "mine", titleManual: true }, "  ", "SELECT 7", UNTITLED)).toEqual({
      title: "SELECT 7",
      titleManual: false,
    });
  });
  it("空にして導出できなければ無題プレースホルダ", () => {
    expect(resolveRename({ ...q, title: "mine", titleManual: true }, "", "-- c", UNTITLED)).toEqual({
      title: UNTITLED,
      titleManual: false,
    });
  });
  it("自動名のまま空で確定しても変更なし", () => {
    expect(resolveRename(q, "", "SELECT 1", UNTITLED)).toBeNull();
  });
  it("手動名と同じ名前なら変更なし", () => {
    expect(resolveRename({ ...q, titleManual: true }, "SELECT 1", "SELECT 1", UNTITLED)).toBeNull();
  });
  it("自動名と同じ名前で確定したら手動へ昇格する", () => {
    expect(resolveRename(q, "SELECT 1", "SELECT 1", UNTITLED)).toEqual({ title: "SELECT 1", titleManual: true });
  });
  it("query 以外はリネーム不可", () => {
    expect(resolveRename({ kind: "table", title: "users" }, "x", "", UNTITLED)).toBeNull();
    expect(resolveRename({ kind: "explain", title: "e" }, "x", "", UNTITLED)).toBeNull();
  });
});

describe("copyTitle", () => {
  it("接尾辞を付け、既に付いていれば重ねない", () => {
    expect(copyTitle("mine", "(copy)")).toBe("mine (copy)");
    expect(copyTitle("mine (copy)", "(copy)")).toBe("mine (copy)");
  });
});

describe("resolveRestoredTitle", () => {
  it("手動フラグ付きはそのまま", () => {
    expect(resolveRestoredTitle({ title: "mine", titleManual: true, sql: "SELECT 1" }, UNTITLED)).toEqual({ title: "mine", titleManual: true });
  });
  it("フラグ false の自動名は保つ (SQL とずれていても手動にしない)", () => {
    expect(resolveRestoredTitle({ title: "old", titleManual: false, sql: "SELECT 2" }, UNTITLED)).toEqual({ title: "old", titleManual: false });
  });
  it("無題のまま SQL を持つタブは SQL から命名する (フラグの有無によらず)", () => {
    expect(resolveRestoredTitle({ title: UNTITLED, sql: "SELECT 3" }, UNTITLED)).toEqual({ title: "SELECT 3", titleManual: false });
    expect(resolveRestoredTitle({ title: UNTITLED, titleManual: false, sql: "SELECT 3" }, UNTITLED)).toEqual({ title: "SELECT 3", titleManual: false });
  });
  it("旧データ (フラグ無し) の明示タイトルは手動扱いで守る", () => {
    expect(resolveRestoredTitle({ title: "スニペット名", sql: "SELECT 1" }, UNTITLED)).toEqual({ title: "スニペット名", titleManual: true });
  });
  it("旧データで SQL 由来のタイトルは自動のまま", () => {
    expect(resolveRestoredTitle({ title: "SELECT 1", sql: "SELECT 1" }, UNTITLED)).toEqual({ title: "SELECT 1", titleManual: false });
  });
});

describe("persistedTitleManual", () => {
  it("query タブはフラグが無くても boolean を書く (無しは自動名)", () => {
    expect(persistedTitleManual({ kind: "query" })).toBe(false);
    expect(persistedTitleManual({ kind: "query", titleManual: false })).toBe(false);
    expect(persistedTitleManual({ kind: "query", titleManual: true })).toBe(true);
  });
  it("table / EXPLAIN タブは書かない", () => {
    expect(persistedTitleManual({ kind: "table", titleManual: true })).toBeUndefined();
    expect(persistedTitleManual({ kind: "explain" })).toBeUndefined();
  });
  it("分割ペインの新規タブ (フラグ無し) を自動命名後に SQL だけ書き換えて保存・復元しても、手動名にならない", () => {
    // addTab を通らない新規タブは titleManual が付かず、自動命名 (autoNameTab) もフラグを足さない。
    const tab = { kind: "query" as const, title: "SELECT * FROM fruits" };
    const saved = {
      title: tab.title,
      titleManual: persistedTitleManual(tab),
      sql: "SELECT * FROM fruits zz",
    };
    expect(resolveRestoredTitle(saved, UNTITLED)).toEqual({
      title: "SELECT * FROM fruits",
      titleManual: false,
    });
  });
});
