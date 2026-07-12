import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent } from "./testUtils";
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
