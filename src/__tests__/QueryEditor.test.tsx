import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "./testUtils";
import { createRef } from "react";
import { cleanup, fireEvent } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { QueryEditor, type QueryEditorHandle } from "../components/QueryEditor";
import { setLocale, t } from "../i18n";
import { resetAiKeyStoreForTest, setAiKeyPresent } from "../ai/aiKeyStore";
import { attachTreeDragSource } from "../components/treeDragStore";
import type { TreeDragItem } from "../components/treeDragInsert";
import { DEFAULT_SETTINGS, replaceAllSettings } from "../settings";

// QueryEditor の主要な実行フロー (Run ボタン / Ctrl+Enter ショートカット / 空状態
// での無効化 / 選択範囲優先実行) の退行を検出するテスト。CodeMirror を
// jsdom 上で実マウントし、エディタ本文 → onRun の結線が壊れていないことを保証する。
//
// 文言はロケールで変わるため i18n の `t()` から期待値を引く。CodeMirror は
// contenteditable ベースで、テキスト入力のシミュレーションは不安定なため、本文は
// `initialSql` プロップで与え、実行トリガー (クリック / ショートカット) のみを操作する。

describe("QueryEditor", () => {
  beforeEach(() => {
    setLocale("en");
  });

  it("Run ボタンのクリックでエディタ本文を onRun に渡す", async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    renderWithProviders(<QueryEditor onRun={onRun} initialSql="SELECT 1" />);

    await user.click(screen.getByRole("button", { name: t("editorRun") }));

    expect(onRun).toHaveBeenCalledWith("SELECT 1");
  });

  it("Ctrl+Enter (Mod-Enter) で onRun が発火する", async () => {
    const onRun = vi.fn();
    renderWithProviders(<QueryEditor onRun={onRun} initialSql="SELECT 42" />);

    // CodeMirror の編集領域へキーイベントを送る。Mod-Enter キーマップが拾う。
    const editable = document.querySelector(".cm-content") as HTMLElement;
    expect(editable).toBeTruthy();
    editable.focus();
    const user = userEvent.setup();
    await user.keyboard("{Control>}{Enter}{/Control}");

    await waitFor(() => expect(onRun).toHaveBeenCalledWith("SELECT 42"));
  });

  it("Ctrl+Alt+Enter でカーソル位置の単一文だけを実行する (#555)", async () => {
    const onRun = vi.fn();
    renderWithProviders(
      <QueryEditor onRun={onRun} initialSql={"SELECT 1;\nSELECT 2"} />,
    );
    const editable = document.querySelector(".cm-content") as HTMLElement;
    expect(editable).toBeTruthy();
    editable.focus();
    const user = userEvent.setup();
    // カーソルは初期位置 (先頭) なので 1 文目だけが走る。
    await user.keyboard("{Control>}{Alt>}{Enter}{/Alt}{/Control}");

    await waitFor(() => expect(onRun).toHaveBeenCalledWith("SELECT 1"));
  });

  it("本文が空のときは Run が無効化されクリックしても実行されない", async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    renderWithProviders(<QueryEditor onRun={onRun} initialSql="" />);

    const runButton = screen.getByRole("button", { name: t("editorRun") });
    expect(runButton).toBeDisabled();
    await user.click(runButton);
    expect(onRun).not.toHaveBeenCalled();
  });

  it("onPreview を渡すと Preview ボタンがエディタ本文で onPreview を呼ぶ", async () => {
    const user = userEvent.setup();
    const onPreview = vi.fn();
    renderWithProviders(
      <QueryEditor onRun={() => {}} onPreview={onPreview} initialSql="DELETE FROM t" />,
    );

    await user.click(screen.getByRole("button", { name: t("editorPreview") }));
    expect(onPreview).toHaveBeenCalledWith("DELETE FROM t");
  });

  it("Ctrl+F でエディタ内の検索・置換パネルが開く (#464)", async () => {
    renderWithProviders(<QueryEditor onRun={() => {}} initialSql="SELECT id FROM users" />);
    const editable = document.querySelector(".cm-content") as HTMLElement;
    expect(editable).toBeTruthy();
    editable.focus();
    const user = userEvent.setup();
    await user.keyboard("{Control>}f{/Control}");

    await waitFor(() => {
      const panel = document.querySelector(".cm-panel.cm-search");
      expect(panel).toBeTruthy();
      // 検索フィールドに加えて置換フィールドも備える (find & replace)。
      expect(panel!.querySelectorAll("input.cm-textfield").length).toBeGreaterThanOrEqual(2);
    });
  });
});

