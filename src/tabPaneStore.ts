import { useRef, useSyncExternalStore } from "react";

/**
 * タブ配列とペイン配列を App のコンポーネント state から切り離した外部ストア (#1318)。
 *
 * App は約 1 万行の単一コンポーネントで、`tabs` / `panes` を `useState` で持つと、タブ 1 つの
 * 更新が App 全体と全ペインの再描画を起こす。ここでは正本をストアに置き、購読側が
 * selector で必要な部分だけを受け取る (`useTab` / `usePane` / `usePaneTabs`)。
 *
 * - `setTabs` / `setPanes` は `useState` の setter と同じ形 (値 or 更新関数) で、同期的に
 *   反映される。呼び出し側は変えずに済み、`getTabs()` / `getPanes()` は常に最新を返す
 *   (React の commit を待つ ref より新しい)。
 * - 参照が変わらない更新 (`prev => prev`) は購読者に通知しない。
 * - 型 (`Tab` / `PaneState`) は App 側が持つので、ここでは `id` を持つ形だけを要求する。
 */
export interface PaneShape {
  id: string;
  tabIds: readonly string[];
  activeTabId: string | null;
}

type Updater<T> = T | ((prev: T) => T);

export class TabPaneStore<T extends { id: string }, P extends PaneShape> {
  private tabs: T[] = [];
  private panes: P[] = [];
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getTabs = (): T[] => this.tabs;
  readonly getPanes = (): P[] => this.panes;

  readonly setTabs = (next: Updater<T[]>): void => {
    const value = typeof next === "function" ? (next as (prev: T[]) => T[])(this.tabs) : next;
    if (Object.is(value, this.tabs)) return;
    this.tabs = value;
    this.emit();
  };

  readonly setPanes = (next: Updater<P[]>): void => {
    const value = typeof next === "function" ? (next as (prev: P[]) => P[])(this.panes) : next;
    if (Object.is(value, this.panes)) return;
    this.panes = value;
    this.emit();
  };

  /** id でタブを引く。無ければ null。 */
  readonly getTab = (id: string | null | undefined): T | null =>
    id == null ? null : (this.tabs.find((tt) => tt.id === id) ?? null);

  readonly getPane = (id: string | null | undefined): P | null =>
    id == null ? null : (this.panes.find((p) => p.id === id) ?? null);

  private emit(): void {
    for (const l of Array.from(this.listeners)) l();
  }
}

/**
 * ストアの一部を購読する。`select` の結果が (Object.is で) 同じなら再描画しない。
 * `select` が毎回新しい配列を返す場合は `equal` で比較する。
 */
export function useStoreSelector<S, R>(
  store: Pick<TabPaneStore<{ id: string }, PaneShape>, "subscribe">,
  read: () => S,
  select: (state: S) => R,
  equal: (a: R, b: R) => boolean = Object.is,
): R {
  const last = useRef<{ value: R } | null>(null);
  return useSyncExternalStore(store.subscribe, () => {
    // `select` は呼び出しごとに閉包が変わりうる (ペインの tabIds など) ので、状態の参照が
    // 同じでも毎回計算し直し、結果が等しければ前回の参照を返す。
    const value = select(read());
    const prev = last.current;
    if (prev && equal(prev.value, value)) return prev.value;
    last.current = { value };
    return value;
  });
}
