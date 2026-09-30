import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { makeProfile } from "./fixtures/componentFixtures";
import { t } from "../i18n";

/**
 * 接続一覧サイドパネル (#604)。マウント時のスキーマ取得 (`listDatabases`) は
 * `sessionId` が truthy のときだけ走るため、`sessionId={null}` を渡せば Tauri 呼び出し
 * なしでレンダリングできる。プロファイル 0 件で空状態が出ること、プロファイルを
 * 与えると各名前が可視であること・作成導線で `onCreate` が呼ばれることを固定する。
 *
 * アクティブテーブル行の「現在地」表示 (#982) を検証するテストはスキーマツリーの
 * 展開が要るため `sessionId` を与え、`api` をモックする。モジュール全体を
 * モックしても他のテスト (`sessionId: null`) には影響しない。
 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  const listDatabases = vi.fn().mockResolvedValue(["db1"]);
  const listTables = vi.fn().mockResolvedValue(["tbl1", "tbl2"]);
  const tableRowEstimates = vi.fn().mockResolvedValue([]);
  const listSchemaObjects = vi.fn().mockResolvedValue([]);
  const describeTable = vi.fn().mockResolvedValue([]);
  const listIndexes = vi.fn().mockResolvedValue([]);
  return {
    ...actual,
    api: {
      ...actual.api,
      listDatabases,
      listTables,
      tableRowEstimates,
      listSchemaObjects,
      describeTable,
      listIndexes,
      // 集約 IPC (#1263) は、個別 IPC のモックから同じ内容を組み立てて返す。
      // テストが個別モックへ仕込む値 (`mockResolvedValueOnce`) がそのまま効く。
      loadSchemaTree: vi.fn(async (sid: string, openDbs: string[], openKeys: string[]) => {
        const databases: string[] = await listDatabases(sid);
        const open = await Promise.all(
          openDbs
            .filter((db) => databases.includes(db))
            .map(async (db) => ({
              database: db,
              tables: (await listTables(sid, db)) as string[],
              row_estimates: await tableRowEstimates(sid, db),
              objects: await listSchemaObjects(sid, db),
              comments: [],
            })),
        );
        const tables = await Promise.all(
          openKeys.map(async (key) => {
            const sep = key.indexOf("::");
            return {
              key,
              columns: await describeTable(sid, key.slice(0, sep), key.slice(sep + 2)),
              indexes: await listIndexes(sid, key.slice(0, sep), key.slice(sep + 2)),
            };
          }),
        );
        return { databases, open, tables };
      }),
      listTablesAll: vi.fn(async (sid: string) => {
        const databases: string[] = await listDatabases(sid);
        return Promise.all(
          databases.map(async (database) => ({
            database,
            tables: (await listTables(sid, database)) as string[],
          })),
        );
      }),
    },
  };
});

import { ConnectionList } from "../components/ConnectionList";
import { api } from "../api/tauri";

const noop = () => {};
const baseProps = {
  activeProfileId: null,
  sessionId: null,
  connectingId: null,
  errorProfileId: null,
  onConnect: noop,
  onCreate: noop,
  onEdit: noop,
  onDuplicate: noop,
  onDelete: noop,
  onPickTable: noop,
  onImportTable: noop,
  onDumpDatabase: noop,
  onRunTableSelect: noop,
  onInsertTableSelect: noop,
  selectLimit: 200,
};

describe("ConnectionList render smoke (#604)", () => {
  it("shows the empty state when there are no profiles", () => {
    renderWithProviders(<ConnectionList {...baseProps} profiles={[]} />);
    expect(screen.getByText(t("listEmptyTitle"))).toBeInTheDocument();
  });

  it("lists each profile name", () => {
    const profiles = [
      makeProfile({ id: "p-a", name: "Alpha DB" }),
      makeProfile({ id: "p-b", name: "Beta DB" }),
    ];
    renderWithProviders(<ConnectionList {...baseProps} profiles={profiles} />);
    expect(screen.getByText("Alpha DB")).toBeInTheDocument();
    expect(screen.getByText("Beta DB")).toBeInTheDocument();
  });

  it("invokes onCreate from the empty-state action", () => {
    const onCreate = vi.fn();
    renderWithProviders(
      <ConnectionList {...baseProps} profiles={[]} onCreate={onCreate} />,
    );
    fireEvent.click(screen.getByText(t("listCreateFirst")));
    expect(onCreate).toHaveBeenCalledOnce();
  });

  // ドラッグ並べ替えのドロップ位置マーカー (#1007)。キーボード移動
  // (Ctrl/Cmd+Shift+↑/↓) が TabBar と同じ着地位置マーカーを表示すること・並べ替え
  // 自体 (`onReorderProfiles` への通知) が退行しないことを固定する。
  it("shows the drop-position marker and reorders on keyboard move", () => {
    const onReorderProfiles = vi.fn();
    const profiles = [
      makeProfile({ id: "p-a", name: "Alpha DB" }),
      makeProfile({ id: "p-b", name: "Beta DB" }),
    ];
    const { container } = renderWithProviders(
      <ConnectionList {...baseProps} profiles={profiles} onReorderProfiles={onReorderProfiles} />,
    );
    const rows = screen.getAllByRole("treeitem");
    expect(rows).toHaveLength(2);
    const markersBefore = container.querySelectorAll('[aria-hidden="true"]').length;

    fireEvent.keyDown(rows[0], { key: "ArrowDown", ctrlKey: true, shiftKey: true });

    expect(onReorderProfiles).toHaveBeenCalledWith(["p-b", "p-a"]);
    const markersAfter = container.querySelectorAll('[aria-hidden="true"]').length;
    expect(markersAfter).toBe(markersBefore + 1);
  });
});

describe("ConnectionList のアクティブテーブル行インジケータ (#982)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("activeTable と一致するテーブル行にだけ aria-current を付与する", async () => {
    const profile = makeProfile({ id: "p-a", name: "Alpha DB" });
    renderWithProviders(
      <ConnectionList
        {...baseProps}
        profiles={[profile]}
        activeProfileId="p-a"
        sessionId="s1"
        activeTable={{ database: "db1", table: "tbl1" }}
      />,
    );

    // DB ノードが読み込まれるまで待ち、クリックしてテーブル一覧を展開する。
    const dbRow = await screen.findByRole("treeitem", { name: "db1" });
    fireEvent.click(dbRow);

    const activeRow = await screen.findByRole("treeitem", { name: "tbl1" });
    const inactiveRow = await screen.findByRole("treeitem", { name: "tbl2" });

    await waitFor(() => {
      expect(activeRow).toHaveAttribute("aria-current", "true");
    });
    expect(inactiveRow).not.toHaveAttribute("aria-current");
  });

  it("activeTable が未指定なら、どのテーブル行にも aria-current を付けない", async () => {
    const profile = makeProfile({ id: "p-a", name: "Alpha DB" });
    renderWithProviders(
      <ConnectionList
        {...baseProps}
        profiles={[profile]}
        activeProfileId="p-a"
        sessionId="s1"
        activeTable={null}
      />,
    );

    const dbRow = await screen.findByRole("treeitem", { name: "db1" });
    fireEvent.click(dbRow);

    const row1 = await screen.findByRole("treeitem", { name: "tbl1" });
    const row2 = await screen.findByRole("treeitem", { name: "tbl2" });
    expect(row1).not.toHaveAttribute("aria-current");
    expect(row2).not.toHaveAttribute("aria-current");
  });
});

describe("Database Explorer の階層 (#1112)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  async function openDb(props: Partial<Parameters<typeof ConnectionList>[0]> = {}) {
    const profile = makeProfile({ id: "p-a", name: "Alpha DB" });
    renderWithProviders(
      <ConnectionList
        {...baseProps}
        profiles={[profile]}
        activeProfileId="p-a"
        sessionId="s1"
        onOpenObjectDefinition={noop}
        {...props}
      />,
    );
    fireEvent.click(await screen.findByRole("treeitem", { name: "db1" }));
  }

  it("ビューはテーブル一覧から外れて「ビュー」グループに 1 回だけ並ぶ", async () => {
    vi.mocked(api.listTables).mockResolvedValueOnce(["tbl1", "v1"]);
    vi.mocked(api.listSchemaObjects).mockResolvedValueOnce([{ kind: "view", name: "v1", id: null }]);
    await openDb();

    await screen.findByText(t("objGroupViews"));
    expect(screen.getByText(t("objGroupTables"))).toBeInTheDocument();
    expect(screen.getAllByRole("treeitem", { name: "v1" })).toHaveLength(1);
    expect(screen.getByRole("treeitem", { name: "tbl1" })).toBeInTheDocument();
  });

  it("テーブルの右クリックは先頭に「データを開く」「構造を表示」を出す", async () => {
    const onPickTable = vi.fn();
    const onOpenStructure = vi.fn();
    await openDb({ onPickTable, onOpenStructure });

    const row = await screen.findByRole("treeitem", { name: "tbl1" });
    fireEvent.contextMenu(row);
    const items = await screen.findAllByRole("menuitem");
    expect(items[0]).toHaveTextContent(t("contextMenuOpenData"));
    expect(items[1]).toHaveTextContent(t("contextMenuOpenStructure"));
    fireEvent.click(items[1]);
    expect(onOpenStructure).toHaveBeenCalledWith("db1", "tbl1");

    fireEvent.contextMenu(row);
    fireEvent.click((await screen.findAllByRole("menuitem"))[0]);
    expect(onPickTable).toHaveBeenCalledWith("db1", "tbl1");
  });

  it("テーブルを展開すると列・インデックス・外部キーのグループが並び、外部キーから参照先を開ける", async () => {
    vi.mocked(api.describeTable).mockResolvedValueOnce([
      col("id", { key: "PRI" }),
      col("user_id", { referenced_table: "users", referenced_column: "id" }),
    ]);
    vi.mocked(api.listIndexes).mockResolvedValueOnce([
      { name: "PRIMARY", columns: ["id"], unique: true, primary: true, method: null },
    ]);
    const onPickTable = vi.fn();
    await openDb({ onPickTable });

    await screen.findByRole("treeitem", { name: "tbl1" });
    fireEvent.click(screen.getByRole("button", { name: t("treeToggleColumnsAria", { table: "tbl1" }) }));

    const fkRow = await screen.findByRole("treeitem", { name: "user_id → users.id" });
    expect(screen.getByText(t("treeColumnsLabel"))).toBeInTheDocument();
    expect(screen.getByText(t("indexesLabel"))).toBeInTheDocument();
    expect(screen.getByText(t("treeForeignKeysLabel"))).toBeInTheDocument();
    fireEvent.click(fkRow);
    expect(onPickTable).toHaveBeenCalledWith("db1", "users");
  });
});

describe("スキーマツリーのキーボード操作 (#1184)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 展開状態は `schemaTreeState.ts` 経由で localStorage に永続化される
    // (プロファイル id 固定でテストしているため、前のテストの展開状態が
    // 漏れないようにクリアする)。
    localStorage.clear();
  });

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

  async function openDb(props: Partial<Parameters<typeof ConnectionList>[0]> = {}) {
    const profile = makeProfile({ id: "p-a", name: "Alpha DB" });
    renderWithProviders(
      <ConnectionList
        {...baseProps}
        profiles={[profile]}
        activeProfileId="p-a"
        sessionId="s1"
        onOpenObjectDefinition={noop}
        {...props}
      />,
    );
    fireEvent.click(await screen.findByRole("treeitem", { name: "db1" }));
  }

  it("行ごとの aria-level が階層の深さどおりに付く (プロファイル < db < テーブル < カラム)", async () => {
    vi.mocked(api.describeTable).mockResolvedValueOnce([col("id", { key: "PRI" })]);
    await openDb();
    const profileRow = screen.getByRole("treeitem", { name: /Alpha DB/ });
    const dbRow = await screen.findByRole("treeitem", { name: "db1" });
    const tblRow = await screen.findByRole("treeitem", { name: "tbl1" });
    fireEvent.click(screen.getByRole("button", { name: t("treeToggleColumnsAria", { table: "tbl1" }) }));
    const colRow = await screen.findByRole("treeitem", { name: /id/ });

    expect(profileRow).toHaveAttribute("aria-level", "1");
    expect(dbRow).toHaveAttribute("aria-level", "2");
    expect(tblRow).toHaveAttribute("aria-level", "3");
    expect(colRow).toHaveAttribute("aria-level", "4");
  });

  it("roving tabindex: 常にちょうど 1 行だけが tabIndex=0 で、フォーカスした行に追従する", async () => {
    await openDb();
    const dbRow = await screen.findByRole("treeitem", { name: "db1" });
    const tblRow = await screen.findByRole("treeitem", { name: "tbl1" });

    const zeroTabIndexCount = () =>
      screen.getAllByRole("treeitem").filter((el) => el.getAttribute("tabindex") === "0").length;

    expect(zeroTabIndexCount()).toBe(1);
    fireEvent.focus(tblRow);
    expect(tblRow).toHaveAttribute("tabindex", "0");
    expect(dbRow).toHaveAttribute("tabindex", "-1");
    expect(zeroTabIndexCount()).toBe(1);
  });

  it("ArrowDown/ArrowUp で兄弟行へフォーカスが移動する", async () => {
    await openDb();
    const dbRow = await screen.findByRole("treeitem", { name: "db1" });
    const tbl1 = await screen.findByRole("treeitem", { name: "tbl1" });
    const tbl2 = await screen.findByRole("treeitem", { name: "tbl2" });

    // `useRovingFocus` は `document.activeElement` を見て移動するため、
    // `keyboardNav.test.tsx` と同じく先に対象行へ実フォーカスを当てる。
    dbRow.focus();
    fireEvent.keyDown(dbRow, { key: "ArrowDown" });
    expect(tbl1).toHaveFocus();

    fireEvent.keyDown(tbl1, { key: "ArrowDown" });
    expect(tbl2).toHaveFocus();

    fireEvent.keyDown(tbl2, { key: "ArrowUp" });
    expect(tbl1).toHaveFocus();
  });

  it("ArrowRight は折りたたみ中のテーブルを展開し、展開済みなら最初のカラムへフォーカスを移す", async () => {
    vi.mocked(api.describeTable).mockResolvedValueOnce([col("id", { key: "PRI" })]);
    await openDb();
    const tblRow = await screen.findByRole("treeitem", { name: "tbl1" });

    fireEvent.keyDown(tblRow, { key: "ArrowRight" });
    await waitFor(() => expect(tblRow).toHaveAttribute("aria-expanded", "true"));
    // 展開直後はまだ行自体にフォーカスがある (トグルのみ、移動はしない)。
    expect(tblRow).toHaveFocus();

    const colRow = await screen.findByRole("treeitem", { name: /id/ });
    fireEvent.keyDown(tblRow, { key: "ArrowRight" });
    expect(colRow).toHaveFocus();
  });

  it("ArrowLeft は展開済みノードを折りたたみ、折りたたみ済み/葉では親へフォーカスを移す", async () => {
    vi.mocked(api.describeTable).mockResolvedValueOnce([col("id", { key: "PRI" })]);
    await openDb();
    const tblRow = await screen.findByRole("treeitem", { name: "tbl1" });
    fireEvent.click(screen.getByRole("button", { name: t("treeToggleColumnsAria", { table: "tbl1" }) }));
    const colRow = await screen.findByRole("treeitem", { name: /id/ });

    fireEvent.keyDown(colRow, { key: "ArrowLeft" });
    expect(tblRow).toHaveFocus();

    fireEvent.keyDown(tblRow, { key: "ArrowLeft" });
    expect(tblRow).toHaveAttribute("aria-expanded", "false");
    expect(tblRow).toHaveFocus();

    const dbRow = screen.getByRole("treeitem", { name: "db1" });
    fireEvent.keyDown(tblRow, { key: "ArrowLeft" });
    expect(dbRow).toHaveFocus();
  });

  it("Enter/Space でテーブル行を実行 (onPickTable) できる", async () => {
    const onPickTable = vi.fn();
    await openDb({ onPickTable });
    const tblRow = await screen.findByRole("treeitem", { name: "tbl1" });

    fireEvent.keyDown(tblRow, { key: "Enter" });
    expect(onPickTable).toHaveBeenCalledWith("db1", "tbl1");
  });

  it("行の中のチェブロン button の Enter は行の実行に横取りされない (ネイティブのクリックで開閉させる)", async () => {
    const onPickTable = vi.fn();
    await openDb({ onPickTable });
    await screen.findByRole("treeitem", { name: "tbl1" });
    const chevron = screen.getByRole("button", { name: t("treeToggleColumnsAria", { table: "tbl1" }) });

    // preventDefault されていなければ fireEvent は true を返す (= ブラウザの既定動作である
    // button の click が起きる)。
    expect(fireEvent.keyDown(chevron, { key: "Enter" })).toBe(true);
    expect(onPickTable).not.toHaveBeenCalled();
  });
});

describe("スキーマツリーのコンテキストメニューをキーボードから開く (Shift+F10 / メニューキー、#1185)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  async function openDb(props: Partial<Parameters<typeof ConnectionList>[0]> = {}) {
    const profile = makeProfile({ id: "p-a", name: "Alpha DB" });
    renderWithProviders(
      <ConnectionList
        {...baseProps}
        profiles={[profile]}
        activeProfileId="p-a"
        sessionId="s1"
        onOpenObjectDefinition={noop}
        {...props}
      />,
    );
    fireEvent.click(await screen.findByRole("treeitem", { name: "db1" }));
  }

  it("Shift+F10 でフォーカス中のテーブル行の右クリックメニューが開く", async () => {
    const onPickTable = vi.fn();
    const onOpenStructure = vi.fn();
    await openDb({ onPickTable, onOpenStructure });
    const row = await screen.findByRole("treeitem", { name: "tbl1" });

    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    const items = await screen.findAllByRole("menuitem");
    expect(items[0]).toHaveTextContent(t("contextMenuOpenData"));
    expect(items[1]).toHaveTextContent(t("contextMenuOpenStructure"));
  });

  it("ContextMenu キーでも DB 行の右クリックメニューが開く", async () => {
    await openDb();
    const row = await screen.findByRole("treeitem", { name: "db1" });

    fireEvent.keyDown(row, { key: "ContextMenu" });
    expect(await screen.findByRole("menuitem", { name: t("contextMenuDump") })).toBeInTheDocument();
  });

  it("Esc で閉じるとフォーカスが元の行へ戻る", async () => {
    await openDb();
    const row = await screen.findByRole("treeitem", { name: "tbl1" });
    // `useReturnFocus` は実際の DOM フォーカスを記憶するため、実際に `.focus()` する。
    row.focus();

    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    await screen.findAllByRole("menuitem");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(row);
  });

  it("IME 変換中の ContextMenu キーは無視する", async () => {
    await openDb();
    const row = await screen.findByRole("treeitem", { name: "tbl1" });

    fireEvent.keyDown(row, { key: "ContextMenu", isComposing: true });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("メニューを持たない行 (外部キー) では何も開かない", async () => {
    vi.mocked(api.describeTable).mockResolvedValueOnce([
      { name: "id", data_type: "int", nullable: false, key: "PRI", default: null, extra: "", referenced_table: null, referenced_column: null },
      { name: "user_id", data_type: "int", nullable: false, key: "", default: null, extra: "", referenced_table: "users", referenced_column: "id" },
    ]);
    await openDb();
    await screen.findByRole("treeitem", { name: "tbl1" });
    fireEvent.click(screen.getByRole("button", { name: t("treeToggleColumnsAria", { table: "tbl1" }) }));
    const fkRow = await screen.findByRole("treeitem", { name: "user_id → users.id" });

    fireEvent.keyDown(fkRow, { key: "F10", shiftKey: true });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

describe("スキーマツリーの IPC 集約 (#1263)", () => {
  it("接続時のツリー復元は load_schema_tree を 1 回だけ呼び、個別 IPC を直接叩かない", async () => {
    vi.mocked(api.loadSchemaTree).mockClear();
    vi.mocked(api.listTablesAll).mockClear();
    const profile = makeProfile({ id: "p-1263", name: "Alpha DB" });
    renderWithProviders(
      <ConnectionList {...baseProps} profiles={[profile]} activeProfileId="p-1263" sessionId="s-tree" />,
    );
    await screen.findByRole("treeitem", { name: "db1" });
    expect(api.loadSchemaTree).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.loadSchemaTree).mock.calls[0][0]).toBe("s-tree");
  });

  it("スキーマ検索は全 DB のテーブル一覧を list_tables_all 1 回で取得して一致を表示する", async () => {
    vi.mocked(api.listTablesAll).mockClear();
    const profile = makeProfile({ id: "p-1263", name: "Alpha DB" });
    renderWithProviders(
      <ConnectionList {...baseProps} profiles={[profile]} activeProfileId="p-1263" sessionId="s-search" />,
    );
    await screen.findByRole("treeitem", { name: "db1" });
    fireEvent.change(screen.getByPlaceholderText(t("listSearchPlaceholder")), {
      target: { value: "tbl2" },
    });
    await screen.findByRole("treeitem", { name: "tbl2" });
    expect(api.listTablesAll).toHaveBeenCalledTimes(1);
  });
});
