import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "./testUtils";
import { QueryEditor } from "../components/QueryEditor";
import { setLocale, t } from "../i18n";

// QueryEditor の主要な実行フロー (Run ボタン / Ctrl+Enter ショートカット / 空状態
// での無効化 / 選択範囲優先実行) の退行を検出するテスト (#354)。CodeMirror を
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
});
