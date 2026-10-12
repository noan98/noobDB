import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { ProcessInfo } from "../api/tauri";

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listProcesses: vi.fn().mockResolvedValue([]),
      killProcesses: vi.fn(),
      getProcessQuery: vi.fn(),
    },
  };
});

// AI 診断は「停止候補 → 一覧で表示」の入口だけを模す (中身は aiLockDiagnose.test.tsx)。
vi.mock("../components/AiLockDiagnose", () => ({
  AiLockDiagnose: ({ onLocateProcess }: { onLocateProcess?: (id: number) => void }) => (
    <>
      <button type="button" onClick={() => onLocateProcess?.(3)}>
        locate-3
      </button>
      <button type="button" onClick={() => onLocateProcess?.(99)}>
        locate-99
      </button>
    </>
  ),
}));

import { ProcessListPanel } from "../components/ProcessListPanel";
import { api } from "../api/tauri";

const base: ProcessInfo = {
  id: 1,
  user: "app",
  host: "localhost",
  database: "db",
  command: "Query",
  state: null,
  time_secs: 10,
  query_summary: "SELECT 1",
  query_truncated: false,
  is_self: false,
  blocked_by: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

describe("ProcessListPanel AI 停止候補との連動 (#1538)", () => {
  it("該当行を強調・選択・スクロールし、停止は既存の確認つきボタンで行う", async () => {
    vi.mocked(api.listProcesses).mockResolvedValue([
      { ...base, id: 1 },
      { ...base, id: 2, user: "batch" },
      { ...base, id: 3 },
    ]);
    vi.mocked(api.killProcesses).mockResolvedValue({ killed: 1, failed: 0, first_error: null });
    const { container } = renderWithProviders(
      <ProcessListPanel sessionId="s1" driver="postgres" readOnly={false} />,
    );
    await screen.findByText("locate-3");
    // 絞り込みで候補を隠しても、連動で解除されて見えるようになる。
    fireEvent.change(screen.getByLabelText(t("processFilterUserAria")), { target: { value: "batch" } });
    await waitFor(() => expect(container.querySelector("#process-row-s1-3")).toBeNull());

    fireEvent.click(screen.getByText("locate-3"));
    await waitFor(() =>
      expect(container.querySelector("#process-row-s1-3")?.getAttribute("data-highlighted")).toBe("true"),
    );
    expect(container.querySelector("#process-row-s1-1")?.getAttribute("data-highlighted")).toBeNull();
    expect(window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
    // AI 経由では何も実行されない。
    expect(api.killProcesses).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: t("processKillSelected", { count: 1 }) }));
    fireEvent.click(await screen.findByRole("button", { name: t("processKillConfirmOk") }));
    await waitFor(() => expect(api.killProcesses).toHaveBeenCalledWith("s1", [3], false));
  });

  it("一覧に無い id は強調せず通知だけ出す", async () => {
    vi.mocked(api.listProcesses).mockResolvedValue([base]);
    const { container } = renderWithProviders(
      <ProcessListPanel sessionId="s1" driver="postgres" readOnly={false} />,
    );
    fireEvent.click(await screen.findByText("locate-99"));
    expect(await screen.findByText(t("processLocateGone", { id: 99 }))).toBeInTheDocument();
    expect(container.querySelector("[data-highlighted]")).toBeNull();
  });
});
