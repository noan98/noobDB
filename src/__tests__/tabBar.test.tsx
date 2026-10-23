import { describe, it, expect, vi, beforeAll } from "vitest";
import { renderWithProviders, screen, fireEvent } from "./testUtils";
import { TabBar, sameTabInfo, type TabInfo } from "../components/TabBar";
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
      <TabBar tabs={TABS} activeTabId="t1" onSelect={() => {}} onClose={() => {}} onNew={() => {}} />,
    );
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByText("Query 1")).toBeInTheDocument();
    expect(screen.getByText("users")).toBeInTheDocument();
  });

  it("invokes onNew when the new-tab button is clicked", () => {
    const onNew = vi.fn();
    renderWithProviders(
      <TabBar tabs={TABS} activeTabId="t1" onSelect={() => {}} onClose={() => {}} onNew={onNew} />,
    );
    fireEvent.click(screen.getByRole("button", { name: t("tabNew") }));
    expect(onNew).toHaveBeenCalledOnce();
  });
});

describe("TabBar 追従スクロール (#1832)", () => {
  it("マウント直後は即時、アクティブタブ切替は inline: nearest 込みの smooth", () => {
    let t = 1e9;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => (t += 1000));
    const scroll = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    try {
      const props = { tabs: TABS, onSelect: () => {}, onClose: () => {}, onNew: () => {} };
      const { rerender } = renderWithProviders(<TabBar {...props} activeTabId="t1" />);
      expect(scroll).toHaveBeenLastCalledWith({ inline: "nearest", block: "nearest", behavior: "auto" });
      rerender(<TabBar {...props} activeTabId="t2" />);
      expect(scroll).toHaveBeenLastCalledWith({ inline: "nearest", block: "nearest", behavior: "smooth" });
    } finally {
      Element.prototype.scrollIntoView = original;
      clock.mockRestore();
    }
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
      <TabBar tabs={TABS} activeTabId="t1" onNew={() => {}} renamingTabId={renamingTabId} {...fns} />,
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

  it("未編集のまま blur / Enter では確定せず取消扱い", () => {
    const fns = setup();
    const input = screen.getByRole("textbox");
    fireEvent.blur(input);
    expect(fns.onRename).not.toHaveBeenCalled();
    expect(fns.onRenameCancel).toHaveBeenCalledTimes(1);
  });

  it("blur 確定ではタブへフォーカスを戻さず、Enter 確定では戻す", async () => {
    const fns = setup();
    const tab = screen.getAllByRole("tab")[0];
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "a" } });
    fireEvent.blur(input);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(fns.onRename).toHaveBeenCalledWith("t1", "a");
    expect(document.activeElement).not.toBe(tab);
  });

  it("Enter 確定ではタブへフォーカスを戻す", async () => {
    setup();
    const tab = screen.getAllByRole("tab")[0];
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "a" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(document.activeElement).toBe(tab);
  });

  it("F2 で query タブのリネームを開始し、table タブでは開始しない", () => {
    const fns = setup(null);
    const [q, tbl] = screen.getAllByRole("tab");
    fireEvent.keyDown(q, { key: "F2" });
    expect(fns.onRenameRequest).toHaveBeenCalledWith("t1");
    fireEvent.keyDown(tbl, { key: "F2" });
    expect(fns.onRenameRequest).toHaveBeenCalledTimes(1);
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

describe("TabBar 閉じるボタンのキー操作", () => {
  it("× に Enter / Space を送ってもタブ選択に横取りされない (ボタンの click に任せる)", () => {
    const onSelect = vi.fn();
    renderWithProviders(
      <TabBar tabs={TABS} activeTabId="t1" onSelect={onSelect} onClose={() => {}} onNew={() => {}} />,
    );
    const closeButtons = screen.getAllByRole("button", { name: t("tabClose") });
    for (const key of ["Enter", " "]) {
      const notPrevented = fireEvent.keyDown(closeButtons[1], { key });
      expect(notPrevented).toBe(true);
    }
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("TabBar running indicator (#1500)", () => {
  it("marks only the running tab with the spinner and aria-busy", () => {
    const tabs: TabInfo[] = [
      { id: "t1", kind: "query", title: "Query 1" },
      { id: "t2", kind: "query", title: "Query 2", running: true },
    ];
    const { container } = renderWithProviders(
      <TabBar tabs={tabs} activeTabId="t1" onSelect={() => {}} onClose={() => {}} onNew={() => {}} />,
    );
    const [t1, t2] = screen.getAllByRole("tab");
    expect(t1).not.toHaveAttribute("aria-busy");
    expect(t2).toHaveAttribute("aria-busy", "true");
    expect(container.querySelectorAll('[data-running="true"]')).toHaveLength(1);
    expect(t2.querySelector('[data-running="true"]')).not.toBeNull();
  });
});

describe("sameTabInfo (#1500)", () => {
  it("detects running changes", () => {
    const a: TabInfo = { id: "t1", kind: "query", title: "Q" };
    expect(sameTabInfo(a, { ...a })).toBe(true);
    expect(sameTabInfo(a, { ...a, running: true })).toBe(false);
    expect(sameTabInfo(undefined, a)).toBe(false);
  });
});

describe("TabBar pinned (#1486)", () => {
  it("ピン留めタブは閉じるボタンの代わりにピンアイコンを出し、未ピンは閉じるボタンのまま", () => {
    const tabs: TabInfo[] = [
      { id: "t1", kind: "query", title: "監視", pinned: true },
      { id: "t2", kind: "query", title: "Query 2" },
    ];
    renderWithProviders(
      <TabBar tabs={tabs} activeTabId="t1" onSelect={() => {}} onClose={() => {}} onNew={() => {}} />,
    );
    const [t1, t2] = screen.getAllByRole("tab");
    expect(t1.querySelector('[data-pinned="true"]')).not.toBeNull();
    expect(t1.querySelector(`button[aria-label="${t("tabClose")}"]`)).toBeNull();
    expect(t2.querySelector(`button[aria-label="${t("tabClose")}"]`)).not.toBeNull();
  });

  it("sameTabInfo は pinned の変化を検知する", () => {
    const a: TabInfo = { id: "t1", kind: "query", title: "Q" };
    expect(sameTabInfo(a, { ...a, pinned: true })).toBe(false);
  });
});

describe("TabBar pinned keyboard reorder (#1486)", () => {
  const tabs: TabInfo[] = [
    { id: "p1", kind: "query", title: "P1", pinned: true },
    { id: "p2", kind: "query", title: "P2", pinned: true },
    { id: "a", kind: "query", title: "A" },
    { id: "b", kind: "query", title: "B" },
  ];
  const setup = () => {
    const onReorder = vi.fn();
    renderWithProviders(
      <TabBar
        tabs={tabs}
        activeTabId="a"
        onSelect={() => {}}
        onClose={() => {}}
        onNew={() => {}}
        onReorder={onReorder}
      />,
    );
    return { onReorder, tabEls: screen.getAllByRole("tab") };
  };

  it("ピンの境界を跨ぐ移動は何もせず、preventDefault もしない", () => {
    const { onReorder, tabEls } = setup();
    const notPrevented = fireEvent.keyDown(tabEls[2], { key: "ArrowLeft", ctrlKey: true, shiftKey: true });
    expect(onReorder).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
  });

  it("同じ群の中での移動は従来どおり通る", () => {
    const { onReorder, tabEls } = setup();
    fireEvent.keyDown(tabEls[0], { key: "ArrowRight", ctrlKey: true, shiftKey: true });
    expect(onReorder).toHaveBeenCalledWith(["p2", "p1", "a", "b"]);
    fireEvent.keyDown(tabEls[2], { key: "ArrowRight", ctrlKey: true, shiftKey: true });
    expect(onReorder).toHaveBeenLastCalledWith(["p1", "p2", "b", "a"]);
  });
});
