// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../updater", () => ({
  dismissUpdate: vi.fn(),
  installUpdateAndRestart: vi.fn().mockRejectedValue(new Error("signature mismatch")),
}));

import { confirmAndInstallUpdate } from "../components/updatePrompt";
import type { AvailableUpdate } from "../updater";

describe("confirmAndInstallUpdate の失敗時 (#1534)", () => {
  it("進行中トーストを id で閉じてから、エラートーストを出す", async () => {
    const order: string[] = [];
    const toast = {
      notify: vi.fn(),
      success: vi.fn(),
      error: vi.fn(() => {
        order.push("error");
        return 2;
      }),
      info: vi.fn(() => {
        order.push("info");
        return 7;
      }),
      dismiss: vi.fn(() => order.push("dismiss")),
      update: vi.fn(),
    };
    await confirmAndInstallUpdate({ version: "2.0.0", currentVersion: "1.0.0" } as AvailableUpdate, {
      t: ((k: string) => k) as never,
      toast,
      confirm: vi.fn().mockResolvedValue(true),
    });
    expect(toast.info).toHaveBeenCalledWith("updateDownloadingStarted", 0);
    expect(toast.dismiss).toHaveBeenCalledWith(7);
    expect(order).toEqual(["info", "dismiss", "error"]);
  });
});

describe("起動時の見送り (#1631)", () => {
  beforeEach(() => localStorage.clear());
  const toast = {
    notify: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    dismiss: vi.fn(),
    update: vi.fn(),
  };
  const upd = { version: "2.0.0", currentVersion: "1.0.0" } as AvailableUpdate;

  const run = (choice: "confirm" | "alt" | "cancel", rememberSkip = true) =>
    confirmAndInstallUpdate(upd, {
      t: ((k: string) => k) as never,
      toast: toast as never,
      confirm: vi.fn().mockResolvedValue(false),
      choose: vi.fn().mockResolvedValue(choice),
      rememberSkip,
    });

  it("「このバージョンは見送る」を押したときだけバージョンを覚える", async () => {
    await run("alt");
    expect(localStorage.getItem("noobdb.skippedUpdateVersion")).toBe("2.0.0");
  });

  it("Esc / × / 後で (cancel) は見送りにしない", async () => {
    await run("cancel");
    expect(localStorage.getItem("noobdb.skippedUpdateVersion")).toBeNull();
  });

  it("手動チェック (rememberSkip なし) の「後で」は覚えない", async () => {
    await run("cancel", false);
    expect(localStorage.getItem("noobdb.skippedUpdateVersion")).toBeNull();
  });
});
