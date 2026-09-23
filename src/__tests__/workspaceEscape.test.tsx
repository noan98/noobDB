import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import appSource from "../App.tsx?raw";
import { act, fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import {
  hasOpenNestedLayer,
  isEditableElement,
  isEscapeClosableView,
  resolveWorkspaceEscape,
  WORKSPACE_SURFACE_LABEL_KEYS,
  type WorkspaceEscapeInput,
} from "../components/workspaceEscape";
import type { WorkspaceViewKey } from "../components/workspaceView";
import { t } from "../i18n";
import { WorkspaceSurface } from "../components/WorkspaceSurface";
import { ContextMenu } from "../components/ContextMenu";
import { Modal } from "../components/Modal";

/**
 * 全画面サーフェスの Escape とフォーカス移譲/復帰 (#1070)。
 *
 * - 純関数 `resolveWorkspaceEscape`: 受け手の優先順位 (ネストレイヤ > 入力欄 >
 *   サーフェス > レイアウト最大化) と、最大化 Escape との排他を固定する。
 * - `WorkspaceSurface`: 開くとコンテナへフォーカス、閉じると元の要素へ戻る。
 *   ネストした ContextMenu / Modal の Escape はそれだけを閉じる。
 * - `App.tsx` の結線: 対象サーフェスがすべて包まれ、最大化 Escape が同じ関数を引く。
 */

const base: WorkspaceEscapeInput = {
  key: "Escape",
  defaultPrevented: false,
  isComposing: false,
  nestedLayerOpen: false,
  editableFocused: false,
  view: "erd",
  layoutMaximized: false,
};

const CLOSABLE: WorkspaceViewKey[] = [
  "compare",
  "erd",
  "users",
  "serverInfo",
  "sizes",
  "compareResults",
];

describe("resolveWorkspaceEscape", () => {
  it("Escape 以外のキーでは何もしない", () => {
    expect(resolveWorkspaceEscape({ ...base, key: "Enter" })).toBeNull();
    expect(resolveWorkspaceEscape({ ...base, key: "Esc" })).toBeNull();
  });

  it("閉じられるサーフェスはすべて closeView になる", () => {
    for (const view of CLOSABLE) {
      expect(resolveWorkspaceEscape({ ...base, view })).toBe("closeView");
    }
  });

  it("フォーム系サーフェスは Escape で閉じない (未保存入力を 1 キーで捨てない)", () => {
    expect(isEscapeClosableView("form")).toBe(false);
    expect(isEscapeClosableView("snippetForm")).toBe(false);
    expect(resolveWorkspaceEscape({ ...base, view: "form" })).toBeNull();
    expect(resolveWorkspaceEscape({ ...base, view: "snippetForm", layoutMaximized: true })).toBeNull();
  });

  it("ネストした Modal / メニューが開いていればそちらを優先し、全体は閉じない", () => {
    expect(resolveWorkspaceEscape({ ...base, nestedLayerOpen: true })).toBeNull();
    expect(
      resolveWorkspaceEscape({ ...base, view: "workspace", layoutMaximized: true, nestedLayerOpen: true }),
    ).toBeNull();
  });

  it("既に処理済み (defaultPrevented) の Escape は拾わない", () => {
    expect(resolveWorkspaceEscape({ ...base, defaultPrevented: true })).toBeNull();
  });

  it("IME 変換中の Escape は変換の取り消しなので拾わない", () => {
    expect(resolveWorkspaceEscape({ ...base, isComposing: true })).toBeNull();
  });

  it("入力欄 / エディタのローカル Escape を奪わない", () => {
    expect(resolveWorkspaceEscape({ ...base, editableFocused: true })).toBeNull();
    expect(
      resolveWorkspaceEscape({ ...base, view: "workspace", layoutMaximized: true, editableFocused: true }),
    ).toBeNull();
  });

  it("最大化中でもサーフェスが開いていればサーフェスを閉じるだけ (最大化は解除しない)", () => {
    for (const view of CLOSABLE) {
      expect(resolveWorkspaceEscape({ ...base, view, layoutMaximized: true })).toBe("closeView");
    }
  });

  it("通常ワークスペースが見えていて最大化中なら restoreLayout", () => {
    expect(resolveWorkspaceEscape({ ...base, view: "workspace", layoutMaximized: true })).toBe(
      "restoreLayout",
    );
    expect(resolveWorkspaceEscape({ ...base, view: "workspace", layoutMaximized: false })).toBeNull();
  });

  it("1 回の Escape が closeView と restoreLayout を同時に返すことはない (排他)", () => {
    // 返り値は 1 つなので構造的に排他だが、サーフェス側 (layoutMaximized: false 固定) と
    // レイアウト側 (実際の値) で別々に引いても両方が動かないことを確かめる。
    for (const view of [...CLOSABLE, "workspace", "form", "snippetForm"] as WorkspaceViewKey[]) {
      const surface = resolveWorkspaceEscape({ ...base, view, layoutMaximized: false });
      const layout = resolveWorkspaceEscape({ ...base, view, layoutMaximized: true });
      const both = surface === "closeView" && layout === "restoreLayout";
      expect(both).toBe(false);
    }
  });
});

describe("hasOpenNestedLayer / isEditableElement", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("dialog / alertdialog / menu / listbox を開いたレイヤとして数える", () => {
    expect(hasOpenNestedLayer(document)).toBe(false);
    for (const role of ["dialog", "alertdialog", "menu", "listbox"]) {
      document.body.innerHTML = `<div role="${role}"></div>`;
      expect(hasOpenNestedLayer(document)).toBe(true);
    }
  });

  it("hidden / aria-hidden 配下の閉じたレイヤは数えない", () => {
    document.body.innerHTML =
      '<div hidden><div role="dialog"></div></div><div aria-hidden="true"><div role="menu"></div></div>';
    expect(hasOpenNestedLayer(document)).toBe(false);
  });

  it("tooltip / region はネストレイヤではない", () => {
    document.body.innerHTML = '<div role="tooltip"></div><div role="region"></div>';
    expect(hasOpenNestedLayer(document)).toBe(false);
  });

  it("入力欄・contenteditable・CodeMirror を編集要素とみなす", () => {
    document.body.innerHTML = `
      <input id="i" /><textarea id="t"></textarea><select id="s"></select>
      <div contenteditable="true"><span id="ce"></span></div>
      <div class="cm-editor"><div id="cm"></div></div>
      <button id="b"></button>`;
    for (const id of ["i", "t", "s", "ce", "cm"]) {
      expect(isEditableElement(document.getElementById(id))).toBe(true);
    }
    expect(isEditableElement(document.getElementById("b"))).toBe(false);
    expect(isEditableElement(null)).toBe(false);
  });
});

