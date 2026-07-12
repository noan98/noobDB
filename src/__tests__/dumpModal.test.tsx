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
});
