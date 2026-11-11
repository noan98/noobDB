import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, renderWithProviders, screen, waitFor, within } from "./testUtils";
import { PaneView, type PaneActions, type PaneEnv } from "../components/PaneView";
import type { ResultGridHandle } from "../components/ResultGrid";
import type { DrillCondition } from "../components/drillFilter";
import { TabPaneStore } from "../tabPaneStore";
import { TabDirtyWatcher, TabSqlStore } from "../tabSqlStore";
import { useKeyedStable } from "../useKeyedStable";
import { resolveShortcutBindings } from "../shortcuts";
import { setLocale, t } from "../i18n";
import type { PaneState, Tab } from "../App";
import type { CellValue, QueryResult } from "../api/tauri";
import type { ResultViewKind } from "../components/ResultViewSwitch";

// ピボット / チャートから絞り込んだグリッドへ移る一連の流れを PaneView 経由で固定する (#2236)。
// ピボット本体はスタブ (ボタンで onDrill を呼ぶ)。グリッドとチップ・タブの表示切替は実物。

const pivotProps = vi.hoisted(() => ({ initialScrollTop: undefined as number | undefined }));
vi.mock("../components/PivotView", () => ({
  PivotView: (props: {
    onDrill?: (d: { conditions: DrillCondition[]; scrollTop: number }) => void;
    initialScrollTop?: number;
  }) => {
    pivotProps.initialScrollTop = props.initialScrollTop;
    return (
      <>
        <button
          type="button"
          onClick={() =>
            props.onDrill?.({ conditions: [{ colIdx: 0, column: "region", value: "east" }], scrollTop: 77 })
          }
        >
          drill-east
        </button>
        <button
          type="button"
          onClick={() =>
            props.onDrill?.({ conditions: [{ colIdx: 0, column: "region", value: "west" }], scrollTop: 0 })
          }
        >
          drill-west
        </button>
      </>
    );
  },
}));

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
    autoLimitSkip: null,
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

