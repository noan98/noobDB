import { describe, expect, it, vi } from "vitest";
import { HistorySearchModal } from "../components/HistorySearchModal";
import { t } from "../i18n";
import { fireEvent, renderWithProviders, screen } from "./testUtils";

const HISTORY = ["SELECT * FROM users", "SELECT id FROM orders", "DELETE FROM users"];

describe("HistorySearchModal (#1627)", () => {
  it("入力に合わせて部分一致で絞り込み、クリックで選んで閉じる", () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    renderWithProviders(<HistorySearchModal history={HISTORY} onPick={onPick} onClose={onClose} />);
    expect(screen.getAllByRole("option")).toHaveLength(3);
    fireEvent.change(screen.getByLabelText(t("queryHistorySearchPlaceholder")), {
      target: { value: "USERS" },
    });
    expect(screen.getAllByRole("option")).toHaveLength(2);
    fireEvent.click(screen.getByRole("option", { name: "DELETE FROM users" }));
    expect(onPick).toHaveBeenCalledWith("DELETE FROM users");
    expect(onClose).toHaveBeenCalled();
  });

  it("↓ で選択を動かし Enter で確定する", () => {
    const onPick = vi.fn();
    renderWithProviders(<HistorySearchModal history={HISTORY} onPick={onPick} onClose={vi.fn()} />);
    const input = screen.getByLabelText(t("queryHistorySearchPlaceholder"));
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("SELECT id FROM orders");
  });

  it("履歴が空・一致なしのときは空状態を出す", () => {
    const { unmount } = renderWithProviders(
      <HistorySearchModal history={[]} onPick={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByText(t("queryHistorySearchEmpty"))).toBeInTheDocument();
    unmount();
    renderWithProviders(<HistorySearchModal history={HISTORY} onPick={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(t("queryHistorySearchPlaceholder")), { target: { value: "zzz" } });
    expect(screen.getByText(t("queryHistorySearchNoMatch"))).toBeInTheDocument();
  });
});
