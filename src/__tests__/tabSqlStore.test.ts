import appSrc from "../App.tsx?raw";
import paneViewSrc from "../components/PaneView.tsx?raw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Text } from "@codemirror/state";
import { TabDirtyWatcher, TabSqlStore } from "../tabSqlStore";

// タブの本文を読む箇所は App と、ペインを描画する PaneView (#1318) の両方が対象。
const src = `${appSrc}\n${paneViewSrc}`;

// #1316: 打鍵ごとに tabs を更新しない代わりに、最新本文は TabSqlStore から読む。
// 本文を読む各経路 (実行 / EXPLAIN / 永続化 / ファイル保存 / タブ切替 / 複製) が
// 古い `tab.sql` を読まないことを、同じ `resolve` / `withLatest` の契約で固定する。

const tab = { id: "t1", sql: "SELECT 1" };

describe("TabSqlStore", () => {
  it("編集されていないタブは tab.sql にフォールバックする", () => {
    const store = new TabSqlStore();
    expect(store.resolve("t1", tab.sql)).toBe("SELECT 1");
    expect(store.withLatest(tab)).toBe(tab);
  });

  it("set は文字列化せず、get で初めて toString し、同じ doc の間はメモ化する", () => {
    const store = new TabSqlStore();
    const doc = Text.of(["DELETE FROM users"]);
    const spy = vi.spyOn(doc, "toString");
    store.set("t1", doc);
    store.set("t1", doc);
    expect(spy).not.toHaveBeenCalled();
    expect(store.get("t1")).toBe("DELETE FROM users");
    expect(store.get("t1")).toBe("DELETE FROM users");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("最新の doc に置き換えると古い本文を返さない (危険クエリ判定・プリフライトの入力)", () => {
    const store = new TabSqlStore();
    store.set("t1", Text.of(["SELECT 1"]));
    expect(store.get("t1")).toBe("SELECT 1");
    store.set("t1", Text.of(["DELETE FROM users"]));
    expect(store.resolve("t1", "SELECT 1")).toBe("DELETE FROM users");
  });

  it("永続化・複製・保存へ渡すタブは最新本文に差し替わる", () => {
    const store = new TabSqlStore();
    store.set("t1", Text.of(["a", "b"]));
    expect(store.withLatest(tab)).toEqual({ id: "t1", sql: "a\nb" });
    // 元のタブは書き換えない
    expect(tab.sql).toBe("SELECT 1");
  });

  it("delete 後は tab.sql に戻る (プログラムからの書き換え・タブを閉じたとき)", () => {
    const store = new TabSqlStore();
    store.set("t1", Text.of(["old"]));
    store.delete("t1");
    expect(store.resolve("t1", "new")).toBe("new");
    expect(store.has("t1")).toBe(false);
  });
});

describe("TabDirtyWatcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("連続入力中は再描画を要求せず、dirty が切り替わったときだけ 1 回要求する", () => {
    let dirty = false;
    const onFlip = vi.fn();
    const w = new TabDirtyWatcher(() => dirty, onFlip, 150);
    w.recordShown("t1", false);
    dirty = true;
    for (let i = 0; i < 20; i++) {
      w.noteChange("t1");
      vi.advanceTimersByTime(50);
    }
    expect(onFlip).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(onFlip).toHaveBeenCalledTimes(1);
  });

  it("dirty が変わらなければ再描画を要求しない", () => {
    const onFlip = vi.fn();
    const w = new TabDirtyWatcher(() => true, onFlip, 150);
    w.recordShown("t1", true);
    w.noteChange("t1");
    vi.advanceTimersByTime(500);
    expect(onFlip).not.toHaveBeenCalled();
  });

  it("元の本文へ戻したら dirty が外れる (切り替わりとして再描画する)", () => {
    let dirty = true;
    const onFlip = vi.fn();
    const w = new TabDirtyWatcher(() => dirty, onFlip, 150);
    w.recordShown("t1", true);
    dirty = false;
    w.noteChange("t1");
    vi.advanceTimersByTime(150);
    expect(onFlip).toHaveBeenCalledTimes(1);
  });

  it("forget / dispose で保留中の判定を捨てる", () => {
    const onFlip = vi.fn();
    const w = new TabDirtyWatcher(() => true, onFlip, 150);
    w.noteChange("a");
    w.forget("a");
    w.noteChange("b");
    w.dispose();
    vi.advanceTimersByTime(500);
    expect(onFlip).not.toHaveBeenCalled();
  });
});

// `tab.sql` の直読みを許す行。行末で終わるかを見るのは最後の 1 つだけなので、正規表現を分けて
// 書く (1 本の `|` にまとめると、`$` がどこまでに掛かるかが紛らわしい)。
const ALLOWED_DIRECT_READS = [
  /tabSqlStore\.resolve/,
  /toPersistedTab/,
  /const out: PersistedTab/,
  /\btab\.sql\),$/,
];

describe("App.tsx の本文の読み方 (#1316 静的ガード)", () => {
  it("打鍵ごとに updateTab({ sql }) で tabs を更新しない", () => {
    expect(src).not.toMatch(/updateTab\([^)]*\{\s*sql\s*\}/);
    expect(src).toContain("onDocChange=");
  });

  it("Tab の本文は tab.sql を直接読まず getTabSql / TabSqlStore を通す", () => {
    // `tab.sql` / `tt.sql` / `t.sql` / `activeTab.sql` の直読みは、永続化 (toPersistedTab 内) と
    // フォールバック (store.resolve の第 2 引数) 以外に無いこと。snippet.sql などは別物。
    const direct = [...src.matchAll(/\b(?:tab|tt|t|activeTab|target)\.sql\b/g)].map((m) => {
      const line = src.slice(0, m.index).split("\n").length;
      return `${line}:${src.split("\n")[line - 1].trim()}`;
    });
    const allowed = direct.filter(
      (l) => !/^\d+:\/\//.test(l) && !ALLOWED_DIRECT_READS.some((re) => re.test(l)),
    );
    expect(allowed).toEqual([]);
  });
});
