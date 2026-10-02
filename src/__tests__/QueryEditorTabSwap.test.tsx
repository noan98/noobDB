import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { renderWithProviders } from "./testUtils";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import { QueryEditor } from "../components/QueryEditor";
import { setLocale } from "../i18n";
import type { TableSchema } from "../api/tauri";
import { TabSqlStore } from "../tabSqlStore";

// #1308: タブを切り替えても EditorView を作り直さず、EditorState の差し替えで済ませる。
// `new EditorView` の回数と、補完 (`sql()` 拡張) の組み立て回数を数えて固定する。
const counters = vi.hoisted(() => ({ views: 0, sqlExt: 0 }));

vi.mock("@codemirror/view", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@codemirror/view")>();
  class CountingEditorView extends actual.EditorView {
    constructor(config?: ConstructorParameters<typeof actual.EditorView>[0]) {
      super(config);
      counters.views += 1;
    }
  }
  return { ...actual, EditorView: CountingEditorView };
});

vi.mock("@codemirror/lang-sql", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@codemirror/lang-sql")>();
  return {
    ...actual,
    sql: (...args: Parameters<typeof actual.sql>) => {
      counters.sqlExt += 1;
      return actual.sql(...args);
    },
  };
});

function currentView(): EditorView {
  const dom = document.querySelector(".cm-editor") as HTMLElement;
  const view = EditorView.findFromDOM(dom);
  if (!view) throw new Error("EditorView not found");
  return view;
}

const schema = (name: string): TableSchema[] =>
  [{ name, columns: ["id"] }] as unknown as TableSchema[];

