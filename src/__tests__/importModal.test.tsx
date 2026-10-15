import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
      importDryRun: vi.fn(),
      listImportTemplates: vi.fn().mockResolvedValue([]),
      saveImportTemplate: vi.fn().mockImplementation(async (tpl: unknown) => tpl),
      deleteImportTemplate: vi.fn().mockResolvedValue(undefined),
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
    await waitFor(() => expect(vi.mocked(api.parseCsvPreview).mock.lastCall?.[1].sheet).toBe("Second"));

    fireEvent.click(await screen.findByRole("button", { name: t("importExecute") }));
    await waitFor(() => expect(api.importCsv).toHaveBeenCalledOnce());
    const params = vi.mocked(api.importCsv).mock.calls[0][0];
    expect(params.options.format).toBe("xlsx");
    expect(params.options.sheet).toBe("Second");
  });
});

describe("ImportModal bulk sheet import entry (#1623)", () => {
  // `mockResolvedValue` は clearAllMocks で戻らないので、既定のプレビューへ戻す。
  afterEach(() => {
    vi.mocked(api.parseCsvPreview).mockResolvedValue({
      headers: ["id", "name"],
      rows: [["1", "alice"]],
      truncated: false,
      sheets: [],
    });
  });
  const book = (sheets: string[]) =>
    vi.mocked(api.parseCsvPreview).mockResolvedValue({
      headers: ["id"],
      rows: [["1"]],
      truncated: false,
      sheets,
    });
  const renderBook = (onImportAllSheets?: () => void) =>
    renderWithProviders(
      <ImportModal
        sessionId="s1"
        database="appdb"
        table="users"
        driver="postgres"
        initialPath="/tmp/book.xlsx"
        onImportAllSheets={onImportAllSheets}
        onClose={() => {}}
        onImported={() => {}}
      />,
    );

  it("hands the workbook over to the bulk import for a multi-sheet book", async () => {
    book(["A", "B"]);
    const onAll = vi.fn();
    renderBook(onAll);
    fireEvent.click(await screen.findByRole("button", { name: t("importSheetsOpen") }));
    expect(onAll).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/tmp/book.xlsx",
        sheets: ["A", "B"],
        options: expect.objectContaining({ format: "xlsx", hasHeader: true }),
      }),
    );
  });

  it("does not offer it for a single-sheet book", async () => {
    book(["Only"]);
    renderBook(vi.fn());
    await screen.findByText(t("importMappingTitle"));
    expect(screen.queryByRole("button", { name: t("importSheetsOpen") })).not.toBeInTheDocument();
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
    expect(screen.getByLabelText(t("importNewTableColumnType", { name: "name" }))).toHaveValue("text");
    expect(await screen.findByTestId("import-new-table-ddl")).toHaveTextContent('CREATE TABLE "new_users"');

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

  it("sends the chosen primary key columns with createTable (#1623)", async () => {
    renderWithProviders(
      <ImportModal
        sessionId="s1"
        database="appdb"
        table={null}
        driver="postgres"
        initialPath="/tmp/users.csv"
        onClose={() => {}}
        onImported={() => {}}
      />,
    );
    await screen.findByText(t("importNewTableColumns"));
    fireEvent.click(screen.getByRole("checkbox", { name: t("importNewTablePrimaryKey", { name: "id" }) }));
    expect(await screen.findByText(t("importNewTablePkNote"))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t("importExecute") }));
    await waitFor(() => expect(api.importCsv).toHaveBeenCalledOnce());
    expect(vi.mocked(api.importCsv).mock.calls[0][0].createTable).toEqual([
      { name: "id", type: "integer", primaryKey: true },
      { name: "name", type: "text" },
    ]);
  });

  it("warns when the preview has repeated primary key values (#1623)", async () => {
    vi.mocked(api.parseCsvPreview).mockResolvedValueOnce({
      headers: ["id", "name"],
      rows: [
        ["1", "a"],
        ["1", "b"],
      ],
      truncated: false,
      sheets: [],
    });
    renderWithProviders(
      <ImportModal
        sessionId="s1"
        database="appdb"
        table={null}
        driver="postgres"
        initialPath="/tmp/users.csv"
        onClose={() => {}}
        onImported={() => {}}
      />,
    );
    await screen.findByText(t("importNewTableColumns"));
    fireEvent.click(screen.getByRole("checkbox", { name: t("importNewTablePrimaryKey", { name: "id" }) }));
    expect(await screen.findByText(t("importNewTablePkDuplicate", { row: 2, first: 1 }))).toBeInTheDocument();
  });

  it("explains which value turned a column into text (#1623)", async () => {
    vi.mocked(api.parseCsvPreview).mockResolvedValueOnce({
      headers: ["code"],
      rows: [["1"], ["2"], ["N/A"]],
      truncated: false,
      sheets: [],
    });
    renderWithProviders(
      <ImportModal
        sessionId="s1"
        database="appdb"
        table={null}
        driver="postgres"
        initialPath="/tmp/codes.csv"
        onClose={() => {}}
        onImported={() => {}}
      />,
    );
    const why = await screen.findByTestId("import-new-table-why");
    expect(why).toHaveTextContent(t("importNewTableWhyValue", { name: "code", row: 3, value: "N/A" }));
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
    expect(await screen.findByText(t("importNewTableDuplicateColumn", { name: "ID" }))).toBeInTheDocument();
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

describe("ImportModal preview spinner", () => {
  it("clears the loading spinner when the quote becomes invalid mid-read", async () => {
    // 読込中に引用符欄を無効値にすると、旧 effect の finally は cancelled で何もせず、
    // 新 effect は早期 return するためスピナーが残り続けていた。
    let resolvePreview: (v: unknown) => void = () => {};
    vi.mocked(api.parseCsvPreview).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolvePreview = r;
        }) as never,
    );
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
    expect(await screen.findByText(t("importLoadingPreview"))).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(t("importQuote")), { target: { value: "ab" } });
    await waitFor(() => expect(screen.queryByText(t("importLoadingPreview"))).not.toBeInTheDocument());
    resolvePreview({ headers: [], rows: [], truncated: false, sheets: [] });
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
      sheets: [],
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
    expect(api.getImportSkippedText).toHaveBeenCalledWith(t("importSkippedRow"), t("importSkippedRowLine"));

    fireEvent.click(screen.getByRole("button", { name: t("importSkippedSave") }));
    await waitFor(() =>
      expect(api.saveImportSkippedRows).toHaveBeenCalledWith(
        "/tmp/out.txt",
        t("importSkippedRow"),
        t("importSkippedRowLine"),
      ),
    );
  });

  it("saves the original row data as CSV or NDJSON (#1623)", async () => {
    saveMock.mockResolvedValue("/tmp/out.csv");
    await finishWithSkips(3, 3);
    fireEvent.click(await screen.findByRole("button", { name: t("importSkippedSaveCsv") }));
    await waitFor(() =>
      expect(api.saveImportSkippedRows).toHaveBeenLastCalledWith(
        "/tmp/out.csv",
        t("importSkippedRow"),
        t("importSkippedRowLine"),
        "csv",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: t("importSkippedSaveNdjson") }));
    await waitFor(() =>
      expect(api.saveImportSkippedRows).toHaveBeenLastCalledWith(
        "/tmp/out.csv",
        t("importSkippedRow"),
        t("importSkippedRowLine"),
        "ndjson",
      ),
    );
  });

  it("omits the truncation note when every skipped row is listed", async () => {
    await finishWithSkips(3, 3);
    await screen.findAllByText(t("importSkippedSummary", { inserted: 10, skipped: 3 }));
    expect(screen.queryByText(/importSkippedShowing/)).not.toBeInTheDocument();
    expect(screen.queryByText(t("importSkippedShowing", { shown: 3, total: 3 }))).not.toBeInTheDocument();
  });

  it("does not call save when the file dialog is cancelled", async () => {
    saveMock.mockResolvedValue(null);
    await finishWithSkips(1000, 200);
    fireEvent.click(await screen.findByRole("button", { name: t("importSkippedSave") }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(api.saveImportSkippedRows).not.toHaveBeenCalled();
  });
});

