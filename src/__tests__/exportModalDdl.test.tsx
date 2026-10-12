import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { makeColumn } from "./fixtures/componentFixtures";
import { t } from "../i18n";
import type { CellValue } from "../api/tauri";

/**
 * ExportModal の「CREATE TABLE 文を先頭に含める」(#1539)。定義はバックエンドが
 * セッションから取る (全件) か、`get_object_definition` で取って `ddlHeader` に載せる (グリッド)。
 */
vi.mock("@tauri-apps/api/path", () => ({
  downloadDir: vi.fn().mockResolvedValue("/home/user/Downloads"),
  join: vi.fn().mockResolvedValue("/home/user/Downloads/export.sql"),
}));

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      exportQueryResult: vi.fn(),
      getObjectDefinition: vi.fn(),
    },
  };
});

import { ExportModal } from "../components/ExportModal";
import { api } from "../api/tauri";
import { resetAllSettings } from "../settings";

const COLUMNS = [makeColumn("id", "int")];
const ROWS: CellValue[][] = [[1]];
const FULL = { sessionId: "s1", sql: "SELECT * FROM users", initialBatch: 100, chunkSize: 500 };

function renderModal(withFull: boolean) {
  return renderWithProviders(
    <ExportModal
      columns={COLUMNS}
      rows={ROWS}
      database="app"
      table="users"
      driver="mysql"
      fullExport={withFull ? FULL : undefined}
      onClose={() => {}}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAllSettings();
  vi.mocked(api.exportQueryResult).mockResolvedValue({ bytes: 1, truncation: null });
  vi.mocked(api.getObjectDefinition).mockResolvedValue("CREATE TABLE `users` (`id` int)");
});

describe("ExportModal CREATE TABLE 文の同梱 (#1539)", () => {
  it("セッションが無い (全件の文脈が無い) ときは選択肢を出さない", () => {
    renderModal(false);
    fireEvent.click(screen.getByRole("radio", { name: t("exportFormatSql") }));
    expect(screen.queryByRole("checkbox", { name: t("exportSqlIncludeDdl") })).toBeNull();
  });

  it("グリッドの書き出しでは定義を取得して ddlHeader に載せる", async () => {
    renderModal(true);
    fireEvent.click(screen.getByRole("radio", { name: t("exportFormatSql") }));
    // 全件を選べる文脈だが、ここではグリッドのみ (scope=current) の経路を検証する。
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(t("exportScopeCurrent")) }));
    fireEvent.click(screen.getByRole("checkbox", { name: t("exportSqlIncludeDdl") }));
    fireEvent.click(screen.getByRole("button", { name: t("exportExecute") }));
    await waitFor(() => expect(api.exportQueryResult).toHaveBeenCalledOnce());
    expect(api.getObjectDefinition).toHaveBeenCalledWith("s1", "app", "table", "users");
    expect(vi.mocked(api.exportQueryResult).mock.calls[0][0].ddlHeader).toBe("CREATE TABLE `users` (`id` int)");
  });

  it("チェックしないときは定義を取得せず ddlHeader も null", async () => {
    renderModal(true);
    fireEvent.click(screen.getByRole("radio", { name: t("exportFormatSql") }));
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(t("exportScopeCurrent")) }));
    fireEvent.click(screen.getByRole("button", { name: t("exportExecute") }));
    await waitFor(() => expect(api.exportQueryResult).toHaveBeenCalledOnce());
    expect(api.getObjectDefinition).not.toHaveBeenCalled();
    expect(vi.mocked(api.exportQueryResult).mock.calls[0][0].ddlHeader).toBeNull();
  });
});
