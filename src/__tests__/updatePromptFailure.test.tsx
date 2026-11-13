import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";

const install = vi.hoisted(() => vi.fn());
vi.mock("../updater", () => ({
  dismissUpdate: vi.fn(),
  installUpdateAndRestart: install,
}));

import type { AvailableUpdate, InstallProgress } from "../updater";

const upd = {
  version: "v2.0.0",
  currentVersion: "1.0.0",
  body: "- 項目A\n- 項目B\n- 項目C\n- 項目D",
} as AvailableUpdate;

// 更新セッションはモジュール内の状態なので、テストごとにモジュールを読み直して持ち越さない。
let dismissUpdate: ReturnType<typeof vi.fn>;

async function setup(rememberSkip = true) {
  vi.resetModules();
  const { confirmAndInstallUpdate, UpdatePromptHost } = await import("../components/updatePrompt");
  dismissUpdate = (await import("../updater")).dismissUpdate as never;
  const resolved = vi.fn();
  renderWithProviders(
    <>
      <button
        type="button"
        onClick={() => void confirmAndInstallUpdate(upd, { rememberSkip }).then(resolved)}
      >
        go
      </button>
      <UpdatePromptHost />
    </>,
  );
  fireEvent.click(screen.getByText("go"));
  return resolved;
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe("更新モーダルの確認画面 (#2297)", () => {
  it("現行版 → 新版のピルとハイライト抜粋 (先頭 3 項目) を出す", async () => {
    install.mockReturnValue(new Promise(() => {}));
    await setup();
    expect((await screen.findByTestId("update-current")).textContent).toBe("v1.0.0");
    expect(screen.getByTestId("update-next").textContent).toBe("v2.0.0");
    expect(screen.getByText("項目A")).toBeTruthy();
    expect(screen.getByText("項目C")).toBeTruthy();
    expect(screen.queryByText("項目D")).toBeNull();
  });
});

describe("承認後の進捗と失敗 (#1534 / #2297)", () => {
  it("確定進捗は % 付きのバーで出て、トーストは使わない", async () => {
    install.mockImplementation(async (_u: unknown, cb: (p: InstallProgress) => void) => {
      cb({ percent: 31, downloadedBytes: 31, totalBytes: 100 });
      await new Promise(() => {});
    });
    await setup();
    fireEvent.click(await screen.findByText(t("updateDownloadAndRestart")));
    const text = await screen.findByTestId("update-progress-text");
    expect(text.textContent).toContain("31%");
    expect(screen.getByText(t("updateInBackground"))).toBeTruthy();
  });

  it("合計不明のあいだは不定表示の文言", async () => {
    install.mockReturnValue(new Promise(() => {}));
    await setup();
    fireEvent.click(await screen.findByText(t("updateDownloadAndRestart")));
    expect((await screen.findByTestId("update-progress-text")).textContent).toBe(
      t("updateDownloadingStarted"),
    );
  });

  it("100% になったら適用中の文言へ切り替わる", async () => {
    install.mockImplementation(async (_u: unknown, cb: (p: InstallProgress) => void) => {
      cb({ percent: 100, downloadedBytes: 100, totalBytes: 100 });
      await new Promise(() => {});
    });
    await setup();
    fireEvent.click(await screen.findByText(t("updateDownloadAndRestart")));
    await waitFor(() =>
      expect(screen.getByTestId("update-progress-text").textContent).toBe(t("updateApplying")),
    );
  });

  it("失敗はモーダル内のエラーと再試行になり、進行中表示は残らない。再試行で再実行する", async () => {
    install.mockRejectedValueOnce(new Error("signature mismatch")).mockReturnValue(new Promise(() => {}));
    await setup();
    fireEvent.click(await screen.findByText(t("updateDownloadAndRestart")));
    const err = await screen.findByTestId("update-error");
    expect(err.textContent).toContain("signature mismatch");
    expect(screen.queryByTestId("update-progress")).toBeNull();
    fireEvent.click(screen.getByText(t("updateRetry")));
    await waitFor(() => expect(install).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId("update-progress")).toBeTruthy();
  });

  it("ダウンロード中に閉じると続行する (呼び出し側の Promise は解決する)", async () => {
    install.mockReturnValue(new Promise(() => {}));
    const resolved = await setup();
    fireEvent.click(await screen.findByText(t("updateDownloadAndRestart")));
    fireEvent.click(await screen.findByText(t("updateInBackground")));
    await waitFor(() => expect(resolved).toHaveBeenCalled());
    expect(dismissUpdate).not.toHaveBeenCalled();
  });
});

describe("起動時の見送り (#1631)", () => {
  it("「このバージョンは見送る」を押したときだけバージョンを覚える", async () => {
    const resolved = await setup();
    fireEvent.click(await screen.findByText(t("updateSkipVersion")));
    await waitFor(() => expect(resolved).toHaveBeenCalled());
    expect(localStorage.getItem("noobdb.skippedUpdateVersion")).toBe("v2.0.0");
    expect(dismissUpdate).toHaveBeenCalled();
  });

  it("Esc / 後で は見送りにしない", async () => {
    const resolved = await setup();
    fireEvent.click(await screen.findByText(t("updateLater")));
    await waitFor(() => expect(resolved).toHaveBeenCalled());
    expect(localStorage.getItem("noobdb.skippedUpdateVersion")).toBeNull();
    expect(dismissUpdate).toHaveBeenCalled();
  });

  it("手動チェック (rememberSkip なし) には見送りボタンが無い", async () => {
    await setup(false);
    await screen.findByText(t("updateDownloadAndRestart"));
    expect(screen.queryByText(t("updateSkipVersion"))).toBeNull();
  });
});
