import { describe, it, expect, vi, beforeAll } from "vitest";
import { renderWithProviders, screen, fireEvent } from "./testUtils";
import { TabBar, type TabInfo } from "../components/TabBar";
import { t } from "../i18n";

/**
 * タブバー (#604)。Tauri 呼び出しは持たないが、マウント effect で `ResizeObserver`
 * を生成するため jsdom 用にスタブする。タブ群が `role="tab"` として描画され、
 * 新規タブボタンで `onNew` が呼ばれること・タブ選択で `onSelect` が呼ばれることを
 * 固定する。
 */
beforeAll(() => {
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  // jsdom は Element.scrollIntoView を実装しないため、アクティブタブを可視化する
  // マウント effect が落ちないよう no-op を差す。
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

const TABS: TabInfo[] = [
  { id: "t1", kind: "query", title: "Query 1" },
  { id: "t2", kind: "table", title: "users", database: "appdb", table: "users" },
];

describe("TabBar render smoke (#604)", () => {
  it("renders a tab per entry and a new-tab control", () => {
    renderWithProviders(
      <TabBar
        tabs={TABS}
        activeTabId="t1"
        onSelect={() => {}}
        onClose={() => {}}
        onNew={() => {}}
      />,
    );
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByText("Query 1")).toBeInTheDocument();
    expect(screen.getByText("users")).toBeInTheDocument();
  });

  it("invokes onNew when the new-tab button is clicked", () => {
    const onNew = vi.fn();
    renderWithProviders(
      <TabBar
        tabs={TABS}
        activeTabId="t1"
        onSelect={() => {}}
        onClose={() => {}}
        onNew={onNew}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: t("tabNew") }));
    expect(onNew).toHaveBeenCalledOnce();
  });
});

describe("TabBar rename (#1390)", () => {
  function setup(renamingTabId: string | null = "t1") {
    const fns = {
      onClose: vi.fn(),
      onSelect: vi.fn(),
      onRename: vi.fn(),
      onRenameCancel: vi.fn(),
      onRenameRequest: vi.fn(),
    };
    renderWithProviders(
      <TabBar
        tabs={TABS}
        activeTabId="t1"
        onNew={() => {}}
        renamingTabId={renamingTabId}
        {...fns}
      />,
    );
    return fns;
  }

  it("ダブルクリックで query タブのリネームを要求し、table タブでは要求しない", () => {
    const fns = setup(null);
    fireEvent.doubleClick(screen.getByText("Query 1"));
    expect(fns.onRenameRequest).toHaveBeenCalledWith("t1");
    fireEvent.doubleClick(screen.getByText("users"));
    expect(fns.onRenameRequest).toHaveBeenCalledTimes(1);
  });

  it("Enter で確定し、続く blur では二重に確定しない", () => {
    const fns = setup();
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "月次" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    expect(fns.onRename).toHaveBeenCalledTimes(1);
    expect(fns.onRename).toHaveBeenCalledWith("t1", "月次");
  });

  it("Esc で取り消し、確定しない", () => {
    const fns = setup();
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "x" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    expect(fns.onRenameCancel).toHaveBeenCalledTimes(1);
    expect(fns.onRename).not.toHaveBeenCalled();
  });

  it("blur で確定し、空文字もそのまま渡す (自動命名へ戻す指示)", () => {
    const fns = setup();
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(fns.onRename).toHaveBeenCalledWith("t1", "");
  });

  it("編集中の Delete / Backspace / 中クリックでタブを閉じない", () => {
    const fns = setup();
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Delete" });
    fireEvent.keyDown(input, { key: "Backspace" });
    fireEvent.mouseDown(input, { button: 1 });
    expect(fns.onClose).not.toHaveBeenCalled();
  });
});

