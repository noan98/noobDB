import { beforeEach, describe, expect, it, vi } from "vitest";
import { HistorySearchModal } from "../components/HistorySearchModal";
import { t } from "../i18n";
import { fireEvent, renderWithProviders, screen } from "./testUtils";

// jsdom には scrollIntoView が無い (アクティブ行の追従で呼ばれる)。
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

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

  it("アクティブ行 (aria-selected) の中にだけハイライトがあり、↓ で次の行へ移る (#1502)", () => {
    renderWithProviders(<HistorySearchModal history={HISTORY} onPick={vi.fn()} onClose={vi.fn()} />);
    const expectHighlightIn = (index: number) => {
      const options = screen.getAllByRole("option");
      expect(screen.getAllByTestId("active-row-highlight")).toHaveLength(1);
      expect(options[index]?.getAttribute("aria-selected")).toBe("true");
      expect(options[index]?.querySelector('[data-testid="active-row-highlight"]')).not.toBeNull();
    };
    expectHighlightIn(0);
    fireEvent.keyDown(screen.getByLabelText(t("queryHistorySearchPlaceholder")), { key: "ArrowDown" });
    expectHighlightIn(1);
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
