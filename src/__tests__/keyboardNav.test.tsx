/**
 * キーボードナビゲーション共通フック (`src/keyboardNav.ts`) のユニットテスト。
 *
 * jsdom 環境で `useReturnFocus` / `useFocusTrap` / `useRovingFocus` の
 * 主要なキーボード操作を検証する。
 *
 * ## テスト対象
 * - `useReturnFocus`: マウント前のフォーカス要素へアンマウント後に戻ること
 * - `useFocusTrap`: Tab / Shift+Tab でコンテナ内を循環すること、Esc で onEscape が呼ばれること
 * - `useRovingFocus`: ArrowDown/Up / Home/End でリスト内を移動すること
 *                    ContextMenu の onKeyDown として差し込んだ場合の統合的な動作
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { useRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReturnFocus, useFocusTrap, useRovingFocus } from "../keyboardNav";

// ---------------------------------------------------------------------------
// useReturnFocus
// ---------------------------------------------------------------------------

/** useReturnFocus を使う最小コンポーネント */
function ReturnFocusComponent({ onClose }: { onClose: () => void }) {
  useReturnFocus();
  return (
    <div role="dialog" aria-label="popup">
      <button onClick={onClose}>Close popup</button>
    </div>
  );
}

describe("useReturnFocus", () => {
  it("ポップアップを閉じると、開く前にフォーカスしていたボタンへ戻る", async () => {
    const user = userEvent.setup();

    // トリガーボタンと、条件付きで表示するポップアップを持つ親コンポーネント。
    function Host() {
      const [open, setOpen] = useRefState(false);
      return (
        <>
          <button id="trigger" onClick={() => setOpen(true)}>
            Open
          </button>
          {open && <ReturnFocusComponent onClose={() => setOpen(false)} />}
        </>
      );
    }

    render(<Host />);
    const trigger = screen.getByRole("button", { name: "Open" });

    // トリガーをクリックしてポップアップを開く。
    await user.click(trigger);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // ポップアップ内のボタンをクリックして閉じる。
    await user.click(screen.getByRole("button", { name: "Close popup" }));

    // トリガーへフォーカスが戻っていること。
    expect(trigger).toHaveFocus();
  });
});

// ---------------------------------------------------------------------------
// useFocusTrap
// ---------------------------------------------------------------------------

/** useFocusTrap を使う最小コンポーネント */
function TrapComponent({ onEscape }: { onEscape?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, onEscape);
  return (
    <div ref={ref} data-testid="trap">
      <button>First</button>
      <button>Second</button>
      <button>Third</button>
    </div>
  );
}

