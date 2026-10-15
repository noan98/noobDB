import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { PerfStatus } from "../api/tauri";
import { formatPerfBytes, formatPerfMs, slowestSqlExecuteMs, toPerfRows } from "../components/perfPanel";

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getPerfStatus: vi.fn(),
      setPerfEnabled: vi.fn().mockResolvedValue({}),
      clearPerfSamples: vi.fn().mockResolvedValue(undefined),
    },
  };
});

import { PerfPanel } from "../components/PerfPanel";
import { api } from "../api/tauri";
import { getSettings } from "../settings";

const status = (over: Partial<PerfStatus> = {}): PerfStatus => ({
  enabled: true,
  ui_enabled: true,
  env_enabled: false,
  samples: [
    {
      at_ms: 1_767_225_600_000,
      kind: "stream",
      sql_execute_ms: 1500,
      emit_ms: 3.25,
      payload_bytes_approx: 4096,
      rows: 100,
      columns: 4,
    },
    {
      at_ms: 1_767_225_500_000,
      kind: "query",
      sql_execute_ms: 8,
      emit_ms: null,
      payload_bytes_approx: null,
      rows: 1,
      columns: 1,
    },
  ],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("perfPanel 純関数 (#1622)", () => {
  it("ms と バイトを読みやすく整形する", () => {
    expect(formatPerfMs(null)).toBe("–");
    expect(formatPerfMs(12.34)).toBe("12.3 ms");
    expect(formatPerfMs(1500)).toBe("1.50 s");
    expect(formatPerfBytes(null)).toBe("–");
    expect(formatPerfBytes(512)).toBe("512 B");
    expect(formatPerfBytes(4096)).toBe("4.0 KiB");
    expect(formatPerfBytes(3 * 1024 * 1024)).toBe("3.0 MiB");
  });

  it("最も遅い SQL 実行を返し、空なら null", () => {
    expect(slowestSqlExecuteMs([])).toBeNull();
    const rows = toPerfRows(status().samples);
    expect(slowestSqlExecuteMs(rows)).toBe(1500);
  });
});

describe("PerfPanel (#1622)", () => {
  it("直近の計測値を新しい順の行として表示する", async () => {
    vi.mocked(api.getPerfStatus).mockResolvedValue(status());
    renderWithProviders(<PerfPanel />);
    await waitFor(() => expect(screen.getAllByTestId("perf-row")).toHaveLength(2));
    expect(screen.getByTestId("perf-slowest").textContent).toContain("1.50 s");
    expect(screen.getByText("4.0 KiB")).toBeInTheDocument();
  });

  it("計測オフで値が無いときは有効化を案内する", async () => {
    vi.mocked(api.getPerfStatus).mockResolvedValue(
      status({ enabled: false, ui_enabled: false, samples: [] }),
    );
    renderWithProviders(<PerfPanel />);
    expect(await screen.findByText(t("perfEmptyOff"))).toBeInTheDocument();
  });

  it("環境変数で有効なときは止められない旨を出す", async () => {
    vi.mocked(api.getPerfStatus).mockResolvedValue(status({ env_enabled: true }));
    renderWithProviders(<PerfPanel />);
    expect(await screen.findByTestId("perf-env-enabled")).toBeInTheDocument();
  });

  it("クリアで IPC を呼んで再取得する", async () => {
    vi.mocked(api.getPerfStatus).mockResolvedValue(status());
    renderWithProviders(<PerfPanel />);
    await screen.findAllByTestId("perf-row");
    fireEvent.click(screen.getByRole("button", { name: t("perfClear") }));
    await waitFor(() => expect(api.clearPerfSamples).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(vi.mocked(api.getPerfStatus).mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("スイッチで設定 perfMeasureEnabled が切り替わる", async () => {
    vi.mocked(api.getPerfStatus).mockResolvedValue(status({ samples: [] }));
    renderWithProviders(<PerfPanel />);
    const sw = await screen.findByRole("switch");
    expect(getSettings().perfMeasureEnabled).toBe(false);
    fireEvent.click(sw);
    expect(getSettings().perfMeasureEnabled).toBe(true);
  });
});
