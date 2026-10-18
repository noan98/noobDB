import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, act } from "./testUtils";
import { useToast } from "../components/Toast";
import { t } from "../i18n";

function Burst() {
  const toast = useToast();
  return (
    <button
      type="button"
      onClick={() => {
        for (let i = 1; i <= 7; i++) toast.info(`msg ${i}`, 0);
      }}
    >
      burst
    </button>
  );
}

describe("トーストのスタック上限 (#1501)", () => {
  it("上限を超えた分は「他 N 件」に畳み、新しい 4 件だけ表示する", () => {
    renderWithProviders(<Burst />);
    act(() => screen.getByRole("button", { name: "burst" }).click());
    expect(screen.getByText("msg 7")).toBeInTheDocument();
    expect(screen.getByText("msg 4")).toBeInTheDocument();
    expect(screen.queryByText("msg 3")).not.toBeInTheDocument();
    expect(screen.getByText(t("toastOverflow", { count: 3 }))).toBeInTheDocument();
  });
  it("表示中のトーストを閉じると畳んでいた分が繰り上がり、件数が減る", () => {
    renderWithProviders(<Burst />);
    act(() => screen.getByRole("button", { name: "burst" }).click());
    act(() => screen.getAllByRole("button", { name: t("toastDismissAria") })[0].click());
    expect(screen.getByText("msg 3")).toBeInTheDocument();
    expect(screen.getByText(t("toastOverflow", { count: 2 }))).toBeInTheDocument();
  });
  it("「他 N 件」はボタンで、押すとアクティビティセンターを開く要求を出す", async () => {
    const { onActivityCenterToggleRequest } = await import("../activityLog");
    const spy = vi.fn();
    const off = onActivityCenterToggleRequest(spy);
    renderWithProviders(<Burst />);
    act(() => screen.getByRole("button", { name: "burst" }).click());
    const deck = screen.getByText(t("toastOverflow", { count: 3 }));
    expect(deck.tagName).toBe("BUTTON");
    act(() => deck.click());
    expect(spy).toHaveBeenCalled();
    off();
  });
});
