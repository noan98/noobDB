import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { createRef } from "react";
import { EditorView } from "@codemirror/view";
import { renderWithProviders } from "./testUtils";
import { insertAtEditorCaret } from "../components/treeDragStore";
import { QueryEditor, type QueryEditorHandle } from "../components/QueryEditor";

// #2451: 別ペインからの差し込みは着地点を光らせ、通常の入力・貼り付けでは光らせない。
function currentView(): EditorView {
  const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement);
  if (!view) throw new Error("EditorView not found");
  return view;
}
const flashed = () => Array.from(document.querySelectorAll(".cm-insert-flash")).map((e) => e.textContent);

describe("QueryEditor の挿入フラッシュ (#2451)", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-motion");
    vi.useRealTimers();
  });

  it("insertText で挿入した範囲だけが光り、時間が経つと消える", () => {
    vi.useFakeTimers();
    const ref = createRef<QueryEditorHandle>();
    renderWithProviders(<QueryEditor ref={ref} onRun={() => {}} initialSql="SELECT 1 FROM t" />);
    act(() => {
      ref.current?.insertText("users.id");
    });
    expect(currentView().state.doc.toString()).toContain("users.id");
    expect(flashed().join("")).toBe("users.id");
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(flashed()).toEqual([]);
  });

  it("通常の入力・貼り付けでは光らない", () => {
    renderWithProviders(<QueryEditor onRun={() => {}} initialSql="SELECT 1" />);
    const view = currentView();
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: " + 1" }, userEvent: "input.type" });
      view.dispatch({ changes: { from: 0, insert: "x" }, userEvent: "input.paste" });
    });
    expect(flashed()).toEqual([]);
  });

  it("hc-* と motion=reduced では光らせない (挿入自体は行う)", () => {
    for (const set of [
      () => document.documentElement.setAttribute("data-theme", "hc-dark"),
      () => document.documentElement.setAttribute("data-motion", "reduced"),
    ]) {
      document.documentElement.removeAttribute("data-theme");
      document.documentElement.removeAttribute("data-motion");
      set();
      const ref = createRef<QueryEditorHandle>();
      const { unmount } = renderWithProviders(
        <QueryEditor ref={ref} onRun={() => {}} initialSql="SELECT 1" />,
      );
      act(() => {
        ref.current?.insertText("abc");
      });
      expect(currentView().state.doc.toString()).toContain("abc");
      expect(flashed()).toEqual([]);
      unmount();
    }
  });

  it("タブストップ付きスニペットでも展開範囲が光る", () => {
    const ref = createRef<QueryEditorHandle>();
    renderWithProviders(<QueryEditor ref={ref} onRun={() => {}} initialSql="" />);
    act(() => {
      ref.current?.insertSnippet("SELECT ${1:col}");
    });
    expect(currentView().state.doc.toString()).toBe("SELECT col");
    expect(flashed().join("")).toBe("SELECT col");
  });

  it("ツリー経由 (insertAtEditorCaret) の挿入でも光る", () => {
    renderWithProviders(<QueryEditor onRun={() => {}} initialSql="SELECT  FROM t" />);
    const el = document.querySelector(".cm-editor") as HTMLElement;
    el.getClientRects = () => [{}] as unknown as DOMRectList;
    const view = currentView();
    act(() => {
      view.dispatch({ selection: { anchor: 7 } });
      insertAtEditorCaret({ kind: "column", database: "d", table: "t", column: "id" });
    });
    expect(flashed().join("")).toContain("id");
  });

  it("連続挿入で前のタイマーが 2 回目のフラッシュを消さない", () => {
    vi.useFakeTimers();
    const ref = createRef<QueryEditorHandle>();
    renderWithProviders(<QueryEditor ref={ref} onRun={() => {}} initialSql="" />);
    act(() => {
      ref.current?.insertText("aaa");
    });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    act(() => {
      ref.current?.insertText("bbb");
    });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(flashed().join("")).toBe("bbb");
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(flashed()).toEqual([]);
  });
});
