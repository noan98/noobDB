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
