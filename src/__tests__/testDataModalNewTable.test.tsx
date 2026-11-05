import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, renderWithProviders, screen, waitFor, chooseListboxOption } from "./testUtils";
import { t } from "../i18n";

const describeTable = vi.fn();
const runQuery = vi.fn();
const insertGeneratedRows = vi.fn();
const listIndexes = vi.fn();
const previewCreateTableDdl = vi.fn();

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      describeTable: (...a: unknown[]) => describeTable(...a),
      runQuery: (...a: unknown[]) => runQuery(...a),
      insertGeneratedRows: (...a: unknown[]) => insertGeneratedRows(...a),
      listIndexes: (...a: unknown[]) => listIndexes(...a),
      previewCreateTableDdl: (...a: unknown[]) => previewCreateTableDdl(...a),
      hasAiApiKey: () => Promise.resolve(false),
    },
  };
});

import { TestDataModal } from "../components/TestDataModal";

const onClose = vi.fn();
const onInserted = vi.fn();
const onTableCreated = vi.fn();

function column(name: string, over: Record<string, unknown> = {}) {
  return {
    name,
    data_type: "varchar(100)",
    nullable: false,
    key: "",
    default: null,
    extra: "",
    referenced_table: null,
    referenced_column: null,
    ...over,
  };
}

function ui(isProduction = false) {
  return (
    <TestDataModal
      sessionId="s1"
      database="app"
      table="orders"
      driver="postgres"
      isProduction={isProduction}
      onClose={onClose}
      onInserted={onInserted}
      onTableCreated={onTableCreated}
    />
  );
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
  describeTable.mockResolvedValue([
    column("id", { data_type: "int", key: "PRI" }),
    column("name"),
    column("created", { data_type: "date" }),
  ]);
  runQuery.mockResolvedValue({ rows: [] });
  listIndexes.mockResolvedValue([]);
  insertGeneratedRows.mockResolvedValue({ inserted: 100, elapsed_ms: 5 });
  previewCreateTableDdl.mockImplementation(
    async (_d: string, table: string, cols: { name: string; type: string }[]) =>
      `CREATE TABLE "${table}" (${cols.map((c) => `${c.name} ${c.type}`).join(", ")})`,
  );
});

