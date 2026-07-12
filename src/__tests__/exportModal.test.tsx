import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, fireEvent } from "./testUtils";
import { SAMPLE_COLUMNS, SAMPLE_ROWS } from "./fixtures/componentFixtures";
import { t } from "../i18n";

/**
 * 結果エクスポートモーダル (#604)。マウント effect が `@tauri-apps/api/path` の
 * `downloadDir` / `join` で既定パスを埋めるためモックする (書き出しは Export 押下時のみ)。
 * ダイアログとしてマウントでき、タイトルが可視であること・閉じるボタンで `onClose`
 * が呼ばれることを固定する。
 */
vi.mock("@tauri-apps/api/path", () => ({
  downloadDir: vi.fn().mockResolvedValue("/home/user/Downloads"),
  join: vi.fn().mockResolvedValue("/home/user/Downloads/export.csv"),
}));

import { ExportModal } from "../components/ExportModal";

describe("ExportModal render smoke (#604)", () => {
  it("mounts as a dialog and shows the export title", () => {
    renderWithProviders(
      <ExportModal
        columns={SAMPLE_COLUMNS}
        rows={SAMPLE_ROWS}
        database="appdb"
        table="users"
        driver="mysql"
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(t("exportTitle"))).toBeInTheDocument();
  });

  it("invokes onClose from the header close control", () => {
    const onClose = vi.fn();
    renderWithProviders(
      <ExportModal
        columns={SAMPLE_COLUMNS}
        rows={SAMPLE_ROWS}
        database={null}
        table={null}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: t("exportClose") }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
