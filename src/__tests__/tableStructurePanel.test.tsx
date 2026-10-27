import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";

/**
 * テーブル構造ボトムパネル (#1112)。Database Explorer でテーブルを選んだあとの
 * 「構造」側の行き先で、ここから「データ」側へも 1 手で移れること、外部キーの
 * 参照先へ辿れること、取得失敗を黙って空表示にしないことを固定する。
 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      describeTable: vi.fn(),
      describeTableExtras: vi.fn(),
      listIndexes: vi.fn(),
      listTableTriggers: vi.fn(),
      getObjectDefinition: vi.fn(),
      incomingForeignKeys: vi.fn(),
    },
  };
});

import { api } from "../api/tauri";
import { TableStructurePanel } from "../components/TableStructurePanel";

const col = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  data_type: "int",
  nullable: false,
  key: "",
  default: null,
  extra: "",
  referenced_table: null,
  referenced_column: null,
  ...over,
});

function renderPanel() {
  const onOpenData = vi.fn();
  const onSelectTable = vi.fn();
  renderWithProviders(
    <TableStructurePanel
      sessionId="s1"
      driver="mysql"
      target={{ database: "app", table: "orders" }}
      onOpenData={onOpenData}
      onSelectTable={onSelectTable}
    />,
  );
  return { onOpenData, onSelectTable };
}

describe("TableStructurePanel (#1112)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.incomingForeignKeys).mockResolvedValue([]);
  });

  it("列・インデックス・外部キーを並べ、データへも参照先の構造へも移れる", async () => {
    vi.mocked(api.describeTable).mockResolvedValueOnce([
      col("id", { key: "PRI", extra: "auto_increment" }),
      col("user_id", { referenced_table: "users", referenced_column: "id" }),
      col("note", { nullable: true, data_type: "text" }),
    ]);
    vi.mocked(api.listIndexes).mockResolvedValueOnce([
      { name: "idx_user", columns: ["user_id"], unique: false, primary: false, method: "BTREE" },
      { name: "PRIMARY", columns: ["id"], unique: true, primary: true, method: null },
    ]);
    const { onOpenData, onSelectTable } = renderPanel();

    expect(await screen.findByText("auto_increment")).toBeInTheDocument();
    expect(screen.getByText("app.orders")).toBeInTheDocument();
    expect(screen.getByText("idx_user")).toBeInTheDocument();
    // 主キーのインデックスが先頭に並ぶ。
    const indexNames = screen.getAllByText(/^(PRIMARY|idx_user)$/).map((el) => el.textContent);
    expect(indexNames).toEqual(["PRIMARY", "idx_user"]);

    fireEvent.click(screen.getByRole("button", { name: new RegExp(t("structureOpenData")) }));
    expect(onOpenData).toHaveBeenCalledWith("app", "orders");

    // 列表と外部キー表の 2 箇所に参照先リンクが出る。
    const refs = screen.getAllByRole("button", { name: /users\.id/ });
    expect(refs).toHaveLength(2);
    fireEvent.click(refs[1]);
    expect(onSelectTable).toHaveBeenCalledWith({ database: "app", table: "users" });
  });

  it("CHECK 制約と生成列の式を節として出し、取得できなければ節ごと出さない (#1837)", async () => {
    vi.mocked(api.describeTable).mockResolvedValue([col("id"), col("total")]);
    vi.mocked(api.listIndexes).mockResolvedValue([]);
    vi.mocked(api.describeTableExtras).mockResolvedValueOnce({
      checks: [{ name: "price_pos", definition: "CHECK (price > 0)" }],
      generated: [{ column: "total", expression: "price * qty", is_virtual: true }],
    });
    renderPanel();
    expect(await screen.findByText("CHECK (price > 0)")).toBeInTheDocument();
    expect(screen.getByText("price_pos")).toBeInTheDocument();
    expect(screen.getByText("price * qty")).toBeInTheDocument();
    expect(screen.getByText("VIRTUAL")).toBeInTheDocument();
  });

  it("トリガー一覧を節として出し、取得できなければ節ごと出さない (#1867)", async () => {
    vi.mocked(api.describeTable).mockResolvedValue([col("id")]);
    vi.mocked(api.listIndexes).mockResolvedValue([]);
    vi.mocked(api.listTableTriggers).mockResolvedValueOnce([
      {
        name: "trg_audit",
        timing: "AFTER",
        event: "UPDATE",
        definition: "CREATE TRIGGER trg_audit AFTER UPDATE ON orders ...",
        enabled: false,
      },
    ]);
    renderPanel();
    expect(await screen.findByText("trg_audit")).toBeInTheDocument();
    expect(screen.getByText("AFTER")).toBeInTheDocument();
    expect(screen.getByText("UPDATE")).toBeInTheDocument();
    expect(screen.getByText(t("structureTriggerNote"))).toBeInTheDocument();
    expect(screen.getByText(t("structureTriggerDisabled"))).toBeInTheDocument();
  });

  it("トリガーの取得に失敗したら控えめな文言を出し、構造は出る (#1867)", async () => {
    vi.mocked(api.describeTable).mockResolvedValue([col("id")]);
    vi.mocked(api.listIndexes).mockResolvedValue([]);
    vi.mocked(api.listTableTriggers).mockRejectedValueOnce(new Error("denied"));
    renderPanel();
    expect(await screen.findByText("app.orders")).toBeInTheDocument();
    expect(
      await screen.findByText(/トリガーを取得できませんでした|Could not load triggers/),
    ).toBeInTheDocument();
  });

  it("トリガーが 0 件なら節を出さない。定義が空なら展開欄も出さない (#1867)", async () => {
    vi.mocked(api.describeTable).mockResolvedValue([col("id")]);
    vi.mocked(api.listIndexes).mockResolvedValue([]);
    vi.mocked(api.listTableTriggers).mockResolvedValueOnce([]);
    renderPanel();
    expect(await screen.findByText("app.orders")).toBeInTheDocument();
    await waitFor(() => expect(api.listTableTriggers).toHaveBeenCalled());
    expect(screen.queryByText(t("structureTriggers"))).not.toBeInTheDocument();
    expect(screen.queryByText(t("structureTriggersFailed"))).not.toBeInTheDocument();
  });

  it("定義が空のトリガーは展開欄を出さない (#1867)", async () => {
    vi.mocked(api.describeTable).mockResolvedValue([col("id")]);
    vi.mocked(api.listIndexes).mockResolvedValue([]);
    vi.mocked(api.listTableTriggers).mockResolvedValueOnce([
      { name: "trg_x", timing: "BEFORE", event: "INSERT", definition: "", enabled: true },
    ]);
    renderPanel();
    expect(await screen.findByText("trg_x")).toBeInTheDocument();
    expect(screen.queryByText(t("structureTriggerShowDefinition"))).not.toBeInTheDocument();
  });

  it("CHECK 制約が取れない (古い MySQL など) 環境でも構造は出て、節は出ない (#1837)", async () => {
    vi.mocked(api.describeTable).mockResolvedValue([col("id")]);
    vi.mocked(api.listIndexes).mockResolvedValue([]);
    vi.mocked(api.describeTableExtras).mockRejectedValueOnce(new Error("unsupported"));
    renderPanel();
    expect(await screen.findByText("app.orders")).toBeInTheDocument();
    await waitFor(() => expect(api.describeTableExtras).toHaveBeenCalled());
    expect(screen.queryByText(t("structureChecks"))).not.toBeInTheDocument();
  });

  it("DDL は「DDL を表示」を押すまで取得せず、押すと CREATE TABLE を読み取り専用で表示する (#1540)", async () => {
    vi.mocked(api.describeTable).mockResolvedValueOnce([col("id")]);
    vi.mocked(api.listIndexes).mockResolvedValueOnce([]);
    vi.mocked(api.getObjectDefinition).mockResolvedValueOnce("CREATE TABLE `orders` (`id` int)");
    renderPanel();

    const show = await screen.findByRole("button", { name: t("structureDdlShow") });
    expect(api.getObjectDefinition).not.toHaveBeenCalled();
    fireEvent.click(show);
    expect(await screen.findByText("CREATE TABLE `orders` (`id` int)")).toBeInTheDocument();
    expect(api.getObjectDefinition).toHaveBeenCalledWith("s1", "app", "table", "orders", null);
    expect(screen.getByRole("button", { name: t("structureDdlCopy") })).toBeInTheDocument();
    // MySQL はネイティブ出力なので「再構成」の注記は出さない。
    expect(screen.queryByText(t("tableDdlSynthesizedHint"))).not.toBeInTheDocument();
  });

  it("テーブルを切り替えたあとに届いた古い DDL 応答は捨てる (#1540)", async () => {
    vi.mocked(api.describeTable).mockResolvedValue([col("id")]);
    vi.mocked(api.listIndexes).mockResolvedValue([]);
    let resolveA: (v: string) => void = () => {};
    vi.mocked(api.getObjectDefinition)
      .mockImplementationOnce(() => new Promise<string>((r) => (resolveA = r)))
      .mockResolvedValueOnce("CREATE TABLE `items` (`id` int)");
    const props = { sessionId: "s1", driver: "mysql" as const, onOpenData: vi.fn(), onSelectTable: vi.fn() };
    const { rerender } = renderWithProviders(
      <TableStructurePanel {...props} target={{ database: "app", table: "orders" }} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: t("structureDdlShow") }));
    rerender(<TableStructurePanel {...props} target={{ database: "app", table: "items" }} />);
    fireEvent.click(await screen.findByRole("button", { name: t("structureDdlShow") }));
    expect(await screen.findByText("CREATE TABLE `items` (`id` int)")).toBeInTheDocument();
    resolveA("CREATE TABLE `orders` (`id` int)");
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("CREATE TABLE `orders` (`id` int)")).not.toBeInTheDocument();
    expect(screen.getByText("CREATE TABLE `items` (`id` int)")).toBeInTheDocument();
  });

  it("DDL の取得に失敗したらエラーを出し、再度試せる (#1540)", async () => {
    vi.mocked(api.describeTable).mockResolvedValueOnce([col("id")]);
    vi.mocked(api.listIndexes).mockResolvedValueOnce([]);
    vi.mocked(api.getObjectDefinition).mockRejectedValueOnce(new Error("no privilege"));
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: t("structureDdlShow") }));
    expect(await screen.findByText(/no privilege/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("structureDdlShow") })).toBeInTheDocument();
  });

  it("インデックス / 外部キーが無いときはその旨を出す", async () => {
    vi.mocked(api.describeTable).mockResolvedValueOnce([col("id")]);
    vi.mocked(api.listIndexes).mockRejectedValueOnce(new Error("denied"));
    renderPanel();

    expect(await screen.findByText(t("structureNoIndexes"))).toBeInTheDocument();
    expect(screen.getByText(t("structureNoForeignKeys"))).toBeInTheDocument();
  });

  it("列の取得に失敗したらエラーを出し、再読み込みで取り直す", async () => {
    vi.mocked(api.describeTable).mockRejectedValueOnce(new Error("boom"));
    vi.mocked(api.listIndexes).mockResolvedValue([]);
    renderPanel();

    expect(await screen.findByText(/boom/)).toBeInTheDocument();
    vi.mocked(api.describeTable).mockResolvedValueOnce([col("id")]);
    fireEvent.click(screen.getAllByRole("button", { name: new RegExp(t("structureReload")) })[0]);
    await waitFor(() => expect(api.describeTable).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("id")).toBeInTheDocument();
  });

  /**
   * 初回ロード中の bare Spinner を廃止し、共通スケルトンへ揃える (#1174)。
   * `describeTable` が返るまでの間は列表の骨格 (6 列) が出て、インデックス/外部キー
   * の「無し」表示 (実データ 0 件の確定表示) を誤って出さないことを固定する。
   */
  it("初回ロード中は列表のスケルトンを出し、インデックス/外部キーの空表示は出さない", async () => {
    let resolveColumns: (cols: ReturnType<typeof col>[]) => void = () => {};
    const pending = new Promise<ReturnType<typeof col>[]>((resolve) => {
      resolveColumns = resolve;
    });
    vi.mocked(api.describeTable).mockReturnValueOnce(pending);
    vi.mocked(api.listIndexes).mockResolvedValueOnce([]);

    const { container } = renderWithProviders(
      <TableStructurePanel
        sessionId="s1"
        driver="mysql"
        target={{ database: "app", table: "orders" }}
        onOpenData={vi.fn()}
        onSelectTable={vi.fn()}
      />,
    );

    await waitFor(() => {
      const rows = container.querySelectorAll("tbody > tr");
      expect(rows.length).toBeGreaterThan(0);
      rows.forEach((row) => expect(row.getAttribute("aria-hidden")).toBe("true"));
    });
    expect(screen.queryByText(t("structureNoIndexes"))).not.toBeInTheDocument();
    expect(screen.queryByText(t("structureNoForeignKeys"))).not.toBeInTheDocument();
    // シマーは aria-hidden なので、読み込み中であることは status で告知する。
    expect(screen.getByRole("status")).toHaveTextContent(t("structureLoading"));

    resolveColumns([col("id", { key: "PRI" })]);
    expect(await screen.findByText("id")).toBeInTheDocument();
    expect(screen.queryByText(t("structureLoading"))).not.toBeInTheDocument();
    expect(screen.getByText(t("structureNoIndexes"))).toBeInTheDocument();
    expect(screen.getByText(t("structureNoForeignKeys"))).toBeInTheDocument();
  });
});