describe("ImportModal re-run guard for an existing table (#1598)", () => {
  it("disables the execute button after a successful import of the same file", async () => {
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
    await act(async () => {
      handlers.onDone?.({
        streamId: "x",
        inserted: 10,
        elapsedMs: 5,
        skipped: [],
        skippedTotal: 0,
        sheets: [],
      });
    });
    // 同じファイルのままの再実行 (行の重複挿入) はできない。
    await waitFor(() => expect(screen.getByRole("button", { name: t("importExecute") })).toBeDisabled());
    // パスを編集すれば再び実行できる。
    fireEvent.change(screen.getByLabelText(t("importFile")), { target: { value: "/tmp/users2.csv" } });
    await waitFor(() => expect(screen.getByRole("button", { name: t("importExecute") })).toBeEnabled());
  });
});

describe("ImportModal dry run (#1623)", () => {
  const renderUsers = () =>
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

  it("lists the rejected rows without importing, and hides a stale result when the input changes", async () => {
    vi.mocked(api.importDryRun).mockResolvedValue({
      total: 120,
      failed: 61,
      failures: Array.from({ length: 50 }, (_, i) => ({ record: i + 3, line: i + 4, reason: `dup ${i}` })),
      dbChecked: true,
    });
    renderUsers();
    await screen.findByText(t("importMappingTitle"));
    const validate = await screen.findByRole("button", { name: t("importDryRun") });
    await waitFor(() => expect(validate).toBeEnabled());
    fireEvent.click(validate);
    expect(await screen.findByText(t("importDryRunFailed", { failed: 61, total: 120 }))).toBeInTheDocument();
    expect(screen.getByText(t("importDryRunShowing", { shown: 50, total: 61 }))).toBeInTheDocument();
    expect(screen.getByText(/dup 49/)).toBeInTheDocument();
    expect(api.importDryRun).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s1", database: "appdb", table: "users", path: "/tmp/users.csv" }),
    );
    expect(api.importCsv).not.toHaveBeenCalled();
    // 入力 (ここでは取り込みファイル) を変えると、古い検証結果は隠れる。
    fireEvent.change(screen.getByLabelText(t("importFile")), { target: { value: "/tmp/other.csv" } });
    await waitFor(() => expect(screen.queryByTestId("import-dry-run-result")).not.toBeInTheDocument());
  });

  it("says when the database was not tried because the table does not exist yet", async () => {
    vi.mocked(api.importDryRun).mockResolvedValue({ total: 7, failed: 0, failures: [], dbChecked: false });
    renderWithProviders(
      <ImportModal
        sessionId="s1"
        database="appdb"
        table={null}
        driver="postgres"
        initialPath="/tmp/users.csv"
        onClose={() => {}}
        onImported={() => {}}
      />,
    );
    const validate = await screen.findByRole("button", { name: t("importDryRun") });
    await waitFor(() => expect(validate).toBeEnabled());
    fireEvent.click(validate);
    expect(await screen.findByText(t("importDryRunFileOnly", { total: 7 }))).toBeInTheDocument();
    expect(vi.mocked(api.importDryRun).mock.calls[0][0].createTable).not.toBeNull();
  });
});