// ツールバーのオーバーフローメニュー (#915)。主要アクション (Run / Preview /
// Format) は常時表示のまま、副次アクションは「…」へ畳む。折り返しをやめた
// ことでツールバーが 1 段に収まる、という見た目そのものは jsdom では測れない
// ため、ここでは「何が畳まれ / 何が残るか」と「メニューから実行できるか」を
// 固定する (畳んだ結果としてツールバーの要素数が減ることが 1 段化の根拠)。
describe("QueryEditor ツールバーのオーバーフロー (#915)", () => {
  beforeEach(() => {
    setLocale("en");
  });

  it("主要アクションは常時表示のまま、副次アクションは畳まれる", () => {
    renderWithProviders(
      <QueryEditor
        onRun={() => {}}
        onPreview={() => {}}
        onExplain={() => {}}
        onSaveSnippet={() => {}}
        initialSql="SELECT 1"
      />,
    );

    // 主要アクションはツールバー上に残る。
    expect(screen.getByRole("button", { name: t("editorRun") })).toBeTruthy();
    expect(screen.getByRole("button", { name: t("editorPreview") })).toBeTruthy();
    expect(screen.getByRole("button", { name: t("editorFormat") })).toBeTruthy();
    // 副次アクションはメニューを開くまで現れない。
    expect(screen.queryByRole("button", { name: t("editorExplain") })).toBeNull();
    expect(screen.queryByRole("button", { name: t("editorSaveSnippet") })).toBeNull();
    expect(screen.getByRole("button", { name: t("editorMoreActions") })).toBeTruthy();
  });

  it("「…」からメニューを開いて副次アクションを実行できる", async () => {
    const user = userEvent.setup();
    const onExplain = vi.fn();
    renderWithProviders(
      <QueryEditor onRun={() => {}} onExplain={onExplain} initialSql="SELECT 7" />,
    );

    const more = screen.getByRole("button", { name: t("editorMoreActions") });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    await user.click(more);

    const item = await screen.findByRole("menuitem", { name: t("editorExplain") });
    await user.click(item);

    expect(onExplain).toHaveBeenCalledWith("SELECT 7");
    // 実行後はメニューが閉じる (ContextMenu の activate は close → onSelect)。
    await waitFor(() =>
      expect(screen.queryByRole("menuitem", { name: t("editorExplain") })).toBeNull(),
    );
  });

  it("本文が空のときメニュー項目は無効化される (ツールバーの無効判定を引き継ぐ)", async () => {
    const user = userEvent.setup();
    const onExplain = vi.fn();
    renderWithProviders(<QueryEditor onRun={() => {}} onExplain={onExplain} initialSql="" />);

    await user.click(screen.getByRole("button", { name: t("editorMoreActions") }));
    // 無効項目は role=menuitem を持ったまま disabled になる (理由は Tooltip)。
    const item = document.querySelector<HTMLButtonElement>("[role=menuitem][disabled]");
    expect(item?.textContent).toContain(t("editorExplain"));
  });

  it("畳む対象のアクションが 1 つも無ければ「…」自体を出さない", () => {
    renderWithProviders(<QueryEditor onRun={() => {}} initialSql="SELECT 1" />);
    expect(screen.queryByRole("button", { name: t("editorMoreActions") })).toBeNull();
  });

  it("緊急クエリ実行モードのトグルは畳まずツールバーに残す (状態の可視性が安全網)", () => {
    renderWithProviders(
      <QueryEditor
        onRun={() => {}}
        onExplain={() => {}}
        sessionId="s1"
        readOnly
        emergencyMode={false}
        onToggleEmergencyMode={() => {}}
        initialSql="SELECT 1"
      />,
    );
    expect(screen.getByLabelText(t("editorEmergencyMode"))).toBeTruthy();
  });

  // --- #1113: 右クリックメニュー / EXPLAIN ショートカット / パレット用ハンドル ---

  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  it("エディタ本文の右クリックで文脈メニューが開き、「クエリを実行」で onRun が呼ばれる", async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    renderWithProviders(<QueryEditor onRun={onRun} onExplain={() => {}} initialSql="SELECT 9" />);

    const host = document.querySelector(".cm-editor")?.parentElement as HTMLElement;
    fireEvent.contextMenu(host, { clientX: 20, clientY: 20 });

    const run = await screen.findByRole("menuitem", {
      name: new RegExp(`^${escapeRe(t("editorMenuRunAll"))}`),
    });
    // 選択が無いのでコピー/切り取りは無効、カーソル位置の文の実行は出ている。
    expect(screen.getByRole("menuitem", { name: new RegExp(escapeRe(t("editorMenuRunStatement"))) })).toBeTruthy();
    const copy = document.querySelectorAll<HTMLButtonElement>("[role=menuitem][disabled]");
    expect(Array.from(copy).some((el) => el.textContent?.includes(t("editorMenuCopy")))).toBe(true);

    await user.click(run);
    expect(onRun).toHaveBeenCalledWith("SELECT 9");
  });

  it("右クリックメニューの EXPLAIN は選択 / 全文で onExplain を呼ぶ", async () => {
    const user = userEvent.setup();
    const onExplain = vi.fn();
    renderWithProviders(<QueryEditor onRun={() => {}} onExplain={onExplain} initialSql="SELECT 3" />);

    const host = document.querySelector(".cm-editor")?.parentElement as HTMLElement;
    fireEvent.contextMenu(host, { clientX: 10, clientY: 10 });
    await user.click(
      await screen.findByRole("menuitem", { name: new RegExp(`^${escapeRe(t("editorMenuExplain"))}`) }),
    );
    expect(onExplain).toHaveBeenCalledWith("SELECT 3");
  });

  it("Ctrl+E (Mod-E) で EXPLAIN が走る", async () => {
    const onExplain = vi.fn();
    renderWithProviders(<QueryEditor onRun={() => {}} onExplain={onExplain} initialSql="SELECT 5" />);
    const editable = document.querySelector(".cm-content") as HTMLElement;
    editable.focus();
    const user = userEvent.setup();
    await user.keyboard("{Control>}e{/Control}");
    await waitFor(() => expect(onExplain).toHaveBeenCalledWith("SELECT 5"));
  });

  it("パレット用ハンドル (runAll / runStatement / explain) がツールバーと同じ経路で実行する", () => {
    const onRun = vi.fn();
    const onExplain = vi.fn();
    const ref = createRef<QueryEditorHandle>();
    renderWithProviders(
      <QueryEditor ref={ref} onRun={onRun} onExplain={onExplain} initialSql={"SELECT 1;\nSELECT 2"} />,
    );
    ref.current?.runAll();
    expect(onRun).toHaveBeenLastCalledWith("SELECT 1;\nSELECT 2");
    ref.current?.runStatement();
    expect(onRun).toHaveBeenLastCalledWith("SELECT 1");
    ref.current?.explain();
    expect(onExplain).toHaveBeenCalledWith("SELECT 1;\nSELECT 2");
  });
});

