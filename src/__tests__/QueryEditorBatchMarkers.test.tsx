import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, createRef } from "react";
import userEvent from "@testing-library/user-event";
import { EditorView } from "@codemirror/view";
import { renderWithProviders } from "./testUtils";
import { QueryEditor, type QueryEditorHandle } from "../components/QueryEditor";
import { setLocale } from "../i18n";

function currentView(): EditorView {
  const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement);
  if (!view) throw new Error("EditorView not found");
  return view;
}
const glyphs = () =>
  Array.from(document.querySelectorAll(".cm-batch-gutter-glyph:not(.cm-batch-gutter-glyph-spacer)")).map(
    (e) => e.className.replace(/.*cm-batch-gutter-glyph-/, ""),
  );
const msTexts = () => Array.from(document.querySelectorAll(".cm-batch-gutter-ms")).map((e) => e.textContent);

const script = "SELECT 1;\nSELECT 2;\nBROKEN;\nSELECT 4;\nSELECT 5;";

describe("QueryEditor のバッチ実行マーカー (#2331)", () => {
  beforeEach(() => setLocale("en"));

  const render = (props: Partial<React.ComponentProps<typeof QueryEditor>> = {}, sql = script) =>
    renderWithProviders(<QueryEditor tabId="a" onRun={() => {}} initialSql={sql} {...props} />);

  it("実行中は 1 文目が running、残りは pending。結果が届くたびに成否と ms が出る", () => {
    const { rerender } = render({ batch: { script, results: [], running: true } });
    expect(glyphs()).toEqual(["running", "pending", "pending", "pending", "pending"]);
    const results = [
      { status: "ok" as const, elapsedMs: 4 },
      { status: "ok" as const, elapsedMs: 1200 },
      { status: "error" as const, elapsedMs: 7, error: "syntax error near BROKEN" },
      { status: "skipped" as const },
      { status: "skipped" as const },
    ];
    rerender(
      <QueryEditor
        tabId="a"
        onRun={() => {}}
        initialSql={script}
        batch={{ script, results: results.slice(0, 1), running: true }}
      />,
    );
    expect(glyphs()).toEqual(["ok", "running", "pending", "pending", "pending"]);
    rerender(
      <QueryEditor
        tabId="a"
        onRun={() => {}}
        initialSql={script}
        batch={{ script, results, running: false }}
      />,
    );
    // 3 文目が失敗、4・5 文目は未実行
    expect(glyphs()).toEqual(["ok", "ok", "error", "skipped", "skipped"]);
    expect(msTexts()).toEqual(["4ms", "1.2s", "7ms"]);
    // 失敗した文のエラー位置には実行時エラーと同じ波線
    expect(document.querySelectorAll(".cm-runtime-error").length).toBeGreaterThan(0);
  });

  it("選択範囲だけを実行しても、マーカーは選択した側の文の行に付く", () => {
    const doc = `${script}\n\n${script}`;
    const second = doc.lastIndexOf("SELECT 1;");
    const ref = createRef<QueryEditorHandle>();
    renderWithProviders(
      <QueryEditor
        ref={ref}
        tabId="a"
        onRun={() => {}}
        initialSql={doc}
        initialSelection={{ anchor: second, head: doc.length }}
        batch={{ script, results: [], running: true }}
      />,
    );
    expect(currentView().state.selection.main.from).toBe(second);
    expect(glyphs()).toHaveLength(5);
    // ガターは印のある行だけ要素を持ち、手前の行ぶんは margin-top で空く。前半のスクリプトの行 (0〜4 行目) に
    // 印は付かず、最初の印は後半の先頭 (5 行目) の手前に 5 行ぶんの余白を持つ。
    const first = Array.from(
      document.querySelectorAll<HTMLElement>(".cm-batch-gutter .cm-gutterElement"),
    ).find((e) => e.querySelector(".cm-batch-gutter-glyph:not(.cm-batch-gutter-glyph-spacer)"));
    const lineH = Number.parseFloat(first?.style.height ?? "0");
    expect(Number.parseFloat(first?.style.marginTop ?? "0")).toBeCloseTo(lineH * 6, 0);
  });

  it("編集すると位置が追従し、範囲を壊した文は stale (薄い表示) になる。閉じる (null) と全部消える", () => {
    const results = [
      { status: "ok" as const, elapsedMs: 1 },
      { status: "ok" as const, elapsedMs: 2 },
    ];
    const two = "-- x\nSELECT 1;\nSELECT 2;";
    const body = "SELECT 1;\nSELECT 2;";
    const { rerender } = render({ batch: { script: body, results, running: false } }, two);
    const view = currentView();
    act(() => {
      view.dispatch({ changes: { from: 0, insert: "-- c\n" } });
    });
    expect(document.querySelectorAll(".cm-batch-gutter-cell-stale")).toHaveLength(0);
    const at = view.state.doc.toString().indexOf("SELECT 2");
    act(() => {
      view.dispatch({ changes: { from: at + 7, to: at + 8, insert: "3" } });
    });
    expect(document.querySelectorAll(".cm-batch-gutter-cell-stale")).toHaveLength(1);
    expect(glyphs()).toEqual(["ok", "ok"]);
    rerender(<QueryEditor tabId="a" onRun={() => {}} initialSql={two} batch={null} />);
    expect(glyphs()).toEqual([]);
  });

  it("ガターのマーカーはボタンで、クリックと Enter で onBatchMarkerClick に文の番号が渡る", async () => {
    const onClick = vi.fn();
    render({
      batch: { script, results: [{ status: "ok", elapsedMs: 1 }], running: true },
      onBatchMarkerClick: onClick,
    });
    const btns = document.querySelectorAll<HTMLButtonElement>(".cm-batch-gutter-btn");
    expect(btns).toHaveLength(5);
    expect(btns[0]?.getAttribute("aria-label")).toContain("Statement 1");
    const user = userEvent.setup();
    await user.click(btns[2] as HTMLElement);
    expect(onClick).toHaveBeenLastCalledWith(2);
    (btns[3] as HTMLElement).focus();
    await user.keyboard("{Enter}");
    expect(onClick).toHaveBeenLastCalledWith(3);
  });

  it("revealBatchStatement はマーカーがあれば true、無ければ false", () => {
    const ref = createRef<QueryEditorHandle>();
    renderWithProviders(
      <QueryEditor
        ref={ref}
        tabId="a"
        onRun={() => {}}
        initialSql={script}
        batch={{ script, results: [], running: true }}
      />,
    );
    expect(ref.current?.revealBatchStatement(2)).toBe(true);
    expect(ref.current?.revealBatchStatement(9)).toBe(false);
  });
});
