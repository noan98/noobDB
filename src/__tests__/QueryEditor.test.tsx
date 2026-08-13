import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "./testUtils";
import { QueryEditor } from "../components/QueryEditor";
import { setLocale, t } from "../i18n";

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
});
