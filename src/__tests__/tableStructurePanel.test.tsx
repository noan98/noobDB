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
      listIndexes: vi.fn(),
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