const surface = () => document.querySelector<HTMLElement>('[data-workspace-surface="erd"]');

/** トリガーボタンでサーフェスを開閉する最小ハーネス。 */
function Harness({
  onCloseSpy,
  inner,
}: {
  onCloseSpy?: () => void;
  inner?: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = () => {
    onCloseSpy?.();
    setOpen(false);
  };
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open-erd
      </button>
      {open && (
        <WorkspaceSurface view="erd" onClose={close}>
          <button type="button" onClick={close}>
            back
          </button>
          {inner?.(close)}
        </WorkspaceSurface>
      )}
    </>
  );
}

describe("WorkspaceSurface", () => {
  it("開くとコンテナへフォーカスが移り、Escape で閉じるとトリガーへ戻る", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    const trigger = screen.getByRole("button", { name: "open-erd" });
    await user.click(trigger);

    const region = surface();
    expect(region).toHaveAttribute("aria-label", t("erDiagramTitle"));
    expect(region).toHaveAttribute("role", "region");
    expect(region).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(surface()).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("戻るボタンで閉じてもトリガーへフォーカスが戻る (既存導線と共存)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    const trigger = screen.getByRole("button", { name: "open-erd" });
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "back" }));
    expect(surface()).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("サーフェス内の入力欄にフォーカスがある間は Escape で閉じない", async () => {
    const user = userEvent.setup();
    const onCloseSpy = vi.fn();
    renderWithProviders(
      <Harness onCloseSpy={onCloseSpy} inner={() => <input aria-label="search" />} />,
    );
    await user.click(screen.getByRole("button", { name: "open-erd" }));
    await user.click(screen.getByRole("textbox", { name: "search" }));
    await user.keyboard("{Escape}");
    expect(onCloseSpy).not.toHaveBeenCalled();
    expect(surface()).not.toBeNull();
  });

  it("ネストした ContextMenu の Escape はメニューだけを閉じ、次の Escape でサーフェスが閉じる", async () => {
    const user = userEvent.setup();
    const onCloseSpy = vi.fn();
    function Inner() {
      const [menu, setMenu] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setMenu(true)}>
            menu-trigger
          </button>
          {menu && (
            <ContextMenu
              x={0}
              y={0}
              items={[{ label: "item", onSelect: () => {} }]}
              onClose={() => setMenu(false)}
            />
          )}
        </>
      );
    }
    renderWithProviders(<Harness onCloseSpy={onCloseSpy} inner={() => <Inner />} />);
    await user.click(screen.getByRole("button", { name: "open-erd" }));
    await user.click(screen.getByRole("button", { name: "menu-trigger" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onCloseSpy).not.toHaveBeenCalled();
    expect(surface()).not.toBeNull();

    // メニューが閉じた後の Escape はサーフェスへ届く。
    await user.keyboard("{Escape}");
    expect(onCloseSpy).toHaveBeenCalledTimes(1);
  });

  it("フォーカスがメニュー外でも、ContextMenu が開いている間はサーフェスを閉じない", async () => {
    const onCloseSpy = vi.fn();
    const onMenuClose = vi.fn();
    renderWithProviders(
      <Harness
        onCloseSpy={onCloseSpy}
        inner={() => (
          <ContextMenu x={0} y={0} items={[{ label: "item", onSelect: () => {} }]} onClose={onMenuClose} />
        )}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "open-erd" }));
    // フォーカスをサーフェス本体へ戻した状態で window に Escape を送る。
    act(() => surface()?.focus());
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onMenuClose).toHaveBeenCalled();
    expect(onCloseSpy).not.toHaveBeenCalled();
  });

  it("ネストした Modal の Escape は Modal だけを閉じる", async () => {
    const user = userEvent.setup();
    const onCloseSpy = vi.fn();
    function Inner() {
      const [modal, setModal] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setModal(true)}>
            modal-trigger
          </button>
          {modal && (
            <Modal onClose={() => setModal(false)}>
              <button type="button">inside</button>
            </Modal>
          )}
        </>
      );
    }
    renderWithProviders(<Harness onCloseSpy={onCloseSpy} inner={() => <Inner />} />);
    await user.click(screen.getByRole("button", { name: "open-erd" }));
    await user.click(screen.getByRole("button", { name: "modal-trigger" }));
    await screen.findByRole("dialog");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onCloseSpy).not.toHaveBeenCalled();
    expect(surface()).not.toBeNull();
  });
});

