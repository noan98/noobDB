import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { insertHints, insertHintsRefresh } from "../components/insertHintsExtension";
import type { HintMode } from "../components/insertValues";

function mount(doc: string, mode: HintMode, cursor: number) {
  const state: { mode: HintMode } = { mode };
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: [
        insertHints({
          getMode: () => state.mode,
          getSchema: () => ({
            tables: [{ name: "t", columns: ["id", "name"] }],
            defaultDatabase: "app",
            driver: "mysql",
          }),
        }),
      ],
    }),
    parent: document.body,
  });
  return { view, state };
}

const labels = (view: EditorView) =>
  Array.from(view.dom.querySelectorAll(".cm-insert-hint")).map((n) => n.textContent);

describe("insertHints 拡張 (#2424)", () => {
  const doc = "INSERT INTO t (a, b) VALUES (1, 2),\n(3, 4);\nINSERT INTO t VALUES (5, 6);";
  it("cursor モードはカーソル行のタプルだけ、モード変更の合図で切り替わる", () => {
    const { view, state } = mount(doc, "cursor", doc.indexOf("(3, 4)") + 1);
    expect(labels(view)).toEqual(["a:", "b:"]);
    expect(view.dom.querySelectorAll(".cm-insert-hint-active")).toHaveLength(1);
    state.mode = "always";
    view.dispatch({ effects: insertHintsRefresh.of(null) });
    expect(labels(view)).toEqual(["a:", "b:", "a:", "b:", "id:", "name:"]);
    state.mode = "off";
    view.dispatch({ effects: insertHintsRefresh.of(null) });
    expect(labels(view)).toEqual([]);
    view.destroy();
  });
});
