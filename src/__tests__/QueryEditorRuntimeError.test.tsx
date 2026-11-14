import { beforeEach, describe, expect, it } from "vitest";
import { act, createRef } from "react";
import { EditorView } from "@codemirror/view";
import { renderWithProviders } from "./testUtils";
import { QueryEditor, type QueryEditorHandle } from "../components/QueryEditor";
import { setLocale } from "../i18n";

function currentView(): EditorView {
  const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement);
  if (!view) throw new Error("EditorView not found");
  return view;
}
const squiggle = () => Array.from(document.querySelectorAll(".cm-runtime-error")).map((e) => e.textContent);

describe("QueryEditor の実行時エラー波線 (#2330)", () => {
  beforeEach(() => setLocale("en"));
  const sql = "SELECT 1;\nSELECT foo FROM t";
  const stmt = "SELECT foo FROM t";
  const err = 'column "foo" does not exist (position 8)';

  it("エラー位置に波線とガターマーカーが出て、範囲を編集すると消える", () => {
    renderWithProviders(
      <QueryEditor tabId="a" onRun={() => {}} initialSql={sql} runtimeError={err} runtimeErrorSql={stmt} />,
    );
    expect(squiggle()).toEqual(["foo"]);
    expect(document.querySelectorAll(".cm-runtime-error-gutter-glyph-error")).toHaveLength(1);
    const view = currentView();
    act(() => {
      view.dispatch({ changes: { from: 0, insert: "-- c\n" } });
    });
    expect(squiggle()).toEqual(["foo"]); // 手前の編集では残り、追従する
    const at = view.state.doc.toString().indexOf("foo");
    act(() => {
      view.dispatch({ changes: { from: at, to: at + 3, insert: "id" } });
    });
    expect(squiggle()).toEqual([]);
  });

  it("再実行が成功すると (runtimeError=null) 消える。実行中 (undefined) は残る", () => {
    const { rerender } = renderWithProviders(
      <QueryEditor tabId="a" onRun={() => {}} initialSql={sql} runtimeError={err} runtimeErrorSql={stmt} />,
    );
    rerender(
      <QueryEditor
        tabId="a"
        onRun={() => {}}
        initialSql={sql}
        runtimeError={undefined}
        runtimeErrorSql={stmt}
      />,
    );
    expect(squiggle()).toEqual(["foo"]);
    rerender(
      <QueryEditor tabId="a" onRun={() => {}} initialSql={sql} runtimeError={null} runtimeErrorSql={stmt} />,
    );
    expect(squiggle()).toEqual([]);
  });

  it("revealRuntimeError は波線があれば true、無くフォールバックも見つからなければ false", () => {
    const ref = createRef<QueryEditorHandle>();
    renderWithProviders(
      <QueryEditor
        ref={ref}
        tabId="a"
        onRun={() => {}}
        initialSql={sql}
        runtimeError={err}
        runtimeErrorSql={stmt}
      />,
    );
    expect(ref.current?.revealRuntimeError()).toBe(true);
    const view = currentView();
    act(() => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "SELECT 2" } });
    });
    expect(ref.current?.revealRuntimeError()).toBe(false);
    expect(ref.current?.revealRuntimeError({ sql: stmt, error: err })).toBe(false);
  });
});
