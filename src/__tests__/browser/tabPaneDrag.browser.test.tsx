// タブを縦に引き出してペインへ移す / 端で分割するドラッグ (#2332) を実 Chromium で通す。
// jsdom では要素の矩形 (getBoundingClientRect) と Motion の Reorder ドラッグが成立しないため、
// pointerdown → pointermove → pointerup を実ブラウザへ流して、ドロップ先の判定とプレビュー、
// Esc での中断、状態遷移 (applyTabDrop) までを通す。
import "../../App.css";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { TabBar, type TabInfo } from "../../components/TabBar";
import { TabDragOverlay } from "../../components/TabDragOverlay";
import { applyTabDrop, type DropPane, type TabDropTarget } from "../../tabPaneDrop";
import { renderInBrowser } from "./render";

const title = (id: string): TabInfo => ({ id, kind: "query", title: `Tab ${id}` });

function Harness({ initial }: { initial: DropPane[] }) {
  const [panes, setPanes] = useState(initial);
  const onDrop = (tabId: string, target: TabDropTarget) => {
    const r = applyTabDrop(panes, tabId, target, () => "p-new");
    if (r) setPanes(r.panes);
  };
  return (
    <div style={{ display: "flex", width: "800px", height: "300px" }} data-testid="root">
      {panes.map((p) => (
        <div
          key={p.id}
          data-pane-zone={p.id}
          data-testid={`pane-${p.id}`}
          style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}
        >
          <TabBar
            tabs={p.tabIds.map(title)}
            activeTabId={p.activeTabId}
            onSelect={() => {}}
            onClose={() => {}}
            onNew={() => {}}
            paneId={p.id}
            onTabDrop={onDrop}
          />
          <div style={{ flex: 1 }} />
        </div>
      ))}
      <TabDragOverlay />
    </div>
  );
}

const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
const tabEl = (id: string) => document.querySelector<HTMLElement>(`[data-tab-id="${id}"]`) as HTMLElement;
const paneIds = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-pane-zone]")).map((el) => el.dataset.paneZone);
const tabsIn = (paneId: string) =>
  Array.from(
    document.querySelectorAll<HTMLElement>(`[data-pane-zone="${paneId}"] [data-tab-id]`),
    (el) => el.dataset.tabId,
  );

const ptr = (type: string, x: number, y: number, buttons: number) =>
  new PointerEvent(type, {
    pointerId: 1,
    isPrimary: true,
    pointerType: "mouse",
    button: 0,
    buttons,
    clientX: x,
    clientY: y,
    bubbles: true,
    cancelable: true,
  });

async function pressTab(id: string) {
  const r = tabEl(id).getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  tabEl(id).dispatchEvent(ptr("pointerdown", x, y, 1));
  return { x, y };
}
const move = async (x: number, y: number) => {
  window.dispatchEvent(ptr("pointermove", x, y, 1));
  await frame();
  await frame();
};
const release = async (x: number, y: number) => {
  window.dispatchEvent(ptr("pointerup", x, y, 0));
  await frame();
  await frame();
};
const settle = () => new Promise((r) => setTimeout(r, 700));

const TWO: DropPane[] = [
  { id: "p1", tabIds: ["a", "b", "c"], activeTabId: "a" },
  { id: "p2", tabIds: ["d", "e"], activeTabId: "d" },
];
const ONE: DropPane[] = [{ id: "p1", tabIds: ["a", "b", "c"], activeTabId: "a" }];

