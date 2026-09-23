import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "./testUtils";
import { ProfileBackupExportDialog } from "../components/ProfileBackupExportDialog";
import { ProfileImportDialog } from "../components/ProfileImportDialog";
import { setLocale, t } from "../i18n";

// #710: 暗号化バックアップのダイアログ。書き出しは 2 回入力が一致し最小文字数を
// 満たすまで確定できないこと、読み込みは既存の衝突解決フローにパスフレーズ欄が
// 足されるだけであること、復号エラーがダイアログ内に出ることを確かめる。
describe("ProfileBackupExportDialog (#710)", () => {
  beforeEach(() => setLocale("en"));

  it("パスフレーズが条件を満たすまで確定ボタンは無効", async () => {
    const onConfirm = vi.fn();
    renderWithProviders(
      <ProfileBackupExportDialog profileCount={3} onConfirm={onConfirm} onCancel={() => {}} />,
    );
    const user = userEvent.setup();
    const confirmBtn = await screen.findByRole("button", {
      name: t("profileBackupExportConfirm"),
    });
    expect(confirmBtn).toBeDisabled();

    await user.type(screen.getByLabelText(t("profileBackupPassphrase")), "short");
    expect(screen.getByRole("alert")).toHaveTextContent(
      t("profileBackupPassphraseTooShort", { min: 8 }),
    );
    expect(confirmBtn).toBeDisabled();

    await user.type(screen.getByLabelText(t("profileBackupPassphrase")), "-enough");
    await user.type(screen.getByLabelText(t("profileBackupPassphraseConfirm")), "short-enougX");
    expect(screen.getByRole("alert")).toHaveTextContent(t("profileBackupPassphraseMismatch"));
    expect(confirmBtn).toBeDisabled();

    await user.clear(screen.getByLabelText(t("profileBackupPassphraseConfirm")));
    await user.type(screen.getByLabelText(t("profileBackupPassphraseConfirm")), "short-enough");
    expect(confirmBtn).toBeEnabled();
    await user.click(confirmBtn);
    expect(onConfirm).toHaveBeenCalledWith("short-enough");
  });

  it("強度の目安と取り扱いの注意を表示する", async () => {
    renderWithProviders(
      <ProfileBackupExportDialog profileCount={1} onConfirm={() => {}} onCancel={() => {}} />,
    );
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(t("profileBackupPassphrase")), "abcdefgh");
    expect(screen.getByTestId("profile-backup-strength")).toHaveTextContent(
      t("profileBackupStrength", { level: t("profileBackupStrengthWeak") }),
    );
    expect(screen.getByText(t("profileBackupWarning"))).toBeInTheDocument();
  });
});

describe("ProfileImportDialog 暗号化モード (#710)", () => {
  beforeEach(() => setLocale("en"));

  it("パスフレーズ入力後に戦略とパスフレーズを渡す", async () => {
    const onConfirm = vi.fn();
    renderWithProviders(
      <ProfileImportDialog encrypted onConfirm={onConfirm} onCancel={() => {}} />,
    );
    const user = userEvent.setup();
    const importBtn = await screen.findByRole("button", { name: t("profileImportConfirm") });
    expect(importBtn).toBeDisabled();
    expect(screen.getByText(t("profileBackupImportNote"))).toBeInTheDocument();
    await user.type(screen.getByLabelText(t("profileBackupPassphrase")), "pass phrase");
    await user.click(screen.getByText(t("profileImportOverwrite")));
    await user.click(importBtn);
    expect(onConfirm).toHaveBeenCalledWith("overwrite", "pass phrase");
  });

  it("復号エラーをダイアログ内に表示する", async () => {
    renderWithProviders(
      <ProfileImportDialog
        encrypted
        error="wrong passphrase or modified file"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "wrong passphrase or modified file",
    );
  });

  it("平文インポートではパスフレーズ欄を出さず、そのまま確定できる", async () => {
    const onConfirm = vi.fn();
    renderWithProviders(<ProfileImportDialog onConfirm={onConfirm} onCancel={() => {}} />);
    const user = userEvent.setup();
    expect(screen.queryByLabelText(t("profileBackupPassphrase"))).toBeNull();
    await user.click(await screen.findByRole("button", { name: t("profileImportConfirm") }));
    expect(onConfirm).toHaveBeenCalledWith("rename", "");
  });
});
