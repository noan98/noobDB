import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "./testUtils";
import { DangerousQueryDialog } from "../components/DangerousQueryDialog";
import type { DangerFinding } from "../dangerousSql";
import { setLocale, t } from "../i18n";

// 危険クエリ確認ダイアログの「安全網」としての退行を検出するテスト。
// 確認フロー (実行 / キャンセルの結線、危険理由の表示、
// 本番接続の警告) が壊れていないことを保証する。
//
// 文言はロケールで変わるため、ハードコードせず i18n の `t()` から期待値を引く。
// これによりキー → ラベルの結線が正しいことを検証しつつ、文言変更に強くなる。
describe("DangerousQueryDialog", () => {
  beforeEach(() => {
    // ロケールを固定して描画される文言を決定的にする (jsdom 既定は en だが明示)。
    setLocale("en");
  });

  const findings: DangerFinding[] = [{ kind: "deleteNoWhere", target: "users" }];

  it("検出した危険理由と対象テーブルを一覧表示する", () => {
    renderWithProviders(
      <DangerousQueryDialog
        findings={findings}
        isProduction={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByText(t("dangerousTitle"))).toBeInTheDocument();
    expect(screen.getByText(t("dangerousKindDeleteNoWhere"))).toBeInTheDocument();
    expect(
      screen.getByText(t("dangerousTargetTable", { target: "users" })),
    ).toBeInTheDocument();
  });

  it("「実行する」を押すと onConfirm が呼ばれ onCancel は呼ばれない", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <DangerousQueryDialog
        findings={findings}
        isProduction={false}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    await user.click(screen.getByRole("button", { name: t("dangerousConfirm") }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("「キャンセル」を押すと onCancel が呼ばれ実行は中止される", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <DangerousQueryDialog
        findings={findings}
        isProduction={false}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    // フッタの「キャンセル」ボタン。ヘッダの閉じる (X) ボタンも aria-label が
    // 同じ "Cancel" なので、可視テキストを持つフッタ側を指名する。
    await user.click(screen.getByText(t("dangerousCancel")));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("本番接続では専用の警告文を表示する", () => {
    const { rerender } = renderWithProviders(
      <DangerousQueryDialog
        findings={findings}
        isProduction={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByText(t("dangerousProductionNote"))).not.toBeInTheDocument();

    rerender(
      <DangerousQueryDialog
        findings={findings}
        isProduction={true}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText(t("dangerousProductionNote"))).toBeInTheDocument();
  });

  it("検出理由がなく書き込み承認のみの場合は専用の説明文を表示する", () => {
    renderWithProviders(
      <DangerousQueryDialog
        findings={[]}
        isProduction={true}
        writeApproval
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByText(t("dangerousWriteApprovalIntro"))).toBeInTheDocument();
  });

  // #675: 本番接続の DROP/TRUNCATE には対象名タイプ入力の強確認ゲートを追加する。
  describe("タイプして確認ゲート (#675)", () => {
    const dropFindings: DangerFinding[] = [{ kind: "drop", target: "users" }];

    it("typedConfirmTarget 未指定 (非本番・DROP/TRUNCATE 以外) では従来通りボタンが有効", () => {
      renderWithProviders(
        <DangerousQueryDialog
          findings={dropFindings}
          isProduction={false}
          onConfirm={() => {}}
          onCancel={() => {}}
        />,
      );
      expect(screen.getByRole("button", { name: t("dangerousConfirm") })).toBeEnabled();
      expect(screen.queryByText(t("typeToConfirmLabel", { target: "users" }))).not.toBeInTheDocument();
    });

    it("typedConfirmTarget 指定時は一致するまで実行ボタンが無効", async () => {
      const onConfirm = vi.fn();
      const user = userEvent.setup();
      renderWithProviders(
        <DangerousQueryDialog
          findings={dropFindings}
          isProduction={true}
          typedConfirmTarget="users"
          onConfirm={onConfirm}
          onCancel={() => {}}
        />,
      );

      const confirmButton = screen.getByRole("button", { name: t("dangerousConfirm") });
      expect(confirmButton).toBeDisabled();

      const input = screen.getByLabelText(t("typeToConfirmLabel", { target: "users" }));
      await user.type(input, "wrong-name");
      expect(confirmButton).toBeDisabled();

      await user.clear(input);
      await user.type(input, "users");
      expect(confirmButton).toBeEnabled();

      await user.click(confirmButton);
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });
  });
});
