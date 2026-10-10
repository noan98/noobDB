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

  describe("inline rename (#1390)", () => {
    const renameTabs: TabInfo[] = [
      { id: "t1", kind: "query", title: "Query 1", renamable: true },
      { id: "t2", kind: "table", title: "users", database: "appdb", table: "users" },
    ];
    function setup(renamingId: string | null = null) {
      const cb = { start: vi.fn(), commit: vi.fn(), cancel: vi.fn(), select: vi.fn(), close: vi.fn() };
      renderWithProviders(
        <TabBar
          tabs={renameTabs}
          activeTabId="t1"
          onSelect={cb.select}
          onClose={cb.close}
          onNew={() => {}}
          renamingId={renamingId}
          onRenameStart={cb.start}
          onRenameCommit={cb.commit}
          onRenameCancel={cb.cancel}
        />,
      );
      return cb;
    }

    it("renamable なタブのタイトルをダブルクリックすると開始する", () => {
      const cb = setup();
      fireEvent.doubleClick(screen.getByText("Query 1"));
      expect(cb.start).toHaveBeenCalledWith("t1");
    });
    it("table タブはダブルクリックしても開始しない", () => {
      const cb = setup();
      fireEvent.doubleClick(screen.getByText("users"));
      expect(cb.start).not.toHaveBeenCalled();
    });
    it("編集中は入力欄が出て、Enter で確定する (タブ側のキー操作へ伝えない)", () => {
      const cb = setup("t1");
      const input = screen.getByRole("textbox", { name: t("tabRenameAria") });
      expect(input).toHaveValue("Query 1");
      fireEvent.change(input, { target: { value: "集計" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(cb.commit).toHaveBeenCalledWith("t1", "集計");
      expect(cb.select).not.toHaveBeenCalled();
      // blur が続いても二重に確定しない
      fireEvent.blur(input);
      expect(cb.commit).toHaveBeenCalledOnce();
    });
    it("Esc でキャンセルし、確定しない", () => {
      const cb = setup("t1");
      const input = screen.getByRole("textbox", { name: t("tabRenameAria") });
      fireEvent.change(input, { target: { value: "x" } });
      fireEvent.keyDown(input, { key: "Escape" });
      fireEvent.blur(input);
      expect(cb.cancel).toHaveBeenCalledOnce();
      expect(cb.commit).not.toHaveBeenCalled();
    });
    it("Delete / Backspace は入力欄で閉じる操作にならない", () => {
      const cb = setup("t1");
      const input = screen.getByRole("textbox", { name: t("tabRenameAria") });
      fireEvent.keyDown(input, { key: "Backspace" });
      fireEvent.keyDown(input, { key: "Delete" });
      expect(cb.close).not.toHaveBeenCalled();
    });
    it("フォーカスが外れたら確定する", () => {
      const cb = setup("t1");
      const input = screen.getByRole("textbox", { name: t("tabRenameAria") });
      fireEvent.change(input, { target: { value: "y" } });
      fireEvent.blur(input);
      expect(cb.commit).toHaveBeenCalledWith("t1", "y");
    });
  });
});
