import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { fireEvent, renderWithProviders, screen } from "./testUtils";
import {
  ContextMenu,
  submenuOrFlat,
  type ContextMenuEntry,
} from "../components/ContextMenu";

// 右クリックメニューの階層化 (#1018)。項目数が状況で膨らむグループ (結果グリッドの
// 「参照元を表示」など) をサブメニューへ畳めるようにしたので、ここでは共有
// プリミティブ側の性質 — 開閉・キーボード操作・親メニューとの独立性 — を固定する。
// 位置決めの算術は `menuPosition.test.ts` の領分 (jsdom は矩形が常に 0)。

function renderMenu(items: ContextMenuEntry[], onClose = vi.fn()) {
  renderWithProviders(<ContextMenu x={10} y={10} items={items} onClose={onClose} />);
  return { onClose };
}

const child = (label: string, onSelect = vi.fn()) => ({ label, onSelect });

describe("submenuOrFlat", () => {
  it("0 件なら何も出さない", () => {
    expect(submenuOrFlat("親", [])).toEqual([]);
  });

  it("しきい値未満ならフラットのまま出す", () => {
    const items = [child("a")];
    expect(submenuOrFlat("親", items)).toEqual(items);
  });

  it("しきい値以上ならサブメニュー 1 項目へ畳む", () => {
    const items = [child("a"), child("b")];
    expect(submenuOrFlat("親", items, { icon: "link" })).toEqual([
      { label: "親", items, icon: "link", title: undefined },
    ]);
  });

  it("しきい値は呼び出し側で上書きできる", () => {
    const items = [child("a"), child("b")];
    expect(submenuOrFlat("親", items, { threshold: 3 })).toEqual(items);
  });
});

describe("ContextMenu のサブメニュー", () => {
  it("ホバーで子項目が開き、選ぶとメニュー全体が閉じてハンドラが走る", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const { onClose } = renderMenu([
      child("トップ項目"),
      { label: "参照元を表示", items: [child("a.x", onSelect), child("b.y")] },
    ]);

    // 畳まれている間は子項目はどこにも出ていない。
    expect(screen.queryByRole("menuitem", { name: "a.x" })).toBeNull();

    await user.hover(screen.getByRole("menuitem", { name: "参照元を表示" }));
    expect(screen.getByRole("menuitem", { name: "参照元を表示" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    await user.click(await screen.findByRole("menuitem", { name: "a.x" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("別のサブメニュー項目にホバーすると開き先が入れ替わる", async () => {
    const user = userEvent.setup();
    renderMenu([
      { label: "グループ 1", items: [child("1-a"), child("1-b")] },
      { label: "グループ 2", items: [child("2-a"), child("2-b")] },
    ]);

    await user.hover(screen.getByRole("menuitem", { name: "グループ 1" }));
    expect(await screen.findByRole("menuitem", { name: "1-a" })).toBeTruthy();

    await user.hover(screen.getByRole("menuitem", { name: "グループ 2" }));
    expect(await screen.findByRole("menuitem", { name: "2-a" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "1-a" })).toBeNull();
  });

  it("無効なサブメニューはホバーしても開かない", async () => {
    const user = userEvent.setup();
    renderMenu([{ label: "グループ", disabled: true, items: [child("a")] }]);

    await user.hover(screen.getByRole("menuitem", { name: "グループ" }));
    expect(screen.queryByRole("menuitem", { name: "a" })).toBeNull();
  });

  it("ArrowRight で開いて先頭の子項目へフォーカスし、ArrowLeft で親へ戻る", async () => {
    renderMenu([{ label: "グループ", items: [child("a"), child("b")] }]);
    const trigger = screen.getByRole("menuitem", { name: "グループ" });
    trigger.focus();

    fireEvent.keyDown(trigger, { key: "ArrowRight" });
    const first = await screen.findByRole("menuitem", { name: "a" });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(screen.queryByRole("menuitem", { name: "a" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "グループ" }));
  });

  it("サブメニュー内の Escape はサブメニューだけを閉じ、メニュー全体は残る", async () => {
    renderMenu([{ label: "グループ", items: [child("a")] }, child("トップ項目")]);
    const trigger = screen.getByRole("menuitem", { name: "グループ" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowRight" });
    const first = await screen.findByRole("menuitem", { name: "a" });

    fireEvent.keyDown(first, { key: "Escape" });
    expect(screen.queryByRole("menuitem", { name: "a" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "トップ項目" })).toBeTruthy();
  });

  it("ルートの Escape はメニュー全体を閉じる", () => {
    const { onClose } = renderMenu([child("トップ項目")]);
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "トップ項目" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("サブメニューを開いても親メニューの矢印移動は子項目を拾わない", async () => {
    const user = userEvent.setup();
    renderMenu([
      { label: "グループ", items: [child("a"), child("b")] },
      child("トップ項目"),
    ]);

    const trigger = screen.getByRole("menuitem", { name: "グループ" });
    await user.hover(trigger);
    expect(await screen.findByRole("menuitem", { name: "a" })).toBeTruthy();

    // 親パネル上での ArrowDown は、ポータルで body へ出ている子項目ではなく
    // 親の次項目へ移る。
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "トップ項目" }));
  });
});
