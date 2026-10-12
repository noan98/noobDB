import { describe, expect, it, vi } from "vitest";

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