describe("TestDataModal 新規テーブルを作って投入 (#2066)", () => {
  it("切替前は名前入力も DDL プレビューも出ない", async () => {
    renderWithProviders(ui());
    await screen.findByLabelText(t("testDataStrategyAria", { column: "name" }));
    expect(screen.queryByLabelText(t("importNewTableName"))).toBeNull();
    expect(screen.queryByText(t("importNewTableDdl"))).toBeNull();
  });

  it("切り替えるとテーブル名入力と列ごとの型選択が出て、CREATE TABLE をプレビューする", async () => {
    renderWithProviders(ui());
    await screen.findByLabelText(t("testDataStrategyAria", { column: "name" }));
    fireEvent.click(screen.getByRole("switch", { name: t("testDataCreateNew") }));
    const input = await screen.findByLabelText(t("importNewTableName"));
    // 名前が空の間は投入できない。
    expect((screen.getByRole("button", { name: t("testDataRun") }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "orders_copy" } });
    await screen.findByText(t("importNewTableDdl"));
    await waitFor(() =>
      expect(previewCreateTableDdl).toHaveBeenLastCalledWith("postgres", "orders_copy", [
        { name: "id", type: "bigint" },
        { name: "name", type: "text" },
        { name: "created", type: "date" },
      ]),
    );
    expect(document.body.textContent).toContain('CREATE TABLE "orders_copy"');
    // 列型を上書きするとプレビューへ反映される。
    chooseListboxOption(screen.getByLabelText(t("testDataNewColumnTypeAria", { column: "id" })), "integer");
    await waitFor(() =>
      expect(previewCreateTableDdl).toHaveBeenLastCalledWith("postgres", "orders_copy", [
        { name: "id", type: "integer" },
        { name: "name", type: "text" },
        { name: "created", type: "date" },
      ]),
    );
  });

  it("投入は createTable 付きで新しい表名へ送り、onTableCreated を呼ぶ", async () => {
    renderWithProviders(ui());
    await screen.findByLabelText(t("testDataStrategyAria", { column: "name" }));
    fireEvent.click(screen.getByRole("switch", { name: t("testDataCreateNew") }));
    fireEvent.change(await screen.findByLabelText(t("importNewTableName")), {
      target: { value: " fresh " },
    });
    await screen.findByText(t("importNewTableDdl"));
    const run = screen.getByRole("button", { name: t("testDataRun") }) as HTMLButtonElement;
    await waitFor(() => expect(run.disabled).toBe(false));
    fireEvent.click(run);
    await waitFor(() => expect(insertGeneratedRows).toHaveBeenCalledTimes(1));
    const args = insertGeneratedRows.mock.calls[0][0];
    expect(args.table).toBe("fresh");
    expect(args.columns).toEqual(["id", "name", "created"]);
    expect(args.createTable).toEqual([
      { name: "id", type: "bigint" },
      { name: "name", type: "text" },
      { name: "created", type: "date" },
    ]);
    await waitFor(() => expect(onTableCreated).toHaveBeenCalledWith("app", "fresh"));
    expect(onInserted).not.toHaveBeenCalled();
  });

  it("DDL 検証エラーはフィールドエラーに出し、投入を無効にする", async () => {
    previewCreateTableDdl.mockRejectedValue("invalid input: table name is too long");
    renderWithProviders(ui());
    await screen.findByLabelText(t("testDataStrategyAria", { column: "name" }));
    fireEvent.click(screen.getByRole("switch", { name: t("testDataCreateNew") }));
    fireEvent.change(await screen.findByLabelText(t("importNewTableName")), { target: { value: "x" } });
    await screen.findByText(/table name is too long/);
    expect((screen.getByRole("button", { name: t("testDataRun") }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("切り替えなければ従来どおり createTable なしで既存表へ投入する", async () => {
    renderWithProviders(ui());
    await screen.findByLabelText(t("testDataStrategyAria", { column: "name" }));
    const run = screen.getByRole("button", { name: t("testDataRun") }) as HTMLButtonElement;
    await waitFor(() => expect(run.disabled).toBe(false));
    fireEvent.click(run);
    await waitFor(() => expect(insertGeneratedRows).toHaveBeenCalledTimes(1));
    const args = insertGeneratedRows.mock.calls[0][0];
    expect(args.table).toBe("orders");
    expect(args.createTable).toBeNull();
    await waitFor(() => expect(onInserted).toHaveBeenCalled());
    expect(onTableCreated).not.toHaveBeenCalled();
  });

  it("生成方針を変えると、その列の型の上書きは既定へ戻る", async () => {
    renderWithProviders(ui());
    await screen.findByLabelText(t("testDataStrategyAria", { column: "name" }));
    fireEvent.click(screen.getByRole("switch", { name: t("testDataCreateNew") }));
    fireEvent.change(await screen.findByLabelText(t("importNewTableName")), { target: { value: "x" } });
    chooseListboxOption(screen.getByLabelText(t("testDataNewColumnTypeAria", { column: "name" })), "integer");
    await waitFor(() =>
      expect(previewCreateTableDdl.mock.lastCall?.[2]).toContainEqual({ name: "name", type: "integer" }),
    );
    chooseListboxOption(screen.getByLabelText(t("testDataStrategyAria", { column: "name" })), "uuid");
    await waitFor(() =>
      expect(previewCreateTableDdl.mock.lastCall?.[2]).toContainEqual({ name: "name", type: "text" }),
    );
  });

  it("DDL プレビュー取得中は実行できない", async () => {
    renderWithProviders(ui());
    await screen.findByLabelText(t("testDataStrategyAria", { column: "name" }));
    fireEvent.click(screen.getByRole("switch", { name: t("testDataCreateNew") }));
    let release: (v: string) => void = () => {};
    previewCreateTableDdl.mockImplementation(() => new Promise<string>((r) => (release = r)));
    fireEvent.change(await screen.findByLabelText(t("importNewTableName")), { target: { value: "x" } });
    await waitFor(() => expect(previewCreateTableDdl).toHaveBeenCalled());
    expect((screen.getByRole("button", { name: t("testDataRun") }) as HTMLButtonElement).disabled).toBe(true);
    release('CREATE TABLE "x" ()');
    await waitFor(() =>
      expect((screen.getByRole("button", { name: t("testDataRun") }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
  });

  it("DROP も失敗してテーブルが残ったときは onTableCreated でスキーマを再読込する", async () => {
    insertGeneratedRows.mockRejectedValue(
      "x (the newly created table x could not be dropped and still exists: y)",
    );
    renderWithProviders(ui());
    await screen.findByLabelText(t("testDataStrategyAria", { column: "name" }));
    fireEvent.click(screen.getByRole("switch", { name: t("testDataCreateNew") }));
    fireEvent.change(await screen.findByLabelText(t("importNewTableName")), { target: { value: "x" } });
    const run = screen.getByRole("button", { name: t("testDataRun") }) as HTMLButtonElement;
    await waitFor(() => expect(run.disabled).toBe(false));
    fireEvent.click(run);
    await waitFor(() => expect(onTableCreated).toHaveBeenCalledWith("app", "x"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("本番接続 + 新規作成では新しい表名のタイプ入力を要求する", async () => {
    renderWithProviders(ui(true));
    await screen.findByLabelText(t("testDataStrategyAria", { column: "name" }));
    fireEvent.click(screen.getByRole("switch", { name: t("testDataCreateNew") }));
    fireEvent.change(await screen.findByLabelText(t("importNewTableName")), { target: { value: "fresh" } });
    const run = screen.getByRole("button", { name: t("testDataRun") }) as HTMLButtonElement;
    await waitFor(() => expect(run.disabled).toBe(false));
    fireEvent.click(run);
    // 確認ダイアログは新しい表名の入力を求め、確定するまで投入しない。
    await screen.findByText(t("testDataProductionConfirmNewTitle", { table: "fresh" }));
    expect(insertGeneratedRows).not.toHaveBeenCalled();
    // 既存の表名 (orders) ではなく新しい表名 (fresh) を打ったときだけ確定できる。
    const input = await screen.findByLabelText(t("typeToConfirmLabel", { target: "fresh" }));
    expect(screen.queryByLabelText(t("typeToConfirmLabel", { target: "orders" }))).toBeNull();
    fireEvent.change(input, { target: { value: "fresh" } });
    fireEvent.click(screen.getAllByRole("button", { name: t("testDataRun") }).at(-1) as HTMLElement);
    await waitFor(() => expect(insertGeneratedRows).toHaveBeenCalledTimes(1));
    expect(insertGeneratedRows.mock.calls[0][0].table).toBe("fresh");
  });
});
