import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, fireEvent } from "./testUtils";
import { DumpModal } from "../components/DumpModal";
import { t } from "../i18n";

/**
 * DB ダンプモーダル (#604)。マウント時に Tauri 呼び出しを持たない (`dumpDatabase` は
 * 実行ボタン押下時のみ)。ダイアログとしてマウントでき、タイトルが可視であること・
 * 閉じるボタンで `onClose` が呼ばれることを固定する。
 */
describe("DumpModal render smoke (#604)", () => {
  it("mounts as a dialog and shows the dump title with the database name", () => {
    renderWithProviders(
      <DumpModal
        sessionId="s1"
        database="appdb"
        driver="mysql"
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(t("dumpTitle", { database: "appdb" }))).toBeInTheDocument();
  });

  it("invokes onClose when the close control is activated", () => {
    const onClose = vi.fn();
    renderWithProviders(
      <DumpModal
        sessionId="s1"
        database="appdb"
        driver="mysql"
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: t("dumpClose") }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  // SQLite はライブ接続から直接生成する (外部ツール不要) ので、外部ツール前提の
  // 注記ではなくネイティブ用の注記と、適用できるオプションを表示する。
  it("shows native-dump note and options for sqlite", () => {
    renderWithProviders(
      <DumpModal sessionId="s1" database="main" driver="sqlite" onClose={() => {}} />,
    );
    expect(screen.getByText(t("dumpNoteNative"))).toBeInTheDocument();
    expect(screen.queryByText(t("dumpNote"))).not.toBeInTheDocument();
    expect(screen.getByText(t("dumpOptNoData"))).toBeInTheDocument();
    expect(screen.getByText(t("dumpOptAddDropTable"))).toBeInTheDocument();
    // mysqldump 専用のオプションは出さない。
    expect(screen.queryByText(t("dumpOptSingleTransaction"))).not.toBeInTheDocument();
    expect(screen.queryByText(t("dumpOptEvents"))).not.toBeInTheDocument();
  });
});
