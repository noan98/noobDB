import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, fireEvent } from "./testUtils";
import { CreateTableModal } from "../components/CreateTableModal";
import { t } from "../i18n";

/**
 * CREATE TABLE ウィザード (#604)。マウント時に Tauri 呼び出しを持たない。
 * ダイアログとしてマウントでき、タイトルが可視であること・閉じるボタンで
 * `onClose` が呼ばれることを固定する。
 */
describe("CreateTableModal render smoke (#604)", () => {
  it("mounts as a dialog and shows the create-table title", () => {
    renderWithProviders(
      <CreateTableModal
        driver="mysql"
        database="appdb"
        readOnly={false}
        onRun={() => {}}
        onSendToEditor={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(t("createTableTitle"))).toBeInTheDocument();
  });

  it("invokes onClose when the close control is activated", () => {
    const onClose = vi.fn();
    renderWithProviders(
      <CreateTableModal
        driver="postgres"
        database={null}
        readOnly={false}
        onRun={() => {}}
        onSendToEditor={() => {}}
        onClose={onClose}
      />,
    );
    // ヘッダとフッタの両方に「閉じる」ボタンがあるため、先頭 (ヘッダ) を叩く。
    fireEvent.click(screen.getAllByRole("button", { name: t("createTableClose") })[0]);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