describe("App.tsx の結線 (#1070)", () => {
  it("Escape で閉じるサーフェスはすべて WorkspaceSurface で包まれ、ラベルも揃っている", () => {
    for (const view of CLOSABLE) {
      expect(appSource).toContain(`<WorkspaceSurface view="${view}"`);
      expect(WORKSPACE_SURFACE_LABEL_KEYS).toHaveProperty(view);
    }
    expect(Object.keys(WORKSPACE_SURFACE_LABEL_KEYS).sort()).toEqual([...CLOSABLE].sort());
  });

  it("フォーム系サーフェスは包まない", () => {
    expect(appSource).not.toContain('<WorkspaceSurface view="form"');
    expect(appSource).not.toContain('<WorkspaceSurface view="snippetForm"');
  });

  it("レイアウト最大化の Escape も resolveWorkspaceEscape を引き、restoreLayout のときだけ動く", () => {
    expect(appSource).toMatch(/const escape = resolveWorkspaceEscape\(\{/);
    expect(appSource).toMatch(/if \(escape === "restoreLayout"\) \{\s*e\.preventDefault\(\);\s*setLayoutMode\("normal"\);/);
    // 旧来の「layoutMode !== normal なら無条件に解除」は残っていない。
    expect(appSource).not.toContain('e.key === "Escape" && layoutMode !== "normal"');
  });
});