describe("QueryEditor: AI にクエリを依頼 (#691)", () => {
  beforeEach(() => {
    setLocale("en");
    resetAiKeyStoreForTest();
  });

  function setAi(enabled: boolean, key: boolean) {
    replaceAllSettings({ ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, enabled, consentGiven: true } });
    setAiKeyPresent(key);
  }

  it("AI 有効・キーあり・接続中ならツールバーにボタンが出る", async () => {
    setAi(true, true);
    renderWithProviders(<QueryEditor onRun={vi.fn()} sessionId="s1" />);
    expect(await screen.findByTestId("query-editor-ai")).toBeTruthy();
  });

  it.each([
    ["AI 無効", { enabled: false, key: true, session: "s1", explain: false }],
    ["キー未登録", { enabled: true, key: false, session: "s1", explain: false }],
    ["未接続", { enabled: true, key: true, session: null, explain: false }],
    ["EXPLAIN タブ", { enabled: true, key: true, session: "s1", explain: true }],
  ])("%s ではボタンを出さない", async (_n, c) => {
    setAi(c.enabled, c.key);
    renderWithProviders(<QueryEditor onRun={vi.fn()} sessionId={c.session} explainMode={c.explain} />);
    await waitFor(() => expect(document.querySelector(".cm-content")).toBeTruthy());
    expect(screen.queryByTestId("query-editor-ai")).toBeNull();
  });
});

