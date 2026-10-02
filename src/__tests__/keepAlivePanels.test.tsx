import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor, act } from "./testUtils";
import { t } from "../i18n";
import type { QueryStatsSupport } from "../api/tauri";

/**
 * ボトムパネルのタブ切替で中身を破棄しない (#1311)。
 *
 * - クエリインスペクタの記録中にほかのタブへ移っても、記録 (state とポーリング) が続く。
 * - プロセス監視のように「見ていない間は止めてよい」ポーリングは、非表示の間 interval を止める。
 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      queryStatsSupport: vi.fn().mockResolvedValue({
        live_tail: true,
        statements: false,
        live_tail_reason: null,
        statements_reason: null,
      } satisfies QueryStatsSupport),
      sampleLiveQueries: vi.fn().mockResolvedValue([]),
      listProcesses: vi.fn().mockResolvedValue([]),
    },
  };
});

import { BottomPanel } from "../components/BottomPanel";
import type { BottomPanelTab } from "../components/bottomPanelTabs";
import { QueryInspectorPanel } from "../components/QueryInspectorPanel";
import { ProcessListPanel } from "../components/ProcessListPanel";
import { api } from "../api/tauri";

const TABS: BottomPanelTab[] = ["inspector", "processes"];

function Shell({ tab }: { tab: BottomPanelTab }) {
  return (
    <BottomPanel
      tab={tab}
      tabs={TABS}
      label={(k) => k}
      onSelect={() => {}}
      onClose={() => {}}
    >
      {tab === "inspector" ? (
        <QueryInspectorPanel sessionId="s1" driver="mysql" />
      ) : (
        <ProcessListPanel sessionId="s1" driver="mysql" readOnly={false} />
      )}
    </BottomPanel>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("ボトムパネルの keep-alive (#1311)", () => {
  it("インスペクタの記録中にほかのタブへ移っても記録が続く", async () => {
    const view = renderWithProviders(<Shell tab="inspector" />);
    const start = await screen.findByRole("button", { name: t("inspectorStart") });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(start);
    await waitFor(() => expect(screen.getByText(t("inspectorRecordingBadge"))).toBeInTheDocument());
    const baseline = vi.mocked(api.sampleLiveQueries).mock.calls.length;
    expect(baseline).toBeGreaterThan(0);

    view.rerender(<Shell tab="processes" />);
    // インスペクタは非表示で残り (hidden)、記録バッジも state も消えない。
    const badge = screen.getByText(t("inspectorRecordingBadge"));
    expect(badge.closest("[hidden]")).not.toBeNull();

    // 非表示の間もポーリングが続く (記録が止まらない)。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(vi.mocked(api.sampleLiveQueries).mock.calls.length).toBeGreaterThan(baseline);

    // 戻っても記録中のまま (再マウントされていないので「開始」に戻らない)。
    view.rerender(<Shell tab="inspector" />);
    const back = screen.getByText(t("inspectorRecordingBadge"));
    expect(back.closest("[hidden]")).toBeNull();
    expect(screen.queryByRole("button", { name: t("inspectorStart") })).toBeNull();
  });

  it("プロセス監視は非表示の間 interval を止め、戻ると 1 度取り直す", async () => {
    const view = renderWithProviders(<Shell tab="processes" />);
    await waitFor(() => expect(api.listProcesses).toHaveBeenCalled());
    vi.useFakeTimers({ shouldAdvanceTime: true });

    view.rerender(<Shell tab="inspector" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    const hidden = vi.mocked(api.listProcesses).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(vi.mocked(api.listProcesses).mock.calls.length).toBe(hidden);

    view.rerender(<Shell tab="processes" />);
    await waitFor(() =>
      expect(vi.mocked(api.listProcesses).mock.calls.length).toBeGreaterThan(hidden),
    );
  });
});