describe("タブのペイン間ドラッグ (#2332)", () => {
  it("下へ引き出してもう一方のタブバーへ落とすと、その位置へ移る", async () => {
    await renderInBrowser(<Harness initial={TWO} />);
    await frame();
    const { x } = await pressTab("b");
    // しきい値未満 (バー内の移動) ではまだドラッグにならない
    await move(x, 20);
    expect(document.querySelector('[data-testid="tab-drag-ghost"]')).toBeNull();
    // 引き出す → ゴースト + 挿入マーカー
    const d = tabEl("d").getBoundingClientRect();
    const e = tabEl("e").getBoundingClientRect();
    await move(d.right + 5, d.top + 5); // 隣ペインのバーへ横から出る
    await move(d.right + 5, d.top + 8);
    expect(document.querySelector('[data-testid="tab-drag-ghost"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="tab-drop-marker"]')).not.toBeNull();
    await release(d.right + 5, d.top + 5);
    await settle();
    expect(tabsIn("p2")).toEqual(["d", "b", "e"]);
    expect(tabsIn("p1")).toEqual(["a", "c"]);
    expect(e.left).toBeGreaterThan(0);
    expect(document.querySelector('[data-testid="tab-drag-ghost"]')).toBeNull();
  });

  it("別ペインの本体へ落とすと末尾へ移る (面のプレビューが出る)", async () => {
    await renderInBrowser(<Harness initial={TWO} />);
    await frame();
    await pressTab("a");
    const p2 = document.querySelector('[data-testid="pane-p2"]')?.getBoundingClientRect() as DOMRect;
    await move(p2.left + 50, p2.top + 200);
    expect(document.querySelector('[data-testid="tab-drop-preview"]')).not.toBeNull();
    await release(p2.left + 50, p2.top + 200);
    await settle();
    expect(tabsIn("p2")).toEqual(["d", "e", "a"]);
  });

  it("1 ペインのとき右端へ落とすと 2 ペインに分割され、タブが右に入る", async () => {
    await renderInBrowser(<Harness initial={ONE} />);
    await frame();
    await pressTab("c");
    const p1 = document.querySelector('[data-testid="pane-p1"]')?.getBoundingClientRect() as DOMRect;
    await move(p1.right - 10, p1.top + 200);
    expect(document.querySelector('[data-testid="tab-drop-preview"]')).not.toBeNull();
    await release(p1.right - 10, p1.top + 200);
    await settle();
    expect(paneIds()).toEqual(["p1", "p-new"]);
    expect(tabsIn("p-new")).toEqual(["c"]);
    expect(tabsIn("p1")).toEqual(["a", "b"]);
  });

  it("元のペインが空になったら 1 ペインへ戻る", async () => {
    await renderInBrowser(
      <Harness
        initial={[
          { id: "p1", tabIds: ["a"], activeTabId: "a" },
          { id: "p2", tabIds: ["d"], activeTabId: "d" },
        ]}
      />,
    );
    await frame();
    await pressTab("a");
    const p2 = document.querySelector('[data-testid="pane-p2"]')?.getBoundingClientRect() as DOMRect;
    await move(p2.left + 50, p2.top + 200);
    await release(p2.left + 50, p2.top + 200);
    await settle();
    expect(paneIds()).toEqual(["p2"]);
    expect(tabsIn("p2")).toEqual(["d", "a"]);
  });

  it("Esc で中断すると何も移らない", async () => {
    await renderInBrowser(<Harness initial={TWO} />);
    await frame();
    await pressTab("a");
    const p2 = document.querySelector('[data-testid="pane-p2"]')?.getBoundingClientRect() as DOMRect;
    await move(p2.left + 50, p2.top + 200);
    expect(document.querySelector('[data-testid="tab-drop-preview"]')).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await settle(); // ゴーストはフェードアウトしてから外れる
    expect(document.querySelector('[data-testid="tab-drag-ghost"]')).toBeNull();
    expect(document.querySelector('[data-testid="tab-drop-preview"]')).toBeNull();
    await release(p2.left + 50, p2.top + 200);
    await settle();
    expect(tabsIn("p1")).toEqual(["a", "b", "c"]);
    expect(tabsIn("p2")).toEqual(["d", "e"]);
  });

  it("落とせない場所 (元のペインの本体) で離しても何も起きない", async () => {
    await renderInBrowser(<Harness initial={TWO} />);
    await frame();
    await pressTab("a");
    const p1 = document.querySelector('[data-testid="pane-p1"]')?.getBoundingClientRect() as DOMRect;
    await move(p1.left + 50, p1.top + 200);
    expect(document.querySelector('[data-testid="tab-drop-preview"]')).toBeNull();
    await release(p1.left + 50, p1.top + 200);
    await settle();
    expect(tabsIn("p1")).toEqual(["a", "b", "c"]);
  });
});
