import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { chooseListboxOption, renderWithProviders, screen } from "./testUtils";
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
    chooseListboxOption(
      screen.getByLabelText(t("parameterInputTypeLabelFor", { name: "tbl" })),
      "identifier",
    );
    await user.type(tblInput, "users");
    chooseListboxOption(screen.getByLabelText(t("parameterInputTypeLabelFor", { name: "id" })), "number");
    await user.type(idInput, "42");

    await user.click(screen.getByRole("button", { name: t("parameterInputRun") }));

    expect(onSubmit).toHaveBeenCalledWith({ tbl: "users", id: "42" }, { tbl: "identifier", id: "number" });
  });

  it("数値型に非数値を入れると実行を無効化しエラーを出す", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderWithProviders(
      <ParameterInputModal sql={SQL} driver="mysql" onSubmit={onSubmit} onCancel={() => {}} />,
    );

    chooseListboxOption(screen.getByLabelText(t("parameterInputTypeLabelFor", { name: "id" })), "number");
    await user.type(screen.getByLabelText(t("parameterInputValueLabelFor", { name: "id" })), "abc");

    expect(screen.getByText(t("parameterInputErrNumber"))).toBeInTheDocument();
    const run = screen.getByRole("button", { name: t("parameterInputRun") });
    expect(run).toBeDisabled();
    await user.click(run);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("展開後の SQL プレビューにエスケープ結果を表示する", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ParameterInputModal sql="SELECT {{name}}" driver="mysql" onSubmit={() => {}} onCancel={() => {}} />,
    );
    // シングルクオートを含む値が二重化されてプレビューに反映される。
    await user.type(screen.getByLabelText(t("parameterInputValueLabelFor", { name: "name" })), "O'Brien");
    expect(screen.getByText("SELECT 'O''Brien'")).toBeInTheDocument();
  });

  it("前回の型だけを localStorage から復元し、値は復元しない", () => {
    localStorage.setItem(
      "noobdb.queryparams.v1",
      JSON.stringify({ tbl: { value: "orders", type: "identifier" } }),
    );
    renderWithProviders(
      <ParameterInputModal sql={SQL} driver="mysql" onSubmit={() => {}} onCancel={() => {}} />,
    );
    expect(screen.getByLabelText(t("parameterInputValueLabelFor", { name: "tbl" }))).toHaveValue("");
    expect(screen.getByLabelText(t("parameterInputTypeLabelFor", { name: "tbl" }))).toHaveTextContent(
      t("parameterInputTypeIdentifier"),
    );
  });

  it("実行しても入力値を localStorage に平文で残さない", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ParameterInputModal
        sql="ALTER USER u IDENTIFIED BY {{pw}}"
        driver="mysql"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    await user.type(screen.getByLabelText(t("parameterInputValueLabelFor", { name: "pw" })), "s3cret-value");
    await user.click(screen.getByRole("button", { name: t("parameterInputRun") }));
    expect(localStorage.getItem("noobdb.queryparams.v1") ?? "").not.toContain("s3cret-value");
  });

  it("位置パラメータ (?) を検出し、一括貼り付けで順に割り当てる (#2128)", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderWithProviders(
      <ParameterInputModal
        sql="SELECT * FROM t WHERE id = ? AND status = ? AND note IS NOT DISTINCT FROM ?"
        driver="mysql"
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    const paste = screen.getByLabelText(t("parameterInputPasteLabel"));
    // 個数が合わない間は FieldError を出し、割り当てを無効にする。
    await user.click(paste);
    await user.paste('[1, "active"]');
    expect(
      screen.getByText(t("parameterInputPasteCountMismatch", { actual: 2, expected: 3 })),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("parameterInputPasteApply") })).toBeDisabled();

    await user.clear(paste);
    await user.click(paste);
    await user.paste("1, 'active', NULL");
    await user.click(screen.getByRole("button", { name: t("parameterInputPasteApply") }));
    expect(
      screen.getByText(
        "SELECT * FROM t WHERE id = 1 AND status = 'active' AND note IS NOT DISTINCT FROM NULL",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: t("parameterInputRun") }));
    expect(onSubmit).toHaveBeenCalledWith(
      { "?1": "1", "?2": "active", "?3": "" },
      { "?1": "number", "?2": "text", "?3": "null" },
    );
  });

  it("PostgreSQL の jsonb の ? は検出せず、$n だけ入力欄になる (#2128)", () => {
    renderWithProviders(
      <ParameterInputModal
        sql="SELECT * FROM t WHERE data ? 'k' AND id = $1"
        driver="postgres"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByLabelText(t("parameterInputValueLabelFor", { name: "$1" }))).toBeInTheDocument();
    expect(screen.queryByLabelText(t("parameterInputValueLabelFor", { name: "?1" }))).not.toBeInTheDocument();
  });

  it("ネイティブプレースホルダでは「展開せずにそのまま実行」を出し、押すと onRunRaw を呼ぶ", async () => {
    const user = userEvent.setup();
    const onRunRaw = vi.fn();
    const onSubmit = vi.fn();
    renderWithProviders(
      <ParameterInputModal
        sql="PREPARE p AS SELECT 1; SELECT $1"
        driver="postgres"
        onSubmit={onSubmit}
        onRunRaw={onRunRaw}
        onCancel={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: t("parameterInputRunRaw") }));
    expect(onRunRaw).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("{{name}} だけのときは「展開せずにそのまま実行」を出さない", () => {
    renderWithProviders(
      <ParameterInputModal
        sql={SQL}
        driver="mysql"
        onSubmit={() => {}}
        onRunRaw={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: t("parameterInputRunRaw") })).toBeNull();
  });

  it("{{name}} とネイティブが混在するときも「展開せずにそのまま実行」を出さない ({{x}} が残るため)", () => {
    renderWithProviders(
      <ParameterInputModal
        sql="SELECT * FROM t WHERE a = {{x}} AND b = $1"
        driver="postgres"
        onSubmit={() => {}}
        onRunRaw={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: t("parameterInputRunRaw") })).toBeNull();
  });
});
