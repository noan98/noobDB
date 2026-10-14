import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { ExportStreamHandlers } from "../api/tauri";

/**
 * 複数テーブルの一括書き出し (#1594)。開発ビルド (StrictMode) でも書き出しが走ること、
 * マスク有効時に describe の待機中にキャンセルしたら書き出しを始めないことを固定する。
 */
vi.mock("@tauri-apps/api/path", () => ({
  downloadDir: vi.fn().mockResolvedValue("/dl"),
  join: vi.fn(async (...parts: string[]) => parts.join("/")),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const handlers: { current: ExportStreamHandlers | null } = { current: null };

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      describeTable: vi.fn(),
      exportQueryStream: vi.fn(),
      cancelStream: vi.fn().mockResolvedValue({ cancelled: false, deliveredRows: 0 }),
    },
    listenExportStream: vi.fn(async (_id: string, h: ExportStreamHandlers) => {
      handlers.current = h;
      return () => {};
    }),
  };
});

import { TablesExportModal } from "../components/TablesExportModal";
import { api } from "../api/tauri";

beforeEach(() => {
  vi.clearAllMocks();
  handlers.current = null;
  vi.mocked(api.exportQueryStream).mockImplementation(async () => {
    handlers.current?.onDone?.({ streamId: "x", rows: 1, bytes: 1 } as never);
  });
});

const modal = () => (
  <TablesExportModal sessionId="s1" driver="mysql" database="app" tables={["a"]} onClose={() => {}} />
);

describe("TablesExportModal (#1594)", () => {
  it("StrictMode の再マウント後でも書き出しが実行される", async () => {
    renderWithProviders(<StrictMode>{modal()}</StrictMode>);
    const execute = screen.getByRole("button", { name: t("exportExecute") });
    await waitFor(() => expect(execute).toBeEnabled());
    fireEvent.click(execute);
    await waitFor(() => expect(api.exportQueryStream).toHaveBeenCalledTimes(1));
  });

  it("マスク有効で describe の待機中にキャンセルしたら、書き出しを始めない", async () => {
    let resolveDescribe: (v: never) => void = () => {};
    vi.mocked(api.describeTable).mockImplementation(() => new Promise((res) => (resolveDescribe = res as never)));
    renderWithProviders(modal());
    fireEvent.click(screen.getByRole("checkbox", { name: t("exportMaskingEnable") }));
    const execute = screen.getByRole("button", { name: t("exportExecute") });
    await waitFor(() => expect(execute).toBeEnabled());
    fireEvent.click(execute);
    fireEvent.click(await screen.findByRole("button", { name: t("batchExportCancelRun") }));
    resolveDescribe([] as never);
    await waitFor(() => expect(screen.getByRole("button", { name: t("exportExecute") })).toBeInTheDocument());
    expect(api.exportQueryStream).not.toHaveBeenCalled();
  });
});
