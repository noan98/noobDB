import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { makeColumn } from "./fixtures/componentFixtures";
import { t } from "../i18n";
import type { CellValue } from "../api/tauri";

/**
 * ExportModal のデータマスキング (#733)。値の変換はバックエンド (`mask_export_rows`)
 * が担うのでモックし、ここでは「どの列にどのルールを送るか」「プレビューがマスク後の
 * 値を表示し、未着の間に生の値を出さないか」「プリセットの保存」を固定する。
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
    },
  };
});

import { ExportModal } from "../components/ExportModal";
import { api } from "../api/tauri";
import { getSettings, resetAllSettings } from "../settings";

const COLUMNS = [makeColumn("id", "int"), makeColumn("user_email", "varchar"), makeColumn("note", "text")];
const ROWS: CellValue[][] = [
  [1, "taro@example.com", "hello"],
  [2, "hanako@example.com", null],
];

function renderModal() {
  return renderWithProviders(
    <ExportModal columns={COLUMNS} rows={ROWS} database={null} table="users" driver="mysql" onClose={() => {}} />,
  );
}

function enableMasking() {
  fireEvent.click(screen.getByRole("checkbox", { name: t("exportMaskingEnable") }));
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAllSettings();
  vi.mocked(api.maskExportRows).mockImplementation(async ({ rows }) =>
    rows.map((r) => [r[0], "MASKED", r[2]]),
  );
  vi.mocked(api.exportQueryResult).mockResolvedValue(123);
});

describe("ExportModal データマスキング (#733)", () => {
  it("既定では無効で、変換 IPC を呼ばず masks も空で書き出す", async () => {
    renderModal();
    expect(screen.getByLabelText(t("exportPreview")).textContent).toContain("taro@example.com");
    fireEvent.click(screen.getByRole("button", { name: t("exportExecute") }));
    await waitFor(() => expect(api.exportQueryResult).toHaveBeenCalledOnce());
    expect(vi.mocked(api.exportQueryResult).mock.calls[0][0].masks).toEqual([]);
    expect(api.maskExportRows).not.toHaveBeenCalled();
  });

  it("有効にすると列名プリセット (email) に一致する列だけにルールを掛け、プレビューはマスク後の値", async () => {
    renderModal();
    enableMasking();
    await waitFor(() =>
      expect(screen.getByLabelText(t("exportPreview")).textContent).toContain("MASKED"),
    );
    const preview = screen.getByLabelText(t("exportPreview")).textContent ?? "";
    expect(preview).not.toContain("taro@example.com");
    expect(vi.mocked(api.maskExportRows).mock.calls[0][0].masks).toEqual([
      { column: "user_email", rule: { kind: "partial", keepStart: 2, keepEnd: 4 } },
    ]);
    expect(screen.getByTestId("export-masked-count").textContent).toBe(
      t("exportMaskedColumns", { count: 1 }),
    );
  });

  it("変換結果が届くまではプレビューに生の値を出さない", async () => {
    let resolve: (rows: CellValue[][]) => void = () => {};
    vi.mocked(api.maskExportRows).mockImplementation(
      () => new Promise<CellValue[][]>((r) => (resolve = r)),
    );
    renderModal();
    enableMasking();
    const preview = screen.getByLabelText(t("exportPreview"));
    expect(preview.textContent).toBe(t("exportMaskingPending"));
    resolve([[1, "X", "hello"], [2, "X", null]]);
    await waitFor(() => expect(preview.textContent).toContain("user_email"));
    expect(preview.textContent).not.toContain("taro@example.com");
  });

  it("変換が失敗したらプレビューにエラーを出す (生の値へは縮退しない)", async () => {
    vi.mocked(api.maskExportRows).mockRejectedValue(new Error("keyring unavailable"));
    renderModal();
    enableMasking();
    const preview = screen.getByLabelText(t("exportPreview"));
    await waitFor(() => expect(preview.textContent).toContain("keyring unavailable"));
    expect(preview.textContent).not.toContain("taro@example.com");
  });

  it("列ごとにルールを変更でき、書き出しにそのまま渡る", async () => {
    renderModal();
    enableMasking();
    fireEvent.change(screen.getByRole("combobox", { name: t("exportMaskingRuleFor", { column: "note" }) }), {
      target: { value: "null" },
    });
    fireEvent.change(
      screen.getByRole("combobox", { name: t("exportMaskingRuleFor", { column: "user_email" }) }),
      { target: { value: "hash" } },
    );
    fireEvent.change(screen.getByLabelText(t("exportMaskingHashLengthFor", { column: "user_email" })), {
      target: { value: "200" },
    });
    await waitFor(() => expect(screen.getByTestId("export-masked-count").textContent).toBe(
      t("exportMaskedColumns", { count: 2 }),
    ));
    fireEvent.click(screen.getByRole("button", { name: t("exportExecute") }));
    await waitFor(() => expect(api.exportQueryResult).toHaveBeenCalledOnce());
    expect(vi.mocked(api.exportQueryResult).mock.calls[0][0].masks).toEqual([
      // 長さはバックエンドと同じ上限 (64) に正規化されてから送られる。
      { column: "user_email", rule: { kind: "hash", length: 64 } },
      { column: "note", rule: { kind: "null" } },
    ]);
  });

  it("列のルールをプリセットとして保存すると設定に残り、次回から自動で適用される", async () => {
    const { unmount } = renderModal();
    enableMasking();
    fireEvent.change(screen.getByRole("combobox", { name: t("exportMaskingRuleFor", { column: "note" }) }), {
      target: { value: "fixed" },
    });
    const saveButtons = screen.getAllByRole("button", { name: t("exportMaskingSavePreset") });
    // 行の並びは列順 (id, user_email, note)。
    fireEvent.click(saveButtons[2]);
    expect(getSettings().exportMaskPresets[0]).toEqual({
      pattern: "note",
      rule: { kind: "fixed", value: "***" },
    });
    unmount();

    renderModal();
    enableMasking();
    await waitFor(() => expect(api.maskExportRows).toHaveBeenCalled());
    const calls = vi.mocked(api.maskExportRows).mock.calls;
    const last = calls[calls.length - 1][0];
    expect(last.masks.map((m) => m.column)).toEqual(["user_email", "note"]);
  });
});