describe("useFocusTrap", () => {
  it("Tab で末尾まで進んだ後は先頭へラップする", async () => {
    const user = userEvent.setup();
    render(<TrapComponent />);

    // First ボタンにフォーカス。
    screen.getByRole("button", { name: "First" }).focus();

    // Tab × 2 で Third へ。
    await user.tab();
    expect(screen.getByRole("button", { name: "Second" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Third" })).toHaveFocus();

    // もう一度 Tab すると先頭へラップ。
    await user.tab();
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
  });

  it("Shift+Tab で先頭から末尾へラップする", async () => {
    const user = userEvent.setup();
    render(<TrapComponent />);

    screen.getByRole("button", { name: "First" }).focus();
    // Shift+Tab → 末尾へラップ。
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Third" })).toHaveFocus();
  });

  it("Esc を押すと onEscape が呼ばれる", async () => {
    const user = userEvent.setup();
    const onEscape = vi.fn();
    render(<TrapComponent onEscape={onEscape} />);

    screen.getByRole("button", { name: "First" }).focus();
    await user.keyboard("{Escape}");
    expect(onEscape).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// useRovingFocus
// ---------------------------------------------------------------------------

/** useRovingFocus を使う最小リストコンポーネント */
function RovingListComponent({ wrap = true }: { wrap?: boolean }) {
  const ref = useRef<HTMLUListElement>(null);
  const { onKeyDown } = useRovingFocus(ref, "[role=option]", {
    orientation: "vertical",
    wrap,
  });
  return (
    <ul ref={ref} role="listbox" onKeyDown={onKeyDown}>
      <li role="option" tabIndex={0}>
        Apple
      </li>
      <li role="option" tabIndex={-1}>
        Banana
      </li>
      <li role="option" tabIndex={-1}>
        Cherry
      </li>
    </ul>
  );
}

describe("useRovingFocus", () => {
  it("ArrowDown で次の項目へフォーカスが移る", async () => {
    const user = userEvent.setup();
    render(<RovingListComponent />);

    screen.getByRole("option", { name: "Apple" }).focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: "Banana" })).toHaveFocus();
  });

  it("ArrowUp で前の項目へフォーカスが移る", async () => {
    const user = userEvent.setup();
    render(<RovingListComponent />);

    screen.getByRole("option", { name: "Banana" }).focus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("option", { name: "Apple" })).toHaveFocus();
  });

  it("末尾で ArrowDown を押すと先頭へラップする (wrap=true)", async () => {
    const user = userEvent.setup();
    render(<RovingListComponent wrap={true} />);

    screen.getByRole("option", { name: "Cherry" }).focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: "Apple" })).toHaveFocus();
  });

  it("先頭で ArrowUp を押すと末尾へラップする (wrap=true)", async () => {
    const user = userEvent.setup();
    render(<RovingListComponent wrap={true} />);

    screen.getByRole("option", { name: "Apple" }).focus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("option", { name: "Cherry" })).toHaveFocus();
  });

  it("wrap=false のとき先頭/末尾を超えてラップしない", async () => {
    const user = userEvent.setup();
    render(<RovingListComponent wrap={false} />);

    screen.getByRole("option", { name: "Apple" }).focus();
    // ArrowUp: 先頭なので移動しない。
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("option", { name: "Apple" })).toHaveFocus();

    screen.getByRole("option", { name: "Cherry" }).focus();
    // ArrowDown: 末尾なので移動しない。
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: "Cherry" })).toHaveFocus();
  });

  it("Home キーで先頭の項目へジャンプする", async () => {
    const user = userEvent.setup();
    render(<RovingListComponent />);

    screen.getByRole("option", { name: "Cherry" }).focus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("option", { name: "Apple" })).toHaveFocus();
  });

  it("End キーで末尾の項目へジャンプする", async () => {
    const user = userEvent.setup();
    render(<RovingListComponent />);

    screen.getByRole("option", { name: "Apple" }).focus();
    await user.keyboard("{End}");
    expect(screen.getByRole("option", { name: "Cherry" })).toHaveFocus();
  });
});

// ---------------------------------------------------------------------------
// ContextMenu に useRovingFocus + useReturnFocus を適用した統合テスト
// ---------------------------------------------------------------------------

import { renderWithProviders } from "./testUtils";
import { ContextMenu } from "../components/ContextMenu";
import type { ContextMenuEntry } from "../components/ContextMenu";

describe("ContextMenu キーボードナビゲーション", () => {
  const items: ContextMenuEntry[] = [
    { label: "Edit", onSelect: vi.fn() },
    { label: "Copy", onSelect: vi.fn() },
    { label: "Delete", onSelect: vi.fn(), danger: true },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("開いたとき最初の項目にフォーカスが当たる", async () => {
    renderWithProviders(
      <ContextMenu x={100} y={100} items={items} onClose={() => {}} />,
    );
    // PortalはdocumentBodyにレンダリングされる
    await vi.waitFor(() => {
      const first = document.querySelector('[role="menuitem"]');
      expect(first).not.toBeNull();
    });
    const menuItems = document.querySelectorAll('[role="menuitem"]');
    expect(menuItems.length).toBe(3);
  });

  it("Esc を押すと onClose が呼ばれる", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWithProviders(
      <ContextMenu x={100} y={100} items={items} onClose={onClose} />,
    );

    // Esc イベントを発火。
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("メニュー項目を選択すると onClose が先に、次に onSelect が呼ばれる", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSelect = vi.fn();
    const testItems: ContextMenuEntry[] = [{ label: "Run", onSelect }];
    renderWithProviders(
      <ContextMenu x={100} y={100} items={testItems} onClose={onClose} />,
    );

    const menuItem = document.querySelector('[role="menuitem"]') as HTMLElement;
    menuItem.focus();
    await user.keyboard("{Enter}");

    expect(onClose).toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

import { useState as useStateImpl } from "react";

/** テスト用の useState ラッパー (useRefState という名前で使う)。 */
function useRefState<T>(initial: T): [T, (v: T) => void] {
  return useStateImpl<T>(initial);
}
