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

  it("入力中の閉じていないタプルにもヒントが出る", () => {
    const d = "INSERT INTO t (a, b, c) VALUES (1, 2, ";
    const { view } = mount(d, "always", d.length);
    expect(labels(view)).toEqual(["a:", "b:"]);
    view.destroy();
  });

  it("DDL の対象表は列リスト省略の INSERT にスキーマの列を補わない", () => {
    const d = "DROP TABLE IF EXISTS t;\nCREATE TABLE t (x int);\nINSERT INTO t VALUES (5, 6);";
    const { view } = mount(d, "always", 0);
    expect(labels(view)).toEqual([]);
    view.destroy();
  });

  it("1.1MB の文書でカーソル移動だけの更新は走査せず軽い", () => {
    const wide = (i: number) =>
      `(${i}, 'user_${i}', 'mail${i}@example.com', 'paid', ${i * 3.5}, NOW(), NULL, 'n (p), c', ${i % 7}, 'x')`;
    const big = `INSERT INTO t (a,b,c,d,e,f,g,h,i,j) VALUES\n${Array.from({ length: 10_000 }, (_, i) => wide(i)).join(",\n")};\n`;
    const { view } = mount(big, "cursor", big.length - 100);
    const t0 = performance.now();
    for (let k = 0; k < 20; k++) view.dispatch({ selection: { anchor: big.length - 100 - k } });
    const per = (performance.now() - t0) / 20;
    expect(per).toBeLessThan(30);
    view.destroy();
  });
});
