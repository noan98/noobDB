import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chooseListboxOption, renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";

/**
 * ER 図 (#560) の失敗表示統一 (#848)。グラフ取得失敗時、裸の赤テキストではなく
 * 共有 `EmptyState` (タイトル + 再取得ボタン) で図の描画領域全体を置き換え、
 * ボタンで再取得できることを固定する。
 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      describeDatabase: vi.fn(),
      foreignKeys: vi.fn().mockResolvedValue([]),
      getObjectDefinition: vi.fn(),
    },
  };
});

import { ERDiagramView } from "../components/ERDiagramView";
import { api } from "../api/tauri";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ERDiagramView error state (#848)", () => {
  it("shows the shared EmptyState title on load failure, and retries on click", async () => {
    vi.mocked(api.describeDatabase).mockRejectedValueOnce(new Error("no such table"));

    renderWithProviders(
      <ERDiagramView
        sessionId="s1"
        driver="mysql"
        initialDatabase="appdb"
        onOpenTable={() => {}}
        onClose={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(t("erDiagramError", { error: "Error: no such table" }))).toBeInTheDocument();
    });
    expect(api.describeDatabase).toHaveBeenCalledTimes(1);

    vi.mocked(api.describeDatabase).mockResolvedValueOnce([]);
    fireEvent.click(screen.getByRole("button", { name: t("erDiagramRetry") }));

    await waitFor(() => {
      expect(api.describeDatabase).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByText(t("erDiagramEmpty"))).toBeInTheDocument();
    });
  });
});

describe("ERDiagramView フォーカス (#1540)", () => {
  const tb = (name: string) => ({
    name,
    columns: [
      {
        name: "id",
        data_type: "int",
        nullable: false,
        key: "PRI",
        default: null,
        extra: "",
        referenced_table: null,
        referenced_column: null,
      },
    ],
  });
  const fkRow = (table: string, ref: string) => ({
    table,
    column: "id",
    referenced_table: ref,
    referenced_column: "id",
    constraint_name: `${table}_${ref}`,
  });

  it("テーブルを選ぶとその近傍だけの図になり、「データベース全体」で戻る", async () => {
    // jsdom に無い ResizeObserver (React Flow が使う) の最小スタブ。
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.mocked(api.describeDatabase).mockResolvedValueOnce(["a", "b", "c", "d"].map(tb) as never);
    vi.mocked(api.foreignKeys).mockResolvedValueOnce([
      fkRow("a", "b"),
      fkRow("b", "c"),
      fkRow("c", "d"),
    ] as never);
    renderWithProviders(
      <ERDiagramView
        sessionId="s1"
        driver="mysql"
        initialDatabase="appdb"
        onOpenTable={() => {}}
        onClose={() => {}}
      />,
    );
    expect(
      await screen.findByText(t("erDiagramSummary", { tables: 4, relationships: 3 })),
    ).toBeInTheDocument();

    // 入場スタッガー (#1861): ノードに入場クラスと深さ (--stagger-index) が付く。
    await waitFor(() =>
      expect(document.querySelectorAll(".react-flow__node.flow-node-enter").length).toBe(4),
    );
    const indices = [...document.querySelectorAll<HTMLElement>(".react-flow__node")].map((el) =>
      el.style.getPropertyValue("--stagger-index"),
    );
    expect(indices.every((v) => v !== "")).toBe(true);
    expect(new Set(indices).size).toBeGreaterThan(1);

    chooseListboxOption(screen.getByLabelText(t("erDiagramFocus")), "a");
    // 1 ホップ: a と b だけ。
    expect(
      await screen.findByText(t("erDiagramSummary", { tables: 2, relationships: 1 })),
    ).toBeInTheDocument();
    chooseListboxOption(screen.getByLabelText(t("erDiagramFocusHops")), "2");
    expect(
      await screen.findByText(t("erDiagramSummary", { tables: 3, relationships: 2 })),
    ).toBeInTheDocument();

    chooseListboxOption(screen.getByLabelText(t("erDiagramFocus")), "");
    expect(
      await screen.findByText(t("erDiagramSummary", { tables: 4, relationships: 3 })),
    ).toBeInTheDocument();
    // フォーカスの切り替えで DB を取り直さない。
    expect(api.describeDatabase).toHaveBeenCalledTimes(1);
  });
});

describe("ERDiagramView 配置の保存とノードの右クリックメニュー (#1628)", () => {
  const tbl = (name: string) => ({
    name,
    columns: [
      {
        name: "id",
        data_type: "int",
        nullable: false,
        key: "PRI",
        default: null,
        extra: "",
        referenced_table: null,
        referenced_column: null,
      },
    ],
  });
  const stubRo = () =>
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  const mount = (
    onGenerateDoc?: (db: string, tables: string[]) => void,
    onInsertSql?: (sql: string) => void,
  ) =>
    renderWithProviders(
      <ERDiagramView
        sessionId="s1"
        driver="mysql"
        initialDatabase="appdb"
        connectionKey="p1"
        onOpenTable={() => {}}
        onGenerateDoc={onGenerateDoc}
        onInsertSql={onInsertSql}
        onClose={() => {}}
      />,
    );

  beforeEach(() => {
    localStorage.clear();
  });

  it("保存済みの位置があればノードがその位置に置かれ、リセットで消える", async () => {
    stubRo();
    localStorage.setItem(
      "noobdb.erPositions.v1",
      JSON.stringify({
        [JSON.stringify(["p1", "appdb"])]: {
          direction: "LR",
          density: "comfortable",
          positions: { alpha: { x: 321, y: 654 } },
        },
      }),
    );
    vi.mocked(api.describeDatabase).mockResolvedValueOnce(["alpha", "beta"].map(tbl) as never);
    vi.mocked(api.foreignKeys).mockResolvedValueOnce([] as never);
    const { container } = mount();
    await screen.findByText(t("erDiagramSummary", { tables: 2, relationships: 0 }));
    await waitFor(() => expect(container.querySelector(".react-flow__node")).not.toBeNull());
    const alpha = container.querySelector('.react-flow__node[data-id="alpha"]') as HTMLElement;
    expect(alpha.style.transform).toContain("translate(321px,654px)");
    fireEvent.click(screen.getByRole("button", { name: t("erDiagramResetLayout") }));
    await waitFor(() => {
      const moved = container.querySelector('.react-flow__node[data-id="alpha"]') as HTMLElement;
      expect(moved.style.transform).not.toContain("translate(321px,654px)");
    });
    expect(localStorage.getItem("noobdb.erPositions.v1")).not.toContain("321");
    expect(screen.queryByRole("button", { name: t("erDiagramResetLayout") })).toBeNull();
  });

  it("ノードを右クリックするとメニューが出て、AI ドキュメントはそのテーブルだけで呼ばれる", async () => {
    stubRo();
    vi.mocked(api.describeDatabase).mockResolvedValueOnce(["alpha", "beta"].map(tbl) as never);
    vi.mocked(api.foreignKeys).mockResolvedValueOnce([] as never);
    const onDoc = vi.fn();
    const { container } = mount(onDoc);
    await screen.findByText(t("erDiagramSummary", { tables: 2, relationships: 0 }));
    await waitFor(() => expect(container.querySelector(".react-flow__node")).not.toBeNull());
    fireEvent.contextMenu(container.querySelector('.react-flow__node[data-id="beta"]') as HTMLElement);
    expect(await screen.findByRole("menuitem", { name: t("erDiagramMenuOpenTable") })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: t("contextMenuCopyTableName") })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: t("erDiagramMenuFocusTable") }));
    expect(
      await screen.findByText(t("erDiagramSummary", { tables: 1, relationships: 0 })),
    ).toBeInTheDocument();
    fireEvent.contextMenu(container.querySelector('.react-flow__node[data-id="beta"]') as HTMLElement);
    fireEvent.click(await screen.findByRole("menuitem", { name: t("erDiagramMenuDocTable") }));
    expect(onDoc).toHaveBeenCalledWith("appdb", ["beta"]);
  });

  it("SELECT 文をエディタへ渡し、DDL をコピーし、強調を固定できる", async () => {
    stubRo();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    vi.mocked(api.describeDatabase).mockResolvedValueOnce(["alpha", "beta"].map(tbl) as never);
    vi.mocked(api.foreignKeys).mockResolvedValueOnce([
      {
        table: "alpha",
        column: "id",
        referenced_table: "beta",
        referenced_column: "id",
        constraint_name: "fk",
      },
    ] as never);
    vi.mocked(api.getObjectDefinition).mockResolvedValueOnce("CREATE TABLE alpha (id int)");
    const onInsert = vi.fn();
    const { container } = mount(undefined, onInsert);
    await screen.findByText(t("erDiagramSummary", { tables: 2, relationships: 1 }));
    await waitFor(() => expect(container.querySelector(".react-flow__node")).not.toBeNull());

    fireEvent.contextMenu(container.querySelector('.react-flow__node[data-id="alpha"]') as HTMLElement);
    fireEvent.click(await screen.findByRole("menuitem", { name: t("erDiagramMenuCopyDdl") }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("CREATE TABLE alpha (id int)"));
    expect(api.getObjectDefinition).toHaveBeenCalledWith("s1", "appdb", "table", "alpha", null);

    fireEvent.contextMenu(container.querySelector('.react-flow__node[data-id="alpha"]') as HTMLElement);
    fireEvent.click(await screen.findByRole("menuitem", { name: t("erDiagramMenuPin") }));
    await waitFor(() =>
      expect(container.querySelector('.react-flow__node[data-id="alpha"]')?.className).toContain("er-hl"),
    );
    expect(container.querySelector('.react-flow__node[data-id="beta"]')?.className).toContain("er-hl");

    fireEvent.contextMenu(container.querySelector('.react-flow__node[data-id="beta"]') as HTMLElement);
    fireEvent.click(await screen.findByRole("menuitem", { name: t("erDiagramMenuSelectSql") }));
    expect(onInsert).toHaveBeenCalledWith("SELECT * FROM `appdb`.`beta`");
  });
});

describe("ERDiagramView loading skeleton (#1834)", () => {
  it("shows the node-graph skeleton with a status message while loading, then removes it", async () => {
    let resolve: (v: never) => void = () => {};
    vi.mocked(api.describeDatabase).mockReturnValueOnce(new Promise((r) => (resolve = r as never)));
    const { container } = renderWithProviders(
      <ERDiagramView
        sessionId="s1"
        driver="mysql"
        initialDatabase="appdb"
        onOpenTable={() => {}}
        onClose={() => {}}
      />,
    );
    expect(await screen.findByTestId("er-graph-skeleton")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("status")).toHaveTextContent(t("erDiagramLoading"));
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    resolve([] as never);
    await waitFor(() => expect(screen.queryByTestId("er-graph-skeleton")).toBeNull());
  });
});