describe("QueryEditor.requestAiSql (#695)", () => {
  const setup = (initialSql: string) => {
    const onAiSqlAction = vi.fn();
    const ref = createRef<QueryEditorHandle>();
    renderWithProviders(
      <QueryEditor ref={ref} onRun={vi.fn()} tabId="tab1" initialSql={initialSql} onAiSqlAction={onAiSqlAction} />,
    );
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement);
    if (!view) throw new Error("no view");
    return { ref, view, onAiSqlAction };
  };

  it("選択が無ければ全文を、range なしで渡す", () => {
    const { ref, onAiSqlAction } = setup("SELECT 1;\nSELECT 2");
    ref.current?.requestAiSql("explain");
    expect(onAiSqlAction).toHaveBeenCalledWith({
      kind: "explain",
      sql: "SELECT 1;\nSELECT 2",
      range: null,
      tabId: "tab1",
    });
  });

  it("選択があれば選択範囲とその位置を渡す", () => {
    const { ref, view, onAiSqlAction } = setup("SELECT 1;\nSELECT 2");
    view.dispatch({ selection: { anchor: 10, head: 18 } });
    ref.current?.requestAiSql("rewrite");
    expect(onAiSqlAction).toHaveBeenCalledWith({
      kind: "rewrite",
      sql: "SELECT 2",
      range: { from: 10, to: 18 },
      tabId: "tab1",
    });
  });

  it("空白だけの選択 / 空の本文では何もしない", () => {
    const a = setup("SELECT 1;\n   ");
    a.view.dispatch({ selection: { anchor: 9, head: 13 } });
    a.ref.current?.requestAiSql("explain");
    expect(a.onAiSqlAction).not.toHaveBeenCalled();
    cleanup();
    const b = setup("");
    b.ref.current?.requestAiSql("explain");
    expect(b.onAiSqlAction).not.toHaveBeenCalled();
  });
});


describe("QueryEditor: スキーマツリー行のポインタ・ドラッグ挿入 (#1414)", () => {
  beforeEach(() => {
    setLocale("en");
  });

  function mount(sql: string, driver = "mysql") {
    renderWithProviders(<QueryEditor onRun={vi.fn()} initialSql={sql} driver={driver} />);
    const editorEl = document.querySelector(".cm-editor") as HTMLElement;
    const view = EditorView.findFromDOM(editorEl) as EditorView;
    // jsdom にはレイアウトが無く posAtCoords / elementFromPoint が使えないので固定する。
    view.posAtCoords = () => 3;
    document.elementFromPoint = () => editorEl;
    return { view };
  }

  function drag(item: TreeDragItem, init: PointerEventInit = {}) {
    const source = document.createElement("div");
    document.body.appendChild(source);
    const detach = attachTreeDragSource(source, () => item);
    const ev = (type: string, x: number, extra: PointerEventInit = {}) =>
      new PointerEvent(type, { pointerId: 1, isPrimary: true, button: 0, bubbles: true, clientX: x, clientY: 1, ...extra });
    source.dispatchEvent(ev("pointerdown", 0));
    window.dispatchEvent(ev("pointermove", 40));
    window.dispatchEvent(ev("pointerup", 40, init));
    detach();
    source.remove();
  }

  it("テーブル行を落とすとドロップ位置に SELECT 雛形が 1 回だけ入る", () => {
    const { view } = mount("ab cd");
    drag({ kind: "table", database: "shop", table: "orders" });
    expect(view.state.doc.toString()).toBe("ab SELECT * FROM `shop`.`orders`cd");
  });

  it("列行は表.列、Alt を押していれば列名のみを挿入する", () => {
    const { view } = mount("ab cd", "postgres");
    const column: TreeDragItem = { kind: "column", database: "shop", table: "orders", column: "id" };
    drag(column);
    expect(view.state.doc.toString()).toBe("ab orders.idcd");
    drag(column, { altKey: true });
    expect(view.state.doc.toString().match(/id/g)?.length).toBe(2);
    expect(view.state.doc.toString()).not.toContain("orders.id orders");
  });

  it("ドラッグ中は挿入予定位置にマーカーが出て、終わると消える", () => {
    mount("ab cd");
    const source = document.createElement("div");
    document.body.appendChild(source);
    const detach = attachTreeDragSource(source, () => ({ kind: "table", database: "d", table: "t" }));
    const ev = (type: string, x: number) =>
      new PointerEvent(type, { pointerId: 1, isPrimary: true, button: 0, bubbles: true, clientX: x, clientY: 1 });
    source.dispatchEvent(ev("pointerdown", 0));
    window.dispatchEvent(ev("pointermove", 40));
    expect(document.querySelector(".cm-tree-drop-caret")).not.toBeNull();
    window.dispatchEvent(ev("pointerup", 40));
    expect(document.querySelector(".cm-tree-drop-caret")).toBeNull();
    detach();
    source.remove();
  });
});
