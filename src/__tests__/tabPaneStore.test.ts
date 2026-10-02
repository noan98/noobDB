import { describe, expect, it, vi } from "vitest";
import { TabPaneStore, useStoreSelector, type PaneShape } from "../tabPaneStore";
import { renderHook, act } from "@testing-library/react";

/**
 * Issue #1318: タブ・ペインの外部ストア。`useState` の setter と同じ形で使えること、
 * 同期的に最新を返すこと、参照が変わらない更新では通知しないことを固定する。
 */
interface T {
  id: string;
  title: string;
}
type P = PaneShape;

const makeStore = () => new TabPaneStore<T, P>();

describe("TabPaneStore", () => {
  it("setTabs / setPanes は値でも更新関数でも受け取り、同期的に反映する", () => {
    const s = makeStore();
    s.setTabs([{ id: "a", title: "A" }]);
    s.setTabs((prev) => [...prev, { id: "b", title: "B" }]);
    expect(s.getTabs().map((x) => x.id)).toEqual(["a", "b"]);
    s.setPanes([{ id: "p1", tabIds: ["a", "b"], activeTabId: "a" }]);
    s.setPanes((prev) => prev.map((p) => ({ ...p, activeTabId: "b" })));
    expect(s.getPane("p1")?.activeTabId).toBe("b");
    expect(s.getTab("b")?.title).toBe("B");
    expect(s.getTab("zzz")).toBeNull();
    expect(s.getTab(null)).toBeNull();
  });

  it("同じ参照を返す更新 (prev => prev) は購読者に通知しない", () => {
    const s = makeStore();
    s.setTabs([{ id: "a", title: "A" }]);
    const listener = vi.fn();
    const off = s.subscribe(listener);
    s.setTabs((prev) => prev);
    expect(listener).not.toHaveBeenCalled();
    s.setTabs((prev) => prev.map((x) => ({ ...x, title: "A2" })));
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    s.setTabs([]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("useStoreSelector: 選んだ部分が変わらなければ再描画せず、変わったら再描画する", () => {
    const s = makeStore();
    s.setTabs([
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ]);
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useStoreSelector(s, s.getTabs, (tabs) => tabs.find((x) => x.id === "a") ?? null);
    });
    expect(result.current?.title).toBe("A");
    const base = renders;
    act(() => s.setTabs((prev) => prev.map((x) => (x.id === "b" ? { ...x, title: "B2" } : x))));
    expect(renders).toBe(base);
    act(() => s.setTabs((prev) => prev.map((x) => (x.id === "a" ? { ...x, title: "A2" } : x))));
    expect(renders).toBe(base + 1);
    expect(result.current?.title).toBe("A2");
  });

  it("useStoreSelector: equal を渡すと、配列の中身が同じなら前回の参照を返す", () => {
    const s = makeStore();
    s.setTabs([{ id: "a", title: "A" }]);
    const same = (x: T[], y: T[]) => x.length === y.length && x.every((v, i) => v === y[i]);
    const { result } = renderHook(() => useStoreSelector(s, s.getTabs, (tabs) => tabs.filter((x) => x.id === "a"), same));
    const first = result.current;
    act(() => s.setTabs((prev) => [...prev, { id: "b", title: "B" }]));
    expect(result.current).toBe(first);
  });
});
