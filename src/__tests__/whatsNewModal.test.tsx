import { describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen } from "./testUtils";
import { t } from "../i18n";
import { WhatsNewModal } from "../components/WhatsNewModal";

describe("WhatsNewModal (#1864)", () => {
  it("バージョンチップとノートの各ブロックを描く", () => {
    renderWithProviders(
      <WhatsNewModal
        version="v2.0.0"
        currentVersion="1.9.0"
        notes={"## 見出し\n> 要点\n- 項目"}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId("whats-new-version").textContent).toBe("v2.0.0");
    expect(screen.getByText("見出し")).toBeTruthy();
    expect(screen.getByText("要点")).toBeTruthy();
    expect(screen.getByText("項目")).toBeTruthy();
  });

  it("ノートが空なら空状態を出し、閉じるで onClose", () => {
    const onClose = vi.fn();
    renderWithProviders(<WhatsNewModal version="2.0.0" notes="" onClose={onClose} />);
    expect(screen.getByText(t("whatsNewEmpty"))).toBeTruthy();
    fireEvent.click(screen.getAllByText(t("whatsNewClose")).at(-1) as HTMLElement);
    expect(onClose).toHaveBeenCalled();
  });
});
