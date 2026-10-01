import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { makeColumn } from "./fixtures/componentFixtures";
import { t } from "../i18n";
import type { CellValue } from "../api/tauri";

/**
 * ExportModal の結果ハンドル対応 (#1264)。「現在のグリッド」スコープで結果ハンドルがある
 * ときは行を送らず `resultId` を渡し、ハンドルが破棄済みなら行付きで再試行する。
 */
vi.mock("@tauri-apps/api/path", () => ({
  downloadDir: vi.fn().mockResolvedValue("/home/user/Downloads"),
  join: vi.fn().mockResolvedValue("/home/user/Downloads/export.csv"),
}));

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      maskExportRows: vi.fn(),
      exportQueryResult: vi.fn(),
      renderExportText: vi.fn(),
      writeBinaryFile: vi.fn(),
    },
  };
});

import { ExportModal } from "../components/ExportModal";
import { api, BackendError } from "../api/tauri";
import { resetAllSettings } from "../settings";

const COLUMNS = [makeColumn("id", "int"), makeColumn("name", "varchar")];
const ROWS: CellValue[][] = [
  [1, "a"],
  [2, "b"],
];

const writeText = vi.fn().mockResolvedValue(undefined);

function renderModal(resultId: string | null) {
  return renderWithProviders(
    <ExportModal
      columns={COLUMNS}
      rows={ROWS}
      database={null}
      table="users"
      driver="mysql"
      resultId={resultId}
      onClose={() => {}}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAllSettings();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  vi.mocked(api.exportQueryResult).mockResolvedValue({ bytes: 10, truncation: null });
  vi.mocked(api.renderExportText).mockResolvedValue("RENDERED");
  vi.mocked(api.maskExportRows).mockImplementation(async ({ rows }) => rows);
});

describe("ExportModal 結果ハンドル (#1264)", () => {
  it("ハンドルがあれば行を送らず resultId でファイル出力する", async () => {
    renderModal("qs_1");
    fireEvent.click(screen.getByRole("button", { name: t("exportExecute") }));
    await waitFor(() => expect(api.exportQueryResult).toHaveBeenCalledOnce());
    const params = vi.mocked(api.exportQueryResult).mock.calls[0][0];
    expect(params.resultId).toBe("qs_1");
    expect(params.rows).toEqual([]);
  });

  it("ハンドルが無ければ従来どおり行を送る", async () => {
    renderModal(null);
    fireEvent.click(screen.getByRole("button", { name: t("exportExecute") }));
    await waitFor(() => expect(api.exportQueryResult).toHaveBeenCalledOnce());
    const params = vi.mocked(api.exportQueryResult).mock.calls[0][0];
    expect(params.resultId).toBeNull();
    expect(params.rows).toEqual(ROWS);
  });

  it("ハンドルが破棄済み (result handle gone) なら行付きで再試行する", async () => {
    vi.mocked(api.exportQueryResult)
      .mockRejectedValueOnce(new BackendError("invalidInput", "invalid input: result handle gone: qs_1"))
      .mockResolvedValueOnce({ bytes: 10, truncation: null });
    renderModal("qs_1");
    fireEvent.click(screen.getByRole("button", { name: t("exportExecute") }));
    await waitFor(() => expect(api.exportQueryResult).toHaveBeenCalledTimes(2));
    const retry = vi.mocked(api.exportQueryResult).mock.calls[1][0];
    expect(retry.resultId).toBeNull();
    expect(retry.rows).toEqual(ROWS);
  });

  it("ハンドル以外のエラーは再試行しない", async () => {
    vi.mocked(api.exportQueryResult).mockRejectedValue(new BackendError("io", "disk full"));
    renderModal("qs_1");
    fireEvent.click(screen.getByRole("button", { name: t("exportExecute") }));
    await waitFor(() => expect(api.exportQueryResult).toHaveBeenCalledOnce());
  });

  it("全文コピーはハンドルがあればバックエンドで書式化し、行を送らない", async () => {
    renderModal("qs_1");
    fireEvent.click(screen.getByRole("button", { name: t("exportCopyAll") }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("RENDERED"));
    const req = vi.mocked(api.renderExportText).mock.calls[0][0];
    expect(req.resultId).toBe("qs_1");
    expect(req.rows).toEqual([]);
    expect(api.maskExportRows).not.toHaveBeenCalled();
  });

  it("全文コピーはハンドルもマスクも無ければ従来どおりフロントで組み立てる", async () => {
    renderModal(null);
    fireEvent.click(screen.getByRole("button", { name: t("exportCopyAll") }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(api.renderExportText).not.toHaveBeenCalled();
    expect(writeText.mock.calls[0][0]).toContain("id,name");
  });
});
