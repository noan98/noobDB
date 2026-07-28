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

/**
 * 行の複製 (#820)。既存行の値を種にモーダルを開くとき、`initialValues` の
 * 各列インデックスの値が対応する入力欄へそのまま反映され、未指定 (通常の
 * 「行を追加」) では従来どおり空欄で開くことを固定する。
 */
describe("RowInsertModal initialValues (#820)", () => {
  it("prefills inputs from initialValues and keeps them editable before confirming", () => {
    const onConfirm = vi.fn();
    renderWithProviders(
      <RowInsertModal
        table="users"
        columns={SAMPLE_COLUMNS}
        initialValues={{ 0: "42", 1: "alice" }}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    const inputs = screen.getAllByRole("textbox");
    expect((inputs[0] as HTMLInputElement).value).toBe("42");
    expect((inputs[1] as HTMLInputElement).value).toBe("alice");

    fireEvent.click(screen.getByRole("button", { name: t("rowOpsInsertAdd") }));
    expect(onConfirm).toHaveBeenCalledWith({ 0: "42", 1: "alice" });
  });

  it("opens with empty inputs when initialValues is omitted", () => {
    renderWithProviders(
      <RowInsertModal
        table="users"
        columns={SAMPLE_COLUMNS}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    for (const input of screen.getAllByRole("textbox")) {
      expect((input as HTMLInputElement).value).toBe("");
    }
  });
});