describe("TableStructurePanel 被参照の外部キー (#1628)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("このテーブルを参照している外部キーを並べ、参照元テーブルの構造へ移れる", async () => {
    vi.mocked(api.describeTable).mockResolvedValueOnce([col("id", { key: "PRI" })]);
    vi.mocked(api.listIndexes).mockResolvedValueOnce([]);
    vi.mocked(api.incomingForeignKeys).mockResolvedValueOnce([
      { table: "payments", column: "order_id", referencedColumn: "id" },
      { table: "items", column: "order_id", referencedColumn: "id" },
    ]);
    const { onSelectTable } = renderPanel();
    const link = await screen.findByRole("button", { name: "items.order_id" });
    // 参照元は表名順に並ぶ。
    const names = screen
      .getAllByRole("button", { name: /^(items|payments)\.order_id$/ })
      .map((b) => b.textContent);
    expect(names).toEqual(["items.order_id", "payments.order_id"]);
    fireEvent.click(link);
    expect(onSelectTable).toHaveBeenCalledWith({ database: "app", table: "items" });
  });

  it("参照元が無ければその旨を出す。取得に失敗しても構造は出す", async () => {
    vi.mocked(api.describeTable).mockResolvedValueOnce([col("id")]);
    vi.mocked(api.listIndexes).mockResolvedValueOnce([]);
    vi.mocked(api.incomingForeignKeys).mockRejectedValueOnce(new Error("denied"));
    renderPanel();
    expect(await screen.findByText(t("structureNoIncomingForeignKeys"))).toBeInTheDocument();
  });
});
