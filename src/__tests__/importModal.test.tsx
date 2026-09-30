import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor, act } from "./testUtils";
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
        sheets: [],
      }),
      importCsv: vi.fn().mockResolvedValue(undefined),
      getImportSkippedText: vi.fn().mockResolvedValue("ALL SKIPPED ROWS"),
      saveImportSkippedRows: vi.fn().mockResolvedValue(1000),
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

const { saveMock, copyMock } = vi.hoisted(() => ({
  saveMock: vi.fn(),
  copyMock: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: saveMock }));
vi.mock("../components/clipboard", () => ({ copyToClipboard: copyMock }));

import { ImportModal } from "../components/ImportModal";
import { api, listenImportStream, type ImportDoneEvent } from "../api/tauri";

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

describe("ImportModal xlsx source (#1171)", () => {
  it("shows a sheet picker, re-reads the preview for the chosen sheet and sends it", async () => {
    vi.mocked(api.parseCsvPreview).mockResolvedValue({
      headers: ["id", "name"],
      rows: [["1", "alice"]],
      truncated: false,
      sheets: ["First", "Second"],
    });
    renderWithProviders(
      <ImportModal
        sessionId="s1"
        database="appdb"
        table="users"
        driver="postgres"
        initialPath="/tmp/users.xlsx"
        onClose={() => {}}
        onImported={() => {}}
      />,
    );
    await screen.findByText(t("importMappingTitle"));
    // 拡張子から形式を推定し、文字コードや区切り文字は出さない。
    expect(screen.getByLabelText(t("importFormat"))).toHaveValue("xlsx");
    expect(screen.queryByLabelText(t("importEncoding"))).not.toBeInTheDocument();
    expect(screen.queryByLabelText(t("importDelimiter"))).not.toBeInTheDocument();
    // 既定は先頭シート (options.sheet は送らない)。
    expect(vi.mocked(api.parseCsvPreview).mock.calls[0][1].sheet).toBeNull();

    const picker = await screen.findByLabelText(t("importSheet"));
    expect(picker).toHaveValue("First");
    fireEvent.change(picker, { target: { value: "Second" } });
    await waitFor(() =>
      expect(vi.mocked(api.parseCsvPreview).mock.lastCall?.[1].sheet).toBe("Second"),
    );

    fireEvent.click(await screen.findByRole("button", { name: t("importExecute") }));
    await waitFor(() => expect(api.importCsv).toHaveBeenCalledOnce());
    const params = vi.mocked(api.importCsv).mock.calls[0][0];
    expect(params.options.format).toBe("xlsx");
    expect(params.options.sheet).toBe("Second");
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

describe("ImportModal preview requests (#1258)", () => {
  function renderCsv() {
    return renderWithProviders(
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
  }
  const settle = () => new Promise((r) => setTimeout(r, 450));

  it("does not re-read the file when only the NULL token or the error mode changes", async () => {
    renderCsv();
    await screen.findByText(t("importMappingTitle"));
    await settle();
    const before = vi.mocked(api.parseCsvPreview).mock.calls.length;
    expect(before).toBeGreaterThan(0);
    // プレビューに送るオプションは NULL トークン / エラーモードに依存しない。
    const sent = vi.mocked(api.parseCsvPreview).mock.calls[0][1];
    expect(sent.nullToken).toBeNull();
    expect(sent.errorMode).toBe("abort");

    fireEvent.change(screen.getByLabelText(t("importNull")), { target: { value: "none" } });
    fireEvent.change(screen.getByLabelText(t("importErrorMode")), { target: { value: "skip" } });
    await settle();
    expect(vi.mocked(api.parseCsvPreview).mock.calls.length).toBe(before);

    // 取り込み本体には実際の NULL トークン / エラーモードが渡る。
    fireEvent.click(await screen.findByRole("button", { name: t("importExecute") }));
    await waitFor(() => expect(api.importCsv).toHaveBeenCalledOnce());
    const params = vi.mocked(api.importCsv).mock.calls[0][0];
    expect(params.options.errorMode).toBe("skip");
    expect(params.options.nullToken).toBeNull();
  });

  it("debounces rapid option edits into a single preview request", async () => {
    renderCsv();
    await screen.findByText(t("importMappingTitle"));
    await settle();
    const before = vi.mocked(api.parseCsvPreview).mock.calls.length;

    const delimiter = screen.getByLabelText(t("importDelimiter"));
    fireEvent.change(delimiter, { target: { value: ";" } });
    fireEvent.change(delimiter, { target: { value: "\t" } });
    fireEvent.change(delimiter, { target: { value: "," } });
    fireEvent.change(delimiter, { target: { value: ";" } });
    await settle();
    const calls = vi.mocked(api.parseCsvPreview).mock.calls;
    expect(calls.length).toBe(before + 1);
    expect(calls[calls.length - 1][1].delimiter).toBe(";");
  });
});

describe("ImportModal skipped rows (#1258)", () => {
  async function finishWithSkips(skippedTotal: number, shown: number) {
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
    await screen.findByText(t("importMappingTitle"));
    const execute = await screen.findByRole("button", { name: t("importExecute") });
    await waitFor(() => expect(execute).toBeEnabled());
    fireEvent.click(execute);
    await waitFor(() => expect(listenImportStream).toHaveBeenCalled());
    const handlers = vi.mocked(listenImportStream).mock.calls[0][1];
    const event: ImportDoneEvent = {
      streamId: "x",
      inserted: 10,
      elapsedMs: 5,
      skipped: Array.from({ length: shown }, (_, i) => ({
        record: i + 1,
        line: i % 2 === 0 ? i + 2 : null,
        reason: `bad ${i}`,
      })),
      skippedTotal,
    };
    await act(async () => {
      handlers.onDone?.(event);
    });
  }

  it("shows the total with only the head listed, and copies / saves the full list via the backend", async () => {
    saveMock.mockResolvedValue("/tmp/out.txt");
    copyMock.mockResolvedValue(true);
    await finishWithSkips(1000, 200);

    // 同じ文言がトースト (情報通知) にも出るので複数ヒットしうる。
    expect(
      (await screen.findAllByText(t("importSkippedSummary", { inserted: 10, skipped: 1000 }))).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(t("importSkippedShowing", { shown: 200, total: 1000 }))).toBeInTheDocument();
    expect(screen.getByText(/bad 199/)).toBeInTheDocument();
    expect(screen.queryByText(/bad 200/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: t("importSkippedCopy") }));
    await waitFor(() => expect(copyMock).toHaveBeenCalledWith("ALL SKIPPED ROWS"));
    expect(api.getImportSkippedText).toHaveBeenCalledWith(
      t("importSkippedRow"),
      t("importSkippedRowLine"),
    );

    fireEvent.click(screen.getByRole("button", { name: t("importSkippedSave") }));
    await waitFor(() =>
      expect(api.saveImportSkippedRows).toHaveBeenCalledWith(
        "/tmp/out.txt",
        t("importSkippedRow"),
        t("importSkippedRowLine"),
      ),
    );
  });

  it("omits the truncation note when every skipped row is listed", async () => {
    await finishWithSkips(3, 3);
    await screen.findAllByText(t("importSkippedSummary", { inserted: 10, skipped: 3 }));
    expect(screen.queryByText(/importSkippedShowing/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(t("importSkippedShowing", { shown: 3, total: 3 })),
    ).not.toBeInTheDocument();
  });

  it("does not call save when the file dialog is cancelled", async () => {
    saveMock.mockResolvedValue(null);
    await finishWithSkips(1000, 200);
    fireEvent.click(await screen.findByRole("button", { name: t("importSkippedSave") }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(api.saveImportSkippedRows).not.toHaveBeenCalled();
  });
});
