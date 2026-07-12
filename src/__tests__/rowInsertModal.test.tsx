import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, fireEvent } from "./testUtils";
import { RowInsertModal } from "../components/RowInsertModal";
import { SAMPLE_COLUMNS } from "./fixtures/componentFixtures";
import { t } from "../i18n";

/**
 * 行追加モーダル (#604)。マウント時に Tauri 呼び出しを持たない。カラム定義から
 * 入力フォームが例外なくマウントでき、確定ボタンが可視であること・閉じるボタンで
 * `onCancel` が呼ばれることを固定する。
 */
describe("RowInsertModal render smoke (#604)", () => {
  it("mounts as a dialog with an add-row action for the given columns", () => {
    renderWithProviders(
      <RowInsertModal
        table="users"
        columns={SAMPLE_COLUMNS}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(t("rowOpsInsertAdd"))).toBeInTheDocument();
  });

  it("invokes onCancel when the close control is activated", () => {
    const onCancel = vi.fn();
    renderWithProviders(
      <RowInsertModal
        table="users"
        columns={SAMPLE_COLUMNS}
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );
    // ヘッダとフッタの両方に「閉じる」ボタンがあるため、先頭 (ヘッダ) を叩く。
    fireEvent.click(screen.getAllByRole("button", { name: t("createTableClose") })[0]);
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
