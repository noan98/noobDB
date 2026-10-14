import { describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { CellValueViewer } from "../components/CellValueViewer";
import { t } from "../i18n";

/** 編集中の未保存内容を確認なしで閉じない (#1615)。 */
function open(onClose: () => void) {
  renderWithProviders(
    <CellValueViewer columnName="memo" value="hello" editable onSave={() => {}} onClose={onClose} />,
  );
  fireEvent.click(screen.getByRole("button", { name: t("cellViewerEdit") }));
}

describe("CellValueViewer 未保存の編集 (#1615)", () => {
  it("変更が無ければキャンセルで確認なしに閉じる", () => {
    const onClose = vi.fn();
    open(onClose);
    fireEvent.click(screen.getByRole("button", { name: t("cellViewerCancel") }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("変更があるとキャンセルで確認が出て、破棄を選ぶまで閉じない", async () => {
    const onClose = vi.fn();
    open(onClose);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "changed" } });
    fireEvent.click(screen.getByRole("button", { name: t("cellViewerCancel") }));
    expect(onClose).not.toHaveBeenCalled();
    expect(await screen.findByText(t("cellViewerDiscardBody"))).toBeInTheDocument();
    fireEvent.click(await screen.findByText(t("cellViewerDiscardConfirm"), { selector: "button" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("確認で閉じない側を選ぶと編集が残る", async () => {
    const onClose = vi.fn();
    open(onClose);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "changed" } });
    fireEvent.click(screen.getByRole("button", { name: t("cellViewerCancel") }));
    await screen.findByText(t("cellViewerDiscardBody"));
    await screen.findAllByText(t("confirmDefaultCancel"), { selector: "button" });
    const cancels = screen.getAllByText(t("confirmDefaultCancel"), { selector: "button" });
    fireEvent.click(cancels[cancels.length - 1]);
    await waitFor(() => expect(screen.queryByText(t("cellViewerDiscardBody"))).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("changed");
  });
});
