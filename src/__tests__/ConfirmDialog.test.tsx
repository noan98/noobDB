import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "./testUtils";
import { useConfirm } from "../components/ConfirmDialog";
import { setLocale, t } from "../i18n";

// #675: is_production 接続でのテーブル DROP/TRUNCATE (ConnectionList のツリー操作
// から呼ばれる `useConfirm` 経由の確認) に追加した「タイプして確認」ゲート。
// 対象名が一致するまで確認ボタンが無効であること、非本番相当 (typedConfirmation
// 未指定) では従来通り 1 クリックで確定できることを検証する。
function Harness({
  typedConfirmation,
  onResult,
}: {
  typedConfirmation?: string;
  onResult: (ok: boolean) => void;
}) {
  const { confirm, dialog } = useConfirm();
  return (
    <>
      <button
        type="button"
        onClick={() =>
          confirm({
            title: "Drop table users?",
            message: "This cannot be undone.",
            confirmLabel: "Drop",
            tone: "danger",
            typedConfirmation,
          }).then(onResult)
        }
      >
        open
      </button>
      {dialog}
    </>
  );
}

describe("useConfirm / ConfirmDialog 型確認ゲート (#675)", () => {
  beforeEach(() => {
    setLocale("en");
  });

  it("typedConfirmation 未指定 (非本番) では従来通り 1 クリックで確定する", async () => {
    const onResult = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<Harness onResult={onResult} />);

    await user.click(screen.getByRole("button", { name: "open" }));
    const dropButton = screen.getByRole("button", { name: "Drop" });
    expect(dropButton).toBeEnabled();

    await user.click(dropButton);
    expect(onResult).toHaveBeenCalledWith(true);
  });

  it("typedConfirmation 指定時は対象名が一致するまでボタンが無効", async () => {
    const onResult = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<Harness typedConfirmation="users" onResult={onResult} />);

    await user.click(screen.getByRole("button", { name: "open" }));
    const dropButton = screen.getByRole("button", { name: "Drop" });
    expect(dropButton).toBeDisabled();

    const input = screen.getByLabelText(t("typeToConfirmLabel", { target: "users" }));
    await user.type(input, "orders");
    expect(dropButton).toBeDisabled();

    await user.clear(input);
    await user.type(input, "users");
    expect(dropButton).toBeEnabled();

    await user.click(dropButton);
    expect(onResult).toHaveBeenCalledWith(true);
  });

  it("キャンセルすると false で解決される", async () => {
    const onResult = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<Harness typedConfirmation="users" onResult={onResult} />);

    await user.click(screen.getByRole("button", { name: "open" }));
    // ヘッダの閉じる (X) ボタンも aria-label が同じ "Cancel" なので、可視テキスト
    // を持つフッタ側を指名する (DangerousQueryDialog.test.tsx と同じ理由)。
    await user.click(screen.getByText("Cancel"));
    expect(onResult).toHaveBeenCalledWith(false);
  });
});
