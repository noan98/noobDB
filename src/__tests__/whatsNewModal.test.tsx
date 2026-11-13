import { describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";
import { WhatsNewModal } from "../components/WhatsNewModal";

vi.mock("../updater", () => ({ dismissUpdate: vi.fn(), installUpdateAndRestart: vi.fn() }));

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

describe("更新モーダル → 更新内容を見る → Esc (#1864 / #2297)", () => {
  it("Esc で WhatsNewModal だけ閉じ、更新モーダルは残る", async () => {
    const { confirmAndInstallUpdate, UpdatePromptHost } = await import("../components/updatePrompt");
    const resolved = vi.fn();
    renderWithProviders(
      <>
        <button
          type="button"
          onClick={() =>
            void confirmAndInstallUpdate({
              version: "2.0.0",
              currentVersion: "1.0.0",
              body: "- x項目",
            } as never).then(resolved)
          }
        >
          go
        </button>
        <UpdatePromptHost />
      </>,
    );
    fireEvent.click(screen.getByText("go"));
    fireEvent.click(await screen.findByText(t("updateViewWhatsNew")));
    expect(await screen.findByText(t("whatsNewTitle"))).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText(t("whatsNewTitle"))).toBeNull());
    expect(screen.getByText(t("updateAvailableTitle"))).toBeTruthy();
    expect(resolved).not.toHaveBeenCalled();
  });
});