describe("ImportModal saved mapping templates (#1623)", () => {
  const tpl = {
    id: "p1\u001fappdb\u001fusers",
    profileId: "p1",
    database: "appdb",
    table: "users",
    format: "csv",
    delimiter: ",",
    quote: '"',
    hasHeader: true,
    nullToken: "",
    encoding: "utf-8",
    sheet: null,
    conflictMode: "insert",
    errorMode: "skip",
    keyColumns: [],
    mapping: [{ column: SAMPLE_COLUMNS[0].name, header: "name", csvIndex: 1 }],
    updatedAtMs: 1,
  };
  const renderUsers = () =>
    renderWithProviders(
      <ImportModal
        sessionId="s1"
        database="appdb"
        table="users"
        driver="postgres"
        profileId="p1"
        initialPath="/tmp/users.csv"
        onClose={() => {}}
        onImported={() => {}}
      />,
    );

  it("offers the saved template for this table and applies its mapping by header name", async () => {
    vi.mocked(api.listImportTemplates).mockResolvedValue([tpl]);
    renderUsers();
    expect(api.listImportTemplates).toHaveBeenCalledWith("p1", "appdb", "users");
    const apply = await screen.findByRole("button", { name: t("importTemplateApply") });
    await waitFor(() => expect(apply).toBeEnabled());
    fireEvent.click(apply);
    const select = await screen.findByLabelText(t("importMappingAria", { column: SAMPLE_COLUMNS[0].name }));
    // 保存時の位置 (1) ではなく、見出し "name" の今の位置 (1)。さらに skip モードも戻る。
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe("1"));
  });

  it("saves the current mapping without the file path", async () => {
    vi.mocked(api.listImportTemplates).mockResolvedValue([]);
    renderUsers();
    const save = await screen.findByRole("button", { name: t("importTemplateSave") });
    fireEvent.click(save);
    await waitFor(() => expect(api.saveImportTemplate).toHaveBeenCalled());
    const saved = vi.mocked(api.saveImportTemplate).mock.calls[0][0];
    expect(saved).toMatchObject({ profileId: "p1", database: "appdb", table: "users", format: "csv" });
    expect(JSON.stringify(saved)).not.toContain("/tmp/users.csv");
  });

  it("shows no template UI without a profile id", async () => {
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
    expect(screen.queryByRole("button", { name: t("importTemplateSave") })).not.toBeInTheDocument();
    expect(api.listImportTemplates).not.toHaveBeenCalled();
  });
});
