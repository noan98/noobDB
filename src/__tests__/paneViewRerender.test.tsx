import { useState } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { act, renderWithProviders, screen, waitFor } from "./testUtils";
import { PaneView, type PaneActions, type PaneEnv } from "../components/PaneView";
import { QueryEditor } from "../components/QueryEditor";
import { ResultGrid } from "../components/ResultGrid";
import { TabPaneStore } from "../tabPaneStore";
import { TabDirtyWatcher, TabSqlStore } from "../tabSqlStore";
import { useKeyedStable } from "../useKeyedStable";
import { resolveShortcutBindings } from "../shortcuts";
import { t } from "../i18n";
import type { PaneState, Tab } from "../App";

/**
 * Issue #1318: ペインは自分のペインとタブだけをストアから購読する memo 境界になっている。
 * React DevTools Profiler の代わりに、`PaneView` が毎回描く `TabBar` を「描画されるたびに
 * 数えるスタブ」に差し替え、再描画された回数で「変化したペインだけが再レンダーされる」ことを
 * 固定する (`<Profiler>` は親から新しい children が来るだけで onRender が呼ばれ、memo で
 * 省かれたかどうかを見分けられない)。ペインは先頭のタブ ID (a1 / b1) で区別する。
 * スタブは memo 化しないので、`PaneView` が省かれない限り毎回カウントが進む。
 */
const paneRenders = vi.hoisted(() => ({ pa: 0, pb: 0 }));

vi.mock("../components/TabBar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/TabBar")>();
  return {
    ...actual,
    TabBar: (props: { tabs: { id: string; title: string }[]; activeTabId: string | null }) => {
      if (props.tabs[0]?.id === "a1") paneRenders.pa += 1;
      if (props.tabs[0]?.id === "b1") paneRenders.pb += 1;
      return (
        <div>
          {props.tabs.map((x) => (
            <div key={x.id} role="tab" aria-selected={x.id === props.activeTabId}>
              {x.title}
            </div>
          ))}
        </div>
      );
    },
  };
});

/**
 * Issue #1323: チャート / ピボットは useState の初期化だけで設定を決めるため、同じ表示モードの
 * タブ同士の切替で使い回されると前のタブの設定が残る。マウントされた回数を数えるスタブで
 * 「タブごとに作り直される (key={tab.id})」ことを固定する。
 */
const viewMounts = vi.hoisted(() => ({ chart: 0, pivot: 0 }));

vi.mock("../components/ChartView", async () => {
  const React = await import("react");
  return {
    ChartView: () => {
      React.useEffect(() => {
        viewMounts.chart += 1;
      }, []);
      return <div>chart-stub</div>;
    },
  };
});

vi.mock("../components/PivotView", async () => {
  const React = await import("react");
  return {
    PivotView: () => {
      React.useEffect(() => {
        viewMounts.pivot += 1;
      }, []);
      return <div>pivot-stub</div>;
    },
  };
});

function makeTab(id: string, title: string): Tab {
  return {
    id,
    kind: "query",
    title,
    sql: "",
    lastExecutedSql: "",
    result: null,
    preview: null,
    schemaTable: null,
    streaming: false,
    previewStreaming: false,
    previewRowLimit: 100,
    paginatable: null,
    autoLimitApplied: null,
    autoLimitSql: null,
    loadingMore: false,
    canLoadMore: false,
    queryError: null,
    tableColumns: null,
    rowIdentity: null,
    pendingEdits: {},
    editUndoStack: [],
    editRedoStack: [],
    builderSnapshot: null,
  };
}

function makeEnv(store: TabPaneStore<Tab, PaneState>, overrides: Partial<PaneEnv> = {}): PaneEnv {
  const tabSqlStore = new TabSqlStore();
  const noop = () => {};
  // どのハンドラも呼ばれたらテストの観測対象にならない no-op (参照だけ固定する)。
  const cache = new Map<string, () => void>();
  const actions = new Proxy({} as PaneActions, {
    get: (_t, key: string) => {
      let fn = cache.get(key);
      if (!fn) {
        fn = vi.fn();
        cache.set(key, fn);
      }
      return fn;
    },
  });
  return {
    store,
    actions,
    t,
    renamingTabId: null,
    sessionId: null,
    selectedProfile: null,
    layoutMode: "normal",
    readOnly: false,
    emergencyMode: false,
    broadcastAvailable: false,
    queryHistory: [],
    editorBindings: undefined,
    gridBindings: undefined,
    shortcutBindings: resolveShortcutBindings({}),
    density: "normal",
    defaultDisplayCount: 100,
    streamPrefetchSize: 1000,
    incomingFkCache: {},
    schemaForDatabase: () => null,
    lookupForSession: () => async () => ({ rows: [], columns: [] }) as never,
    dirtyTick: 0,
    dirtyWatcher: new TabDirtyWatcher(() => false, noop),
    getTabSql: (tab) => tabSqlStore.resolve(tab.id, tab.sql),
    gridStable: {
      fn: (_k: string, f: unknown) => f,
      memo: (_k: string, _d: readonly unknown[], factory: () => unknown) => factory(),
      prune: noop,
    } as unknown as ReturnType<typeof useKeyedStable>,
    editorSelectionRef: { current: new Map() },
    gridScrollRef: { current: new Map() },
    preflightRef: { current: new Map() },
    getEditorRefSetter: () => noop,
    getGridRefSetter: () => noop,
    ...overrides,
  };
}

