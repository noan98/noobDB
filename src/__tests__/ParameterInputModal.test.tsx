import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "./testUtils";
import { ParameterInputModal } from "../components/ParameterInputModal";
import { setLocale, t } from "../i18n";

// {{variable}} パラメータ入力モーダルの主要インタラクション:
// 変数ごとの入力欄表示・型選択・数値バリデーション・送信値・前回値キャッシュ。

describe("ParameterInputModal", () => {
  beforeEach(() => {
    setLocale("en");
    localStorage.clear();
  });

  const SQL = "SELECT * FROM {{tbl}} WHERE id = {{id}}";

  it("変数ごとに入力欄を表示し、型と値を送信する", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderWithProviders(
      <ParameterInputModal sql={SQL} driver="mysql" onSubmit={onSubmit} onCancel={() => {}} />,
    );

    const tblInput = screen.getByLabelText(t("parameterInputValueLabelFor", { name: "tbl" }));
    const idInput = screen.getByLabelText(t("parameterInputValueLabelFor", { name: "id" }));
    expect(tblInput).toBeInTheDocument();
    expect(idInput).toBeInTheDocument();

    // tbl を識別子型に、id を数値型にして値を入れる。
    await user.selectOptions(
      screen.getByLabelText(t("parameterInputTypeLabelFor", { name: "tbl" })),
      "identifier",
    );
    await user.type(tblInput, "users");
    await user.selectOptions(
      screen.getByLabelText(t("parameterInputTypeLabelFor", { name: "id" })),
      "number",
    );
    await user.type(idInput, "42");

    await user.click(screen.getByRole("button", { name: t("parameterInputRun") }));

    expect(onSubmit).toHaveBeenCalledWith(
      { tbl: "users", id: "42" },
      { tbl: "identifier", id: "number" },
    );
  });

  it("数値型に非数値を入れると実行を無効化しエラーを出す", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderWithProviders(
      <ParameterInputModal sql={SQL} driver="mysql" onSubmit={onSubmit} onCancel={() => {}} />,
    );

    await user.selectOptions(
      screen.getByLabelText(t("parameterInputTypeLabelFor", { name: "id" })),
      "number",
    );
    await user.type(
      screen.getByLabelText(t("parameterInputValueLabelFor", { name: "id" })),
      "abc",
    );

    expect(screen.getByText(t("parameterInputErrNumber"))).toBeInTheDocument();
    const run = screen.getByRole("button", { name: t("parameterInputRun") });
    expect(run).toBeDisabled();
    await user.click(run);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("展開後の SQL プレビューにエスケープ結果を表示する", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ParameterInputModal
        sql="SELECT {{name}}"
        driver="mysql"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    // シングルクオートを含む値が二重化されてプレビューに反映される。
    await user.type(
      screen.getByLabelText(t("parameterInputValueLabelFor", { name: "name" })),
      "O'Brien",
    );
    expect(screen.getByText("SELECT 'O''Brien'")).toBeInTheDocument();
  });

  it("前回入力値を localStorage から復元する", () => {
    localStorage.setItem(
      "noobdb.queryparams.v1",
      JSON.stringify({ tbl: { value: "orders", type: "identifier" } }),
    );
    renderWithProviders(
      <ParameterInputModal sql={SQL} driver="mysql" onSubmit={() => {}} onCancel={() => {}} />,
    );
    expect(
      screen.getByLabelText(t("parameterInputValueLabelFor", { name: "tbl" })),
    ).toHaveValue("orders");
  });
});
