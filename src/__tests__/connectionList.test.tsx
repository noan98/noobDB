import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, fireEvent } from "./testUtils";
import { ConnectionList } from "../components/ConnectionList";
import { makeProfile } from "./fixtures/componentFixtures";
import { t } from "../i18n";

/**
 * 接続一覧サイドパネル (#604)。マウント時のスキーマ取得 (`listDatabases`) は
 * `sessionId` が truthy のときだけ走るため、`sessionId={null}` を渡せば Tauri 呼び出し
 * なしでレンダリングできる。プロファイル 0 件で空状態が出ること、プロファイルを
 * 与えると各名前が可視であること・作成導線で `onCreate` が呼ばれることを固定する。
 */
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
