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

describe("確認ダイアログ → 更新内容を見る → Esc (#1864)", () => {
  it("Esc で Modal だけ閉じ、確認は未解決のまま残る", async () => {
    const { confirmAndInstallUpdate } = await import("../components/updatePrompt");
    const { useConfirm } = await import("../components/ConfirmDialog");
    const resolved = vi.fn();
    function Host() {
      const { confirm, dialog } = useConfirm();
      return (
        <>
          <button
            type="button"
            onClick={() =>
              void confirmAndInstallUpdate(
                { version: "2.0.0", currentVersion: "1.0.0", body: "- x項目" } as never,
                {
                  t: ((k: string) => t(k as never)) as never,
                  toast: { info: vi.fn(), error: vi.fn(), dismiss: vi.fn(), update: vi.fn() } as never,
                  confirm: (o) => confirm(o).then((v) => (resolved(v), v)),
                },
              )
            }
          >
            go
          </button>
          {dialog}
        </>
      );
    }
    renderWithProviders(<Host />);
    fireEvent.click(screen.getByText("go"));
    fireEvent.click(await screen.findByText(t("updateViewWhatsNew")));
    expect(await screen.findByText("x項目")).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText("x項目")).toBeNull());
    expect(screen.getByText(t("updateAvailableTitle"))).toBeTruthy();
    expect(resolved).not.toHaveBeenCalled();
  });
});
