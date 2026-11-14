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
const real = (sel: string) =>
  Array.from(document.querySelectorAll(sel)).filter((e) => !e.closest(".cm-batch-gutter-spacer"));
const glyphs = () =>
  real(".cm-batch-gutter-glyph").map((e) => e.className.replace(/.*cm-batch-gutter-glyph-/, ""));
const msTexts = () => real(".cm-batch-gutter-ms").map((e) => e.textContent);

const script = "SELECT 1;\nSELECT 2;\nBROKEN;\nSELECT 4;\nSELECT 5;";
type R = { sql: string; status: "ok" | "error" | "skipped"; elapsedMs?: number; error?: string };
/** `QueryEditor` へ渡すバッチの 3 props。 */
const batch = (scr: string, results: R[], running: boolean) => ({
  batchScript: scr,
  batchResults: results,
  batchRunning: running,
});

describe("QueryEditor のバッチ実行マーカー (#2331)", () => {
  beforeEach(() => setLocale("en"));

  const render = (props: Partial<React.ComponentProps<typeof QueryEditor>> = {}, sql = script) =>
    renderWithProviders(<QueryEditor tabId="a" onRun={() => {}} initialSql={sql} {...props} />);

  const R_ = (sql: string, status: R["status"], elapsedMs?: number, error?: string): R => ({
    sql,
    status,
    elapsedMs,
    error,
  });
  const rerenderWith = (
    rerender: (ui: React.ReactElement) => void,
    scr: string,
    results: R[],
    running: boolean,
    initialSql = scr,
  ) =>
    rerender(
      <QueryEditor tabId="a" onRun={() => {}} initialSql={initialSql} {...batch(scr, results, running)} />,
    );

  it("実行中は 1 文目が running、残りは pending。結果が届くたびに成否と ms が出る", () => {
    const { rerender } = render(batch(script, [], true));
    expect(glyphs()).toEqual(["running", "pending", "pending", "pending", "pending"]);
    const results = [
      R_("SELECT 1", "ok", 4),
      R_("SELECT 2", "ok", 1200),
      R_("BROKEN", "error", 7, "syntax error near BROKEN"),
      R_("SELECT 4", "skipped"),
      R_("SELECT 5", "skipped"),
    ];
    rerenderWith(rerender, script, results.slice(0, 1), true);
    expect(glyphs()).toEqual(["ok", "running", "pending", "pending", "pending"]);
    rerenderWith(rerender, script, results, false);
    // 3 文目が失敗、4・5 文目は未実行
    expect(glyphs()).toEqual(["ok", "ok", "error", "skipped", "skipped"]);
    expect(msTexts()).toEqual(["4ms", "1.2s", "7ms"]);
    // 失敗した文のエラー位置には実行時エラーと同じ波線
    expect(document.querySelectorAll(".cm-runtime-error").length).toBeGreaterThan(0);
  });

  it("取消で結果が途切れたら、先頭の 1 件だけ interrupted、残りは skipped", () => {
    const { rerender } = render(batch(script, [], true));
    rerenderWith(rerender, script, [R_("SELECT 1", "ok", 4)], false);
    expect(glyphs()).toEqual(["ok", "interrupted", "skipped", "skipped", "skipped"]);
  });

  it("全体を包んだ実行 (BEGIN / COMMIT が読み飛ばされる) でも、結果が正しい文の行に付く", () => {
    const wrap = "BEGIN;\nINSERT INTO t VALUES (1);\nCOMMIT;\nSELECT 1;";
    const { rerender } = render(batch(wrap, [], true), wrap);
    expect(glyphs()).toEqual(["running", "pending"]); // BEGIN / COMMIT はガターに出ない
    rerenderWith(
      rerender,
      wrap,
      [R_("INSERT INTO t VALUES (1)", "ok", 5), R_("SELECT 1", "error", 2, "boom")],
      false,
    );
    expect(glyphs()).toEqual(["ok", "error"]);
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
        {...batch(script, [], true)}
      />,
    );
    expect(currentView().state.selection.main.from).toBe(second);
    expect(glyphs()).toHaveLength(5);
    // ガターは印のある行だけ要素を持ち、手前の行ぶんは margin-top で空く。前半のスクリプトの行 (0〜4 行目) に
    // 印は付かず、最初の印は後半の先頭 (5 行目) の手前に 5 行ぶんの余白を持つ。
    const first = Array.from(
      document.querySelectorAll<HTMLElement>(".cm-batch-gutter .cm-gutterElement"),
    ).find((e) => e.querySelector(".cm-batch-gutter-glyph") && !e.querySelector(".cm-batch-gutter-spacer"));
    const lineH = Number.parseFloat(first?.style.height ?? "0");
    expect(Number.parseFloat(first?.style.marginTop ?? "0")).toBeCloseTo(lineH * 6, 0);
  });

  it("編集すると位置が追従し、範囲に食い込んだ文は stale (薄い表示) になる。閉じると全部消える", () => {
    const results = [R_("SELECT 1", "ok", 1), R_("SELECT 2", "ok", 2)];
    const two = "-- x\nSELECT 1;\nSELECT 2;";
    const body = "SELECT 1;\nSELECT 2;";
    const { rerender } = render(batch(body, results, false), two);
    const view = currentView();
    act(() => {
      view.dispatch({ changes: { from: 0, insert: "-- c\n" } });
    });
    expect(document.querySelectorAll(".cm-batch-gutter-cell-stale")).toHaveLength(0);
    // 文の先頭への純粋な挿入 (直前に改行を足すなど) は古い扱いにしない
    const first = view.state.doc.toString().indexOf("SELECT 1");
    act(() => {
      view.dispatch({ changes: { from: first, insert: "\n" } });
    });
    expect(document.querySelectorAll(".cm-batch-gutter-cell-stale")).toHaveLength(0);
    const at = view.state.doc.toString().indexOf("SELECT 2");
    act(() => {
      view.dispatch({ changes: { from: at + 7, to: at + 8, insert: "3" } });
    });
    expect(document.querySelectorAll(".cm-batch-gutter-cell-stale")).toHaveLength(1);
    expect(glyphs()).toEqual(["ok", "ok"]);
    rerender(<QueryEditor tabId="a" onRun={() => {}} initialSql={two} />);
    expect(glyphs()).toEqual([]);
  });

  it("ガターのボタンはマウス専用 (Tab 順に並ばない) で、クリックで onBatchMarkerClick に番号が渡る", async () => {
    const onClick = vi.fn();
    render({ ...batch(script, [R_("SELECT 1", "ok", 1)], true), onBatchMarkerClick: onClick });
    const btns = document.querySelectorAll<HTMLButtonElement>(".cm-batch-gutter-btn");
    expect(btns).toHaveLength(5);
    expect(btns[0]?.getAttribute("aria-label")).toContain("Statement 1");
    expect(Array.from(btns).every((b) => b.tabIndex === -1)).toBe(true);
    await userEvent.setup().click(btns[2] as HTMLElement);
    expect(onClick).toHaveBeenLastCalledWith(2);
  });

  it("ショートカット (Mod+Shift+Y) でカーソル位置の文の結果を開く。マーカーが無ければ何もしない", async () => {
    const onClick = vi.fn();
    render({ ...batch(script, [R_("SELECT 1", "ok", 1)], true), onBatchMarkerClick: onClick });
    const view = currentView();
    view.contentDOM.focus();
    act(() => {
      view.dispatch({ selection: { anchor: script.indexOf("BROKEN") + 2 } });
    });
    const user = userEvent.setup();
    await user.keyboard("{Control>}{Shift>}y{/Shift}{/Control}");
    expect(onClick).toHaveBeenLastCalledWith(2);
    // 文の外 (末尾のセミコロンの後ろ) では何もしない
    onClick.mockClear();
    act(() => {
      view.dispatch({ selection: { anchor: script.length } });
    });
    await user.keyboard("{Control>}{Shift>}y{/Shift}{/Control}");
    expect(onClick).not.toHaveBeenCalled();
  });

  it("revealBatchStatement はマーカーがあれば true、無ければ false", () => {
    const ref = createRef<QueryEditorHandle>();
    renderWithProviders(
      <QueryEditor ref={ref} tabId="a" onRun={() => {}} initialSql={script} {...batch(script, [], true)} />,
    );
    expect(ref.current?.revealBatchStatement(2)).toBe(true);
    expect(ref.current?.revealBatchStatement(9)).toBe(false);
  });
});
