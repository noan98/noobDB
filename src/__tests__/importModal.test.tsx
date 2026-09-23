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
      previewCreateTableDdl: vi
        .fn()
        .mockImplementation(async (_driver: string, table: string) => `CREATE TABLE "${table}" (...)`),
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
        driver="postgres"
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
        driver="postgres"
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
        driver="postgres"
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

describe("ImportModal create a new table (#985)", () => {
  it("infers columns, previews the DDL and sends createTable with the import", async () => {
    const onImported = vi.fn();
    renderWithProviders(
      <ImportModal
        sessionId="s1"
        database="appdb"
        table={null}
        driver="postgres"
        initialPath="/tmp/new users.csv"
        onClose={() => {}}
        onImported={onImported}
      />,
    );
    expect(screen.getByText(t("importNewTableTitle"))).toBeInTheDocument();
    // 既存テーブルが無いので describeTable は呼ばない。
    expect(api.describeTable).not.toHaveBeenCalled();
    await screen.findByText(t("importNewTableColumns"));
    expect(screen.getByLabelText(t("importNewTableName"))).toHaveValue("new_users");

    // 推論された型 (id → 整数, name → 文字列) と、バックエンド生成の DDL プレビュー。
    const idType = screen.getByLabelText(t("importNewTableColumnType", { name: "id" }));
    expect(idType).toHaveValue("integer");
    expect(screen.getByLabelText(t("importNewTableColumnType", { name: "name" }))).toHaveValue(
      "text",
    );
    expect(await screen.findByTestId("import-new-table-ddl")).toHaveTextContent(
      'CREATE TABLE "new_users"',
    );

    // 型を上書きして実行する。
    fireEvent.change(idType, { target: { value: "bigint" } });
    const execute = screen.getByRole("button", { name: t("importExecute") });
    fireEvent.click(execute);
    await waitFor(() => expect(api.importCsv).toHaveBeenCalledOnce());
    const params = vi.mocked(api.importCsv).mock.calls[0][0];
    expect(params.table).toBe("new_users");
    expect(params.createTable).toEqual([
      { name: "id", type: "bigint" },
      { name: "name", type: "text" },
    ]);
    expect(params.mapping).toEqual([
      { column: "id", csvIndex: 0 },
      { column: "name", csvIndex: 1 },
    ]);
    expect(params.options.conflictMode).toBe("insert");
  });

  it("blocks the import on a duplicate column name", async () => {
    renderWithProviders(
      <ImportModal
        sessionId="s1"
        database="appdb"
        table={null}
        driver="mysql"
        initialPath="/tmp/users.csv"
        onClose={() => {}}
        onImported={() => {}}
      />,
    );
    await screen.findByText(t("importNewTableColumns"));
    fireEvent.change(screen.getByLabelText(t("importNewTableColumnName", { n: 2 })), {
      target: { value: "ID" },
    });
    expect(
      await screen.findByText(t("importNewTableDuplicateColumn", { name: "ID" })),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("importExecute") })).toBeDisabled();
    // MySQL では真偽型を選択肢に出さない。
    const typeSelect = screen.getByLabelText(t("importNewTableColumnType", { name: "id" }));
    const values = Array.from((typeSelect as HTMLSelectElement).options).map((o) => o.value);
    expect(values).not.toContain("boolean");
  });

  it("lets an existing-table import switch to create-new mode", async () => {
    renderWithProviders(
      <ImportModal
        sessionId="s1"
        database="appdb"
        table="users"
        driver="sqlite"
        initialPath="/tmp/users.csv"
        onClose={() => {}}
        onImported={() => {}}
      />,
    );
    await screen.findByText(t("importMappingTitle"));
    fireEvent.click(screen.getByRole("switch", { name: t("importCreateNewTable") }));
    expect(await screen.findByText(t("importNewTableColumns"))).toBeInTheDocument();
    expect(screen.queryByText(t("importMappingTitle"))).not.toBeInTheDocument();
    expect(screen.queryByLabelText(t("importConflictMode"))).not.toBeInTheDocument();
  });
});
