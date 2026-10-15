import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { ExportStreamHandlers } from "../api/tauri";

/**
 * 複数テーブルの一括書き出し (#1594)。マスク有効時に describe の待機中にキャンセルしたら書き出しを始めないことを固定する。
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
      revealInFileManager: vi.fn().mockResolvedValue(undefined),
    },
    listenExportStream: vi.fn(async (_id: string, h: ExportStreamHandlers) => {
      handlers.current = h;
      return () => {};
    }),
  };
});

import { TablesExportModal } from "../components/TablesExportModal";
import { api } from "../api/tauri";
import { loadTablesExportPrefs, saveTablesExportPrefs, tablesExportScope } from "../inputMemory";

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
  it("マスク有効で describe の待機中にキャンセルしたら、書き出しを始めない", async () => {
    let resolveDescribe: (v: never) => void = () => {};
    vi.mocked(api.describeTable).mockImplementation(
      () => new Promise((res) => (resolveDescribe = res as never)),
    );
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

describe("TablesExportModal 前回設定と保存先を開く (#1631)", () => {
  it("接続 × DB に保存した形式・保存先・マスク・DDL 同梱で初期化する", async () => {
    localStorage.clear();
    saveTablesExportPrefs(tablesExportScope("p1", "app"), {
      format: "sql",
      dir: "/exports/app",
      maskEnabled: true,
      includeDdl: true,
    });
    renderWithProviders(
      <TablesExportModal
        sessionId="s1"
        driver="mysql"
        database="app"
        tables={["a"]}
        profileId="p1"
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole("radio", { name: t("exportFormatSql") })).toBeChecked();
    expect((screen.getByLabelText(t("batchExportDir")) as HTMLInputElement).value).toBe("/exports/app");
    expect(screen.getByRole("checkbox", { name: t("exportMaskingEnable") })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: t("exportSqlIncludeDdl") })).toBeChecked();
  });

  it("実行すると設定を保存し、完了トーストの「保存先を開く」でファイルマネージャを開く", async () => {
    localStorage.clear();
    renderWithProviders(
      <TablesExportModal
        sessionId="s1"
        driver="mysql"
        database="app"
        tables={["a"]}
        profileId="p1"
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: t("exportFormatJson") }));
    await waitFor(() => expect(screen.getByRole("button", { name: t("exportExecute") })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: t("exportExecute") }));
    fireEvent.click(await screen.findByRole("button", { name: t("batchExportOpenDir"), hidden: true }));
    expect(api.revealInFileManager).toHaveBeenCalledWith("/dl");
    expect(loadTablesExportPrefs(tablesExportScope("p1", "app"))).toMatchObject({
      format: "json",
      dir: "/dl",
    });
  });
});
