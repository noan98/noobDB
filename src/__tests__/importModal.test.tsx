import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { SAMPLE_COLUMNS } from "./fixtures/componentFixtures";
import { t } from "../i18n";

/**
 * データインポートモーダル (#604)。マウント時に対象テーブルのカラムを
 * `api.describeTable()` で取得するためモックする (プレビュー取得はファイル選択時のみ)。
 * ダイアログとしてマウントでき、タイトルが可視であること・閉じるボタンで `onClose`
 * が呼ばれることを固定する。
 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      parseCsvPreview: vi.fn().mockResolvedValue({
        headers: ["id", "name"],
        rows: [["1", "alice"]],
        truncated: false,
      }),
      importCsv: vi.fn().mockResolvedValue(undefined),
      describeTable: vi.fn().mockResolvedValue(
        SAMPLE_COLUMNS.map((c) => ({
          name: c.name,
          data_type: c.type_name,
          nullable: true,
          key: "",
          default: null,
          extra: "",
          referenced_table: null,
          referenced_column: null,
        })),
      ),
    },
    listenImportStream: vi.fn().mockResolvedValue(() => {}),
  };
});

import { ImportModal } from "../components/ImportModal";
import { api } from "../api/tauri";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ImportModal render smoke (#604)", () => {
  it("mounts as a dialog and shows the import title with the table name", () => {
    renderWithProviders(
      <ImportModal
        sessionId="s1"
        database="appdb"
        table="users"
        onClose={() => {}}
        onImported={() => {}}
      />,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(t("importTitle", { table: "users" }))).toBeInTheDocument();
  });

  it("invokes onClose when the close control is activated", () => {
    const onClose = vi.fn();
    renderWithProviders(
      <ImportModal
        sessionId="s1"
        database="appdb"
        table="users"
        onClose={onClose}
        onImported={() => {}}
      />,
    );
    // ヘッダとフッタの両方に「閉じる」ボタンがあるため、先頭 (ヘッダ) を叩く。
    fireEvent.click(screen.getAllByRole("button", { name: t("importClose") })[0]);
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("ImportModal conflict mode / UPSERT (#972)", () => {
  it("requires key columns for UPSERT and sends them with the import", async () => {
    renderWithProviders(
      <ImportModal
        sessionId="s1"
        database="appdb"
        table="users"
        initialPath="/tmp/users.csv"
        onClose={() => {}}
        onImported={() => {}}
      />,
    );
    // プレビュー取得 + 自動マッピングの完了を待つ。
    await screen.findByText(t("importMappingTitle"));

    fireEvent.change(screen.getByLabelText(t("importConflictMode")), {
      target: { value: "update" },
    });
    // モックの列に主キーが無いので既定キーは空 → エラーを出し、実行を無効にする。
    expect(await screen.findByText(t("importConflictKeysRequired"))).toBeInTheDocument();
    const execute = screen.getByRole("button", { name: t("importExecute") });
    expect(execute).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox", { name: "id" }));
    expect(screen.queryByText(t("importConflictKeysRequired"))).not.toBeInTheDocument();
    expect(execute).toBeEnabled();

    fireEvent.click(execute);
    await waitFor(() => expect(api.importCsv).toHaveBeenCalledOnce());
    const params = vi.mocked(api.importCsv).mock.calls[0][0];
    expect(params.options.conflictMode).toBe("update");
    expect(params.options.keyColumns).toEqual(["id"]);
  });
});