function setup() {
  const store = new TabPaneStore<Tab, PaneState>();
  store.setTabs([makeTab("a1", "タブ A1"), makeTab("a2", "タブ A2"), makeTab("b1", "タブ B1")]);
  store.setPanes([
    { id: "pa", tabIds: ["a1", "a2"], activeTabId: "a1" },
    { id: "pb", tabIds: ["b1"], activeTabId: "b1" },
  ]);
  paneRenders.pa = 0;
  paneRenders.pb = 0;
  const renders = paneRenders;
  let bump: () => void = () => {};
  let setEnv: (e: PaneEnv) => void = () => {};
  const base = makeEnv(store);
  function Host() {
    const [, setN] = useState(0);
    const [env, setE] = useState(base);
    bump = () => setN((n) => n + 1);
    setEnv = setE;
    // 親が再レンダーされるたびに「中身は同じだが新しい」env を渡す (App が毎回作り直すのと同じ)。
    const fresh = { ...env };
    return (
      <>
        <PaneView paneId="pa" split isFocused env={fresh} />
        <PaneView paneId="pb" split isFocused={false} env={fresh} />
      </>
    );
  }
  const view = renderWithProviders(<Host />);
  return { store, renders, base, view, rerenderHost: () => act(() => bump()), setEnv: (e: PaneEnv) => act(() => setEnv(e)) };
}

// jsdom には ResizeObserver が無い (TabBar が使う)。何もしないスタブを入れ、終わったら戻す。
const originalResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
const originalScrollIntoView = Element.prototype.scrollIntoView;
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterAll(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalResizeObserver;
});

describe("PaneView の再レンダー境界 (#1318)", () => {
  it("TabBar / QueryEditor / ResultGrid は memo 化されている", async () => {
    const { TabBar: RealTabBar } = await vi.importActual<typeof import("../components/TabBar")>("../components/TabBar");
    for (const c of [RealTabBar, QueryEditor, ResultGrid]) {
      expect((c as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for("react.memo"));
    }
  });

  it("親が env を同じ中身で作り直しても、どのペインも再レンダーされない", async () => {
    const { renders, rerenderHost } = setup();
    await waitFor(() => expect(screen.getAllByRole("tab").length).toBe(3));
    const base = { ...renders };
    rerenderHost();
    rerenderHost();
    expect(renders).toEqual(base);
  });

  it("片方のペインのタブが更新されても、もう片方のペインは再レンダーされない", async () => {
    const { store, renders } = setup();
    await waitFor(() => expect(screen.getAllByRole("tab").length).toBe(3));
    const base = { ...renders };
    // ストリーミングのバッチのように、ペイン A のタブだけを書き換え続ける。
    for (let i = 0; i < 5; i += 1) {
      act(() =>
        store.setTabs((prev) => prev.map((x) => (x.id === "a1" ? { ...x, canLoadMore: i % 2 === 0 } : x))),
      );
    }
    expect(renders.pa).toBeGreaterThan(base.pa);
    expect(renders.pb).toBe(base.pb);
  });

  it("タブ切替 (activeTabId の変更) では切り替えたペインだけが再レンダーされる", async () => {
    const { store, renders } = setup();
    await waitFor(() => expect(screen.getAllByRole("tab").length).toBe(3));
    const base = { ...renders };
    act(() => store.setPanes((prev) => prev.map((p) => (p.id === "pa" ? { ...p, activeTabId: "a2" } : p))));
    expect(renders.pa).toBeGreaterThan(base.pa);
    expect(renders.pb).toBe(base.pb);
  });

  it("タブのタイトル変更は、そのタブを持つペインのタブバーに反映され、他方は再レンダーされない", async () => {
    const { store, renders } = setup();
    await waitFor(() => expect(screen.getAllByRole("tab").length).toBe(3));
    const base = { ...renders };
    act(() => store.setTabs((prev) => prev.map((x) => (x.id === "b1" ? { ...x, title: "改名 B" } : x))));
    await waitFor(() => expect(screen.getByRole("tab", { name: /改名 B/ })).toBeTruthy());
    expect(renders.pb).toBeGreaterThan(base.pb);
    expect(renders.pa).toBe(base.pa);
  });

  it.each([
    ["showChart", "chart"],
    ["showPivot", "pivot"],
  ] as const)("同じ表示モード (%s) のタブ同士を切り替えると、ビューが作り直される (#1323)", async (flag, kind) => {
    const { store } = setup();
    await waitFor(() => expect(screen.getAllByRole("tab").length).toBe(3));
    const result = { columns: [], rows: [] } as never;
    act(() =>
      store.setTabs((prev) =>
        prev.map((x) => (x.id === "a1" || x.id === "a2" ? { ...x, [flag]: true, result } : x)),
      ),
    );
    await waitFor(() => expect(screen.getByText(`${kind}-stub`)).toBeTruthy());
    const before = viewMounts[kind];
    act(() => store.setPanes((prev) => prev.map((p) => (p.id === "pa" ? { ...p, activeTabId: "a2" } : p))));
    await waitFor(() => expect(viewMounts[kind]).toBeGreaterThan(before));
  });

  it("env の値 (接続など) が変わったら、全ペインが再レンダーされる", async () => {
    const { renders, base: baseEnv, setEnv } = setup();
    await waitFor(() => expect(screen.getAllByRole("tab").length).toBe(3));
    const before = { ...renders };
    setEnv({ ...baseEnv, readOnly: true });
    expect(renders.pa).toBeGreaterThan(before.pa);
    expect(renders.pb).toBeGreaterThan(before.pb);
  });
});
