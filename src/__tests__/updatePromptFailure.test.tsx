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

  it("rememberSkip で「見送る」を選ぶとそのバージョンを覚える", async () => {
    await confirmAndInstallUpdate(upd, {
      t: ((k: string) => k) as never,
      toast: toast as never,
      confirm: vi.fn().mockResolvedValue(false),
      rememberSkip: true,
    });
    expect(localStorage.getItem("noobdb.skippedUpdateVersion")).toBe("2.0.0");
  });

  it("手動チェック (rememberSkip なし) の「後で」は覚えない", async () => {
    await confirmAndInstallUpdate(upd, {
      t: ((k: string) => k) as never,
      toast: toast as never,
      confirm: vi.fn().mockResolvedValue(false),
    });
    expect(localStorage.getItem("noobdb.skippedUpdateVersion")).toBeNull();
  });
});