describe("QueryEditor のタブ切替 (#1308)", () => {
  beforeEach(() => {
    setLocale("en");
    counters.views = 0;
    counters.sqlExt = 0;
  });

  it("タブを切り替えても EditorView を作り直さず、本文が差し替わる", () => {
    const { rerender } = renderWithProviders(
      <QueryEditor tabId="a" onRun={() => {}} initialSql="SELECT 1" />,
    );
    expect(counters.views).toBe(1);
    const view = currentView();

    rerender(<QueryEditor tabId="b" onRun={() => {}} initialSql="SELECT 2" />);
    expect(counters.views).toBe(1);
    expect(currentView()).toBe(view);
    expect(view.state.doc.toString()).toBe("SELECT 2");

    rerender(<QueryEditor tabId="a" onRun={() => {}} initialSql="SELECT 1" />);
    expect(counters.views).toBe(1);
    expect(view.state.doc.toString()).toBe("SELECT 1");
  });

  it("切り替えて戻っても undo 履歴が残り、切替自体は onChange を呼ばない", () => {
    const onChange = vi.fn();
    const { rerender } = renderWithProviders(
      <QueryEditor tabId="a" onRun={() => {}} onChange={onChange} initialSql="SELECT 1" />,
    );
    const view = currentView();
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: " + 1" } });
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    const edited = view.state.doc.toString();
    expect(edited).toBe("SELECT 1 + 1");

    rerender(<QueryEditor tabId="b" onRun={() => {}} onChange={onChange} initialSql="SELECT 2" />);
    rerender(<QueryEditor tabId="a" onRun={() => {}} onChange={onChange} initialSql={edited} />);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(view.state.doc.toString()).toBe(edited);

    act(() => {
      undo(view);
    });
    expect(view.state.doc.toString()).toBe("SELECT 1");
  });

  it("#1316: onDocChange だけなら打鍵で全文を文字列化せず、App は tab.sql を更新しなくても undo が残る", () => {
    // App の配線を再現: tab.sql は古いまま、最新本文は TabSqlStore から読む。
    const store = new TabSqlStore();
    const staleTabSql = { a: "SELECT 1", b: "SELECT 2" };
    const onDocChange = vi.fn((tabId: string, doc: { toString(): string }) => store.set(tabId, doc));
    const el = (tabId: "a" | "b") => (
      <QueryEditor
        tabId={tabId}
        onRun={() => {}}
        onDocChange={(doc) => onDocChange(tabId, doc)}
        initialSql={store.resolve(tabId, staleTabSql[tabId])}
      />
    );
    const { rerender } = renderWithProviders(el("a"));
    const view = currentView();
    const toStringSpy = vi.spyOn(view.state.doc.constructor.prototype, "toString");
    for (const ch of ["x", "y", "z"]) {
      act(() => {
        view.dispatch({ changes: { from: view.state.doc.length, insert: ch } });
      });
    }
    expect(onDocChange).toHaveBeenCalledTimes(3);
    // 打鍵中に Text 全体の toString は走らない (lint / プリフライトは debounce 側)。
    expect(toStringSpy).not.toHaveBeenCalled();
    toStringSpy.mockRestore();
    expect(store.get("a")).toBe("SELECT 1xyz");

    rerender(el("b"));
    expect(view.state.doc.toString()).toBe("SELECT 2");
    rerender(el("a"));
    // 保存済み state が再利用され (= 最新本文との一致確認が通る)、undo 履歴が残る。
    expect(view.state.doc.toString()).toBe("SELECT 1xyz");
    act(() => {
      undo(view);
    });
    expect(view.state.doc.toString()).toBe("SELECT 1");
  });

  it("#1316: 保存済み state が捨てられていても、最新本文 (store) から作り直し編集を失わない", () => {
    const store = new TabSqlStore();
    const el = (tabId: string, sql: string) => (
      <QueryEditor
        tabId={tabId}
        onRun={() => {}}
        onDocChange={(doc) => store.set(tabId, doc)}
        initialSql={store.resolve(tabId, sql)}
      />
    );
    const { rerender } = renderWithProviders(el("a", "SELECT 1"));
    const view = currentView();
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: " -- edited" } });
    });
    // 上限を超える数のタブを経由して a の保存済み state を LRU から追い出す。
    for (let i = 0; i < 30; i++) rerender(el(`x${i}`, `SELECT ${i}`));
    rerender(el("a", "SELECT 1"));
    expect(view.state.doc.toString()).toBe("SELECT 1 -- edited");
  });

  it("保存した本文が App 側のタブ本文と食い違うときは、保存分を捨てて作り直す", () => {
    const { rerender } = renderWithProviders(
      <QueryEditor tabId="a" onRun={() => {}} initialSql="SELECT 1" />,
    );
    const view = currentView();
    rerender(<QueryEditor tabId="b" onRun={() => {}} initialSql="SELECT 2" />);
    rerender(<QueryEditor tabId="a" onRun={() => {}} initialSql="SELECT 99" />);
    expect(view.state.doc.toString()).toBe("SELECT 99");
  });

  it("新規タブへの切替では復元するカーソル位置を doc 長へクランプして適用する", () => {
    const { rerender } = renderWithProviders(
      <QueryEditor tabId="a" onRun={() => {}} initialSql="SELECT 1" />,
    );
    rerender(
      <QueryEditor
        tabId="b"
        onRun={() => {}}
        initialSql="ABC"
        initialSelection={{ anchor: 1, head: 99 }}
      />,
    );
    const sel = currentView().state.selection.main;
    expect(sel.anchor).toBe(1);
    expect(sel.head).toBe(3);
  });

  it("補完の再構成は schema が変わったときだけ (初回マウント・同条件のタブ切替では走らない)", () => {
    const s1 = schema("t1");
    const el = (tabId: string, sql: string, ds: TableSchema[]) => (
      <QueryEditor tabId={tabId} onRun={() => {}} initialSql={sql} databaseSchema={ds} />
    );
    const { rerender } = renderWithProviders(el("a", "SELECT 1", s1));
    expect(counters.sqlExt).toBe(1); // マウント時の 1 回のみ (以前はさらに reconfigure で +1 していた)

    // 初めて開くタブ b は新規 state なので拡張を 1 回組み立てる。保存済みの a へ戻るときは
    // 組み立て直さない。
    rerender(el("b", "SELECT 2", s1));
    expect(counters.sqlExt).toBe(2);
    rerender(el("a", "SELECT 1", s1));
    rerender(el("b", "SELECT 2", s1));
    rerender(el("a", "SELECT 1", s1));
    expect(counters.sqlExt).toBe(2);

    // schema の参照が変わったときだけ補完を作り直す。
    rerender(el("a", "SELECT 1", schema("t2")));
    expect(counters.sqlExt).toBe(3);
  });

  it("保存済み state が古いスキーマで作られていたら、戻ったときに補完を追従させる", () => {
    const { rerender } = renderWithProviders(
      <QueryEditor tabId="a" onRun={() => {}} initialSql="SELECT 1" databaseSchema={schema("t1")} />,
    );
    rerender(
      <QueryEditor tabId="b" onRun={() => {}} initialSql="SELECT 2" databaseSchema={schema("t1")} />,
    );
    const before = counters.sqlExt;
    // 別タブ表示中にスキーマが更新された → タブ b 用の再構成が 1 回走る。
    rerender(
      <QueryEditor tabId="b" onRun={() => {}} initialSql="SELECT 2" databaseSchema={schema("t2")} />,
    );
    expect(counters.sqlExt).toBe(before + 1);
    // 古いスキーマのまま保存されていたタブ a へ戻ると、そこでも 1 回だけ追従する。
    rerender(
      <QueryEditor tabId="a" onRun={() => {}} initialSql="SELECT 1" databaseSchema={schema("t2")} />,
    );
    expect(counters.sqlExt).toBe(before + 2);
  });
});
