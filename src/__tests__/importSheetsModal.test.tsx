import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor, act } from "./testUtils";
import { t } from "../i18n";

/**
 * xlsx の複数シート一括取り込み (#1623)。各シートの先頭行を `parseCsvPreview` で読み、
 * 実行は `importXlsxSheets` 1 回。イベントは `listenImportStream` をモックして流す。
 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listTables: vi.fn().mockResolvedValue(["orders"]),
      parseCsvPreview: vi.fn(),
      importXlsxSheets: vi.fn().mockResolvedValue(undefined),
      cancelStream: vi.fn().mockResolvedValue({ deliveredRows: 0 }),
    },
    listenImportStream: vi.fn().mockResolvedValue(() => {}),
  };
});

import { ImportSheetsModal } from "../components/ImportSheetsModal";
import { api, listenImportStream } from "../api/tauri";

const options = {
  format: "xlsx" as const,
  delimiter: ",",
  quote: '"',
  hasHeader: true,
  nullToken: "",
  encoding: "utf-8",
  errorMode: "abort" as const,
};

const previews: Record<
  string,
  { headers: string[]; rows: string[][]; truncated: boolean; sheets: string[] }
> = {
  Users: {
    headers: ["id", "name"],
    rows: [["1", "alice"]],
    truncated: false,
    sheets: ["Users", "Orders", "Empty"],
  },
  Orders: {
    headers: ["no"],
    rows: [["100"], ["101"]],
    truncated: false,
    sheets: ["Users", "Orders", "Empty"],
  },
  Empty: { headers: [], rows: [], truncated: false, sheets: ["Users", "Orders", "Empty"] },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.parseCsvPreview).mockImplementation(async (_path, opts) => previews[opts.sheet ?? ""]);
});

function renderModal(onImported = vi.fn()) {
  renderWithProviders(
    <ImportSheetsModal
      sessionId="s1"
      database="shop"
      driver="sqlite"
      path="/tmp/book.xlsx"
      options={options}
      sheets={["Users", "Orders", "Empty"]}
      onClose={() => {}}
      onImported={onImported}
    />,
  );
  return onImported;
}

describe("ImportSheetsModal (#1623)", () => {
  it("proposes a free table name per sheet, skips empty sheets and blocks a name that already exists", async () => {
    renderModal();
    const users = await screen.findByLabelText(t("importSheetsTableName", { sheet: "Users" }));
    expect((users as HTMLInputElement).value).toBe("Users");
    // 既存テーブル "orders" と大小無視で衝突するシート名は、連番を付けて提案する。
    const orders = screen.getByLabelText(t("importSheetsTableName", { sheet: "Orders" })) as HTMLInputElement;
    expect(orders.value).toBe("Orders_2");
    const run = () => screen.getByRole("button", { name: t("importSheetsExecute", { count: 2 }) });
    expect(run()).toBeEnabled();
    // データの無いシートは最初から対象外。
    expect(screen.getByLabelText(t("importSheetsInclude", { sheet: "Empty" }))).not.toBeChecked();
    expect(screen.getByText(t("importSheetsEmpty"))).toBeInTheDocument();

    // 手で既存名に直すと、衝突として実行を止める。
    fireEvent.change(orders, { target: { value: "orders" } });
    expect(await screen.findByText(t("importSheetsTableExists", { table: "orders" }))).toBeInTheDocument();
    expect(run()).toBeDisabled();
    // シート間の重複も止める。
    fireEvent.change(orders, { target: { value: "Users" } });
    expect(await screen.findByText(t("importSheetsTableDuplicate", { table: "Users" }))).toBeInTheDocument();
    expect(run()).toBeDisabled();
  });

  it("imports the selected sheets in one call and summarises the result per sheet", async () => {
    const onImported = renderModal();
    const orders = await screen.findByLabelText(t("importSheetsTableName", { sheet: "Orders" }));
    fireEvent.change(orders, { target: { value: "orders_2026" } });
    const run = screen.getByRole("button", { name: t("importSheetsExecute", { count: 2 }) });
    await waitFor(() => expect(run).toBeEnabled());
    fireEvent.click(run);
    await waitFor(() => expect(api.importXlsxSheets).toHaveBeenCalled());
    const call = vi.mocked(api.importXlsxSheets).mock.calls[0][0];
    expect(call).toMatchObject({ sessionId: "s1", database: "shop", path: "/tmp/book.xlsx" });
    expect(call.options).toMatchObject({ format: "xlsx", sheet: null, conflictMode: "insert" });
    expect(call.sheets.map((s) => [s.sheet, s.table])).toEqual([
      ["Users", "Users"],
      ["Orders", "orders_2026"],
    ]);
    expect(call.sheets[0].mapping).toEqual([
      { column: "id", csvIndex: 0 },
      { column: "name", csvIndex: 1 },
    ]);
    expect(call.sheets[1].createTable).toEqual([{ name: "no", type: "integer" }]);

    const handlers = vi.mocked(listenImportStream).mock.calls[0][1];
    await act(async () => {
      handlers.onDone?.({
        streamId: "x",
        inserted: 3,
        elapsedMs: 5,
        skipped: [],
        skippedTotal: 0,
        sheets: [
          { sheet: "Users", table: "Users", inserted: 1, skippedTotal: 0 },
          { sheet: "Orders", table: "orders_2026", inserted: 2, skippedTotal: 0 },
        ],
      });
    });
    const result = await screen.findByTestId("import-sheets-result");
    expect(result).toHaveTextContent(
      t("importSheetsResultRow", { sheet: "Orders", table: "orders_2026", inserted: 2, skipped: 0 }),
    );
    expect(onImported).toHaveBeenCalledWith(["Users", "orders_2026"]);
  });

  it("shows the backend error and refreshes the tree when earlier sheets were already imported", async () => {
    const onImported = renderModal();
    fireEvent.change(await screen.findByLabelText(t("importSheetsTableName", { sheet: "Orders" })), {
      target: { value: "orders_2026" },
    });
    const run = screen.getByRole("button", { name: t("importSheetsExecute", { count: 2 }) });
    await waitFor(() => expect(run).toBeEnabled());
    fireEvent.click(run);
    await waitFor(() => expect(listenImportStream).toHaveBeenCalled());
    const handlers = vi.mocked(listenImportStream).mock.calls[0][1];
    await act(async () => {
      handlers.onError?.({
        streamId: "x",
        error: "[Orders] boom (already imported: Users -> Users)",
        record: 2,
        line: 3,
        committed: 1,
      });
    });
    expect((await screen.findAllByText(/boom/)).length).toBeGreaterThan(0);
    expect(onImported).toHaveBeenCalled();
  });
});