function makeEnv(
  store: TabPaneStore<Tab, PaneState>,
  overrides: Partial<PaneEnv> = {},
  patchActions: Partial<PaneActions> = {},
): PaneEnv {
  const tabSqlStore = new TabSqlStore();
  const noop = () => {};
  // どのハンドラも呼ばれたらテストの観測対象にならない no-op (参照だけ固定する)。
  const cache = new Map<string, () => void>();
  const actions = new Proxy({ ...patchActions } as PaneActions, {
    get: (target, key: string) => {
      if (key in target) return (target as unknown as Record<string, unknown>)[key];
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
    txActive: false,
    selectedProfile: null,
    layoutMode: "normal",
    readOnly: false,
    emergencyMode: false,
    broadcastAvailable: false,
    queryHistory: [],
    completionSnippets: [],
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

const ROWS: CellValue[][] = [
  ["east", "paid", 10],
  ["east", "open", 5],
  ["west", "paid", 20],
  ["west", "open", 5],
];
const RESULT: QueryResult = {
  columns: [
    { name: "region", type_name: "VARCHAR" },
    { name: "status", type_name: "VARCHAR" },
    { name: "amount", type_name: "INT" },
  ],
  rows: ROWS,
  rows_affected: 0,
  elapsed_ms: 1,
};

function setup() {
  const store = new TabPaneStore<Tab, PaneState>();
  store.setTabs([{ ...makeTab("t1", "T1"), result: RESULT, showPivot: true }]);
  store.setPanes([{ id: "p", tabIds: ["t1"], activeTabId: "t1" }]);
  const handle: { current: ResultGridHandle | null } = { current: null };
  const views: ResultViewKind[] = [];
  const setResultView = (tabId: string, view: ResultViewKind) => {
    views.push(view);
    store.setTabs((prev) =>
      prev.map((x) =>
        x.id === tabId
          ? { ...x, showPivot: view === "pivot", showChart: view === "chart", showJson: false }
          : x,
      ),
    );
  };
  const env = makeEnv(
    store,
    { getGridRefSetter: () => (h: ResultGridHandle | null) => void (handle.current = h ?? handle.current) },
    { setResultView },
  );
  const view = renderWithProviders(<PaneView paneId="p" split={false} isFocused env={env} />);
  const rows = () => view.container.querySelectorAll("tbody tr").length;
  const show = (v: ResultViewKind) => act(() => setResultView("t1", v));
  return { store, handle, views, rows, show };
}

const originalResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
const originalScrollIntoView = Element.prototype.scrollIntoView;
beforeAll(async () => {
  // PaneView は ResultGrid を lazy import する。巨大なモジュールの初回の読み込みと変換が
  // waitFor の既定 (1 秒) を超えうるので、先に読み込んでおく (最初のテストだけ落ちていた)。
  await import("../components/ResultGrid");
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
beforeEach(() => {
  localStorage.clear();
  setLocale("en");
  pivotProps.initialScrollTop = undefined;
});

const amount5 = { mode: "apply", conditions: [{ colIdx: 2, column: "amount", value: "5" }] } as const;

describe("ピボットから絞り込んだグリッド (#2236)", () => {
  it("drill でチップが出て絞り込まれ、戻る → グリッドへ戻っても同じ要求は再適用されない", async () => {
    const user = userEvent.setup();
    const { rows, show, handle } = setup();
    // 元のグリッドで amount=5 のフィルタを掛けておく (適用前の状態)。
    await screen.findByText("drill-east");
    show("grid");
    await waitFor(() => expect(handle.current).not.toBeNull());
    act(() => handle.current?.applyColumnFilters({ ...amount5, conditions: [...amount5.conditions] }));
    await waitFor(() => expect(rows()).toBe(2));
    show("pivot");

    await user.click(await screen.findByText("drill-east"));
    const chip = await screen.findByTestId("drill-chip");
    expect(chip).toHaveTextContent("Filtered from pivot: region=east");
    // region=east だけに置き換わる (amount=5 は外れる)。
    await waitFor(() => expect(rows()).toBe(2));

    // 絞り込み後に amount=10 を足す (region=east のまま)。
    act(() =>
      handle.current?.applyColumnFilters({
        mode: "apply",
        conditions: [
          { colIdx: 0, column: "region", value: "east" },
          { colIdx: 2, column: "amount", value: "10" },
        ],
      }),
    );
    await waitFor(() => expect(rows()).toBe(1));
    // 戻る → ピボット (スクロール位置を復元) → 再びグリッド。要求は再適用されない。
    await user.click(within(screen.getByTestId("drill-chip")).getByRole("button", { name: /Back to pivot/ }));
    await screen.findByText("drill-east");
    expect(pivotProps.initialScrollTop).toBe(77);
    show("grid");
    await waitFor(() => expect(screen.getByTestId("drill-chip")).toBeInTheDocument());
    expect(rows()).toBe(1);
  });

  it("絞り込みを外すと、チップが消えて元のフィルタ (amount=5) が戻る", async () => {
    const user = userEvent.setup();
    const { rows, show, handle } = setup();
    await screen.findByText("drill-east");
    show("grid");
    await waitFor(() => expect(handle.current).not.toBeNull());
    act(() => handle.current?.applyColumnFilters({ ...amount5, conditions: [...amount5.conditions] }));
    await waitFor(() => expect(rows()).toBe(2));
    show("pivot");
    await user.click(await screen.findByText("drill-east"));
    await screen.findByTestId("drill-chip");
    await waitFor(() => expect(rows()).toBe(2));
    const body = () => document.querySelector("tbody")?.textContent ?? "";
    expect(body()).not.toContain("west");

    await user.click(within(screen.getByTestId("drill-chip")).getByRole("button", { name: /Clear filter/ }));
    await waitFor(() => expect(screen.queryByTestId("drill-chip")).toBeNull());
    // region の絞り込みは外れ、drill で置き換わった amount=5 が復元される (east/west の open 2 行)。
    await waitFor(() => expect(rows()).toBe(2));
    expect(body()).toContain("west");
  });

  it("グリッド側で手動で条件の列のフィルタを外すと、チップが消える", async () => {
    const { rows, show, handle } = setup();
    show("pivot");
    await userEvent.setup().click(await screen.findByText("drill-east"));
    await screen.findByTestId("drill-chip");
    await waitFor(() => expect(rows()).toBe(2));
    act(() =>
      handle.current?.applyColumnFilters({
        mode: "clear",
        conditions: [{ colIdx: 0, column: "region", value: "east" }],
      }),
    );
    await waitFor(() => expect(screen.queryByTestId("drill-chip")).toBeNull());
    expect(rows()).toBe(4);
  });

  it("結果が入れ替わる (再実行) とチップは出ない", async () => {
    const { store, show } = setup();
    show("pivot");
    await userEvent.setup().click(await screen.findByText("drill-east"));
    await screen.findByTestId("drill-chip");
    act(() => store.setTabs((prev) => prev.map((x) => ({ ...x, result: { ...RESULT, rows: [...ROWS] } }))));
    await waitFor(() => expect(screen.queryByTestId("drill-chip")).toBeNull());
  });

  it("絞り込み中に別の集計キーへ drill し直しても、外すと最初の drill 前のフィルタに戻る", async () => {
    const user = userEvent.setup();
    const { rows, show, handle } = setup();
    await screen.findByText("drill-east");
    show("grid");
    await waitFor(() => expect(handle.current).not.toBeNull());
    act(() => handle.current?.applyColumnFilters({ ...amount5, conditions: [...amount5.conditions] }));
    await waitFor(() => expect(rows()).toBe(2));
    show("pivot");
    await user.click(await screen.findByText("drill-east"));
    await screen.findByTestId("drill-chip");
    await waitFor(() => expect(rows()).toBe(2));
    // 戻って別のキー (west) へ drill し直す。
    await user.click(within(screen.getByTestId("drill-chip")).getByRole("button", { name: /Back to pivot/ }));
    await user.click(await screen.findByText("drill-west"));
    await waitFor(() => expect(screen.getByTestId("drill-chip")).toHaveTextContent("region=west"));
    const body = () => document.querySelector("tbody")?.textContent ?? "";
    await waitFor(() => expect(body()).not.toContain("east"));

    await user.click(within(screen.getByTestId("drill-chip")).getByRole("button", { name: /Clear filter/ }));
    await waitFor(() => expect(screen.queryByTestId("drill-chip")).toBeNull());
    // 戻るのは最初の状態 (amount=5 → east / west の open)。east の drill 条件ではない。
    await waitFor(() => expect(body()).toContain("west"));
    expect(body()).toContain("east");
    expect(rows()).toBe(2);
  });

  it("グリッドの検索語が残っていても drill で 0 行にならず、外すと検索語が戻る", async () => {
    const user = userEvent.setup();
    const { rows, show } = setup();
    await screen.findByText("drill-east");
    show("grid");
    const input = await screen.findByLabelText(t("gridSearchAria"));
    await user.type(input, "west");
    await waitFor(() => expect(rows()).toBe(2));
    show("pivot");
    await user.click(await screen.findByText("drill-east"));
    await screen.findByTestId("drill-chip");
    await waitFor(() =>
      expect((screen.getByLabelText(t("gridSearchAria")) as HTMLInputElement).value).toBe(""),
    );
    await waitFor(() => expect(rows()).toBe(2));
    expect(document.querySelector("tbody")?.textContent).toContain("east");

    await user.click(within(screen.getByTestId("drill-chip")).getByRole("button", { name: /Clear filter/ }));
    await waitFor(() =>
      expect((screen.getByLabelText(t("gridSearchAria")) as HTMLInputElement).value).toBe("west"),
    );
    await waitFor(() => expect(rows()).toBe(2));
    expect(document.querySelector("tbody")?.textContent).toContain("west");
  });
});
