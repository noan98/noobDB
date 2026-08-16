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
  return {
    ...actual,
    api: {
      ...actual.api,
      listDatabases: vi.fn().mockResolvedValue(["db1"]),
      listTables: vi.fn().mockResolvedValue(["tbl1", "tbl2"]),
      tableRowEstimates: vi.fn().mockResolvedValue([]),
      listSchemaObjects: vi.fn().mockResolvedValue([]),
    },
  };
});

import { ConnectionList } from "../components/ConnectionList";

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
