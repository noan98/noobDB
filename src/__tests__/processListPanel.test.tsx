import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";

/**
 * プロセス監視パネル (#604)。マウント時に `api.listProcesses()` を呼び (以降ポーリング)、
 * モックして実 Tauri なしでレンダリングできるようにする。タイトルが可視であること・
 * 閉じるボタンで `onClose` が呼ばれることを固定する。
 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listProcesses: vi.fn().mockResolvedValue([]),
    },
  };
});

import { ProcessListPanel } from "../components/ProcessListPanel";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ProcessListPanel render smoke (#604)", () => {
  it("mounts and shows the process-list title", async () => {
    renderWithProviders(
      <ProcessListPanel sessionId="s1" driver="mysql" readOnly={false} onClose={() => {}} />,
    );
    expect(screen.getByText(t("processTitle"))).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: t("processClose") })).toBeInTheDocument(),
    );
  });

  it("invokes onClose when the close control is activated", async () => {
    const onClose = vi.fn();
    renderWithProviders(
      <ProcessListPanel sessionId="s1" driver="mysql" readOnly onClose={onClose} />,
    );
    fireEvent.click(screen.getByRole("button", { name: t("processClose") }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
