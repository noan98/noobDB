import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { makeProfile } from "./fixtures/componentFixtures";
import { renderHook } from "@testing-library/react";
import { t } from "../i18n";
import { useStableCallbacks } from "../useStableCallbacks";

/**
 * Issue #1314 (スキーマツリーの不要な再レンダーをなくす) の回帰テスト。
 *
 * React DevTools Profiler での実測はヘッドレス環境では難しいので、再レンダー回数を
 * 数えるテストで代替する (`resultGridRerender.test.tsx` と同じ方針)。
 * - `ui` の `Input` は `ConnectionList` が 1 レンダーにつき 1 回だけ描くフィルタ入力
 *   なので、その描画回数 = `ConnectionList` 本体のレンダー回数。
 * - `tree` の `TreeRow` はテーブル / 列などの行の描画回数を `data-tree-key` ごとに数える。
 * - `tree` の `TreeCollapse` はマウント回数を数える (閉じたテーブルがマウントしないこと)。
 */
const counts = vi.hoisted(() => ({
  list: 0,
  rows: new Map<string, number>(),
  collapseMounts: 0,
}));

vi.mock("../components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/ui")>();
  const React = await import("react");
  const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<typeof actual.Input>>(
    function CountedInput(props, ref) {
      counts.list += 1;
      return <actual.Input ref={ref} {...props} />;
    },
  );
  return { ...actual, Input };
});

vi.mock("../components/tree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/tree")>();
  const React = await import("react");
  const TreeRow = React.forwardRef<HTMLDivElement, React.ComponentProps<typeof actual.TreeRow>>(
    function CountedTreeRow(props, ref) {
      const key = (props as Record<string, unknown>)["data-tree-key"];
      if (typeof key === "string") counts.rows.set(key, (counts.rows.get(key) ?? 0) + 1);
      return <actual.TreeRow ref={ref} {...props} />;
    },
  );
  function TreeCollapse(props: React.ComponentProps<typeof actual.TreeCollapse>) {
    React.useEffect(() => {
      counts.collapseMounts += 1;
    }, []);
    return <actual.TreeCollapse {...props} />;
  }
  return { ...actual, TreeRow, TreeCollapse };
});

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  const listDatabases = vi.fn().mockResolvedValue(["db1"]);
  const listTables = vi.fn().mockResolvedValue(["tbl1", "tbl2", "tbl3"]);
  const describeTable = vi.fn().mockResolvedValue([
    {
      name: "id",
      data_type: "int",
      nullable: false,
      key: "PRI",
      default: null,
      extra: "",
      referenced_table: null,
      referenced_column: null,
    },
  ]);
  const listIndexes = vi.fn().mockResolvedValue([]);
  return {
    ...actual,
    api: {
      ...actual.api,
      listDatabases,
      listTables,
      describeTable,
      listIndexes,
      tableRowEstimates: vi.fn().mockResolvedValue([]),
      listSchemaObjects: vi.fn().mockResolvedValue([]),
      loadSchemaTree: vi.fn(async (sid: string) => ({
        databases: (await listDatabases(sid)) as string[],
        open: [],
        tables: [],
      })),
      listTablesAll: vi.fn(async () => [{ database: "db1", tables: ["tbl1", "tbl2", "tbl3"] }]),
    },
  };
});

import { ConnectionList } from "../components/ConnectionList";

const noop = () => {};
const profile = makeProfile({ id: "p-a", name: "Alpha DB" });
// 参照が変わらない props (App 側で安定化した状態を模す)。
const stableProps = {
  profiles: [profile],
  activeProfileId: "p-a",
  sessionId: "s1",
  connectingId: null,
  errorProfileId: null,
  onConnect: noop,
  onCreate: noop,
  onEdit: noop,
  onDuplicate: noop,
  onDelete: noop,
  onPickTable: noop,
  onImportTable: noop,
  onDumpDatabase: noop,
  onRunTableSelect: noop,
  onInsertTableSelect: noop,
  onOpenObjectDefinition: noop,
  selectLimit: 200,
};

function Harness() {
  // `ConnectionList` に渡らない state — 打鍵・ストリーミング・タブ切替で再レンダーされる
  // App の状態を模す。
  const [tick, setTick] = useState(0);
  return (
    <div>
      <button onClick={() => setTick((v) => v + 1)}>tick:{tick}</button>
      <ConnectionList {...stableProps} />
    </div>
  );
}

async function openTree() {
  renderWithProviders(<Harness />);
  fireEvent.click(await screen.findByRole("treeitem", { name: "db1" }));
  await screen.findByRole("treeitem", { name: "tbl3" });
}

function resetCounts() {
  counts.list = 0;
  counts.rows.clear();
}

const rowCount = (key: string) => counts.rows.get(key) ?? 0;

describe("スキーマツリーの再レンダー削減 (#1314)", () => {
  beforeEach(() => {
    localStorage.clear();
    counts.collapseMounts = 0;
    resetCounts();
  });

  it("props が変わらない親の再レンダーでは ConnectionList も行も描き直されない", async () => {
    await openTree();
    resetCounts();

    for (let i = 0; i < 5; i++) fireEvent.click(screen.getByText(/^tick:/));

    expect(screen.getByText("tick:5")).toBeInTheDocument();
    expect(counts.list).toBe(0);
    expect(counts.rows.size).toBe(0);
  });

  it("行にフォーカスが入っても、再レンダーされるのは前後の 2 行だけで他の行と本体は描き直されない", async () => {
    await openTree();
    const tbl1 = screen.getByRole("treeitem", { name: "tbl1" });
    const tbl2 = screen.getByRole("treeitem", { name: "tbl2" });
    resetCounts();

    act(() => tbl1.focus());
    expect(tbl1).toHaveAttribute("tabindex", "0");
    expect(rowCount("tbl:db1::tbl1")).toBeGreaterThan(0);
    // 止まり先でなかった行は `memo` + 外部ストアのおかげで描き直されない。
    expect(rowCount("tbl:db1::tbl2")).toBe(0);
    expect(rowCount("tbl:db1::tbl3")).toBe(0);
    expect(counts.list).toBe(0);

    resetCounts();
    act(() => tbl2.focus());
    expect(tbl2).toHaveAttribute("tabindex", "0");
    expect(tbl1).toHaveAttribute("tabindex", "-1");
    expect(rowCount("tbl:db1::tbl1")).toBeGreaterThan(0);
    expect(rowCount("tbl:db1::tbl2")).toBeGreaterThan(0);
    expect(rowCount("tbl:db1::tbl3")).toBe(0);
    expect(counts.list).toBe(0);
  });

  it("ツールチップの表示・非表示でツリー本体も行も描き直されない", async () => {
    await openTree();
    resetCounts();

    const tbl2 = screen.getByRole("treeitem", { name: "tbl2" });
    fireEvent.mouseEnter(tbl2);
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();
    fireEvent.mouseLeave(tbl2);
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());

    expect(counts.list).toBe(0);
    expect(counts.rows.size).toBe(0);
  });

  it("閉じているテーブルには TreeCollapse をマウントせず、開いた行にだけマウントする", async () => {
    await openTree();
    // プロファイルと DB の 2 つだけ (テーブル 3 件はどれも閉じている)。
    expect(counts.collapseMounts).toBe(2);

    fireEvent.click(screen.getByRole("button", { name: t("treeToggleColumnsAria", { table: "tbl1" }) }));
    expect(await screen.findByText("id")).toBeInTheDocument();
    expect(counts.collapseMounts).toBe(3);

    // 閉じると、退場アニメの後に列が外れ、TreeCollapse ごとアンマウントされる。
    fireEvent.click(screen.getByRole("button", { name: t("treeToggleColumnsAria", { table: "tbl1" }) }));
    await waitFor(() => expect(screen.queryByText("id")).not.toBeInTheDocument());
  });

  it("検索入力で絞り込まれ、ほかの行のフォーカス管理 (roving tabindex) は維持される", async () => {
    await openTree();
    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "tbl2" } });

    await waitFor(() => expect(screen.queryByRole("treeitem", { name: "tbl1" })).not.toBeInTheDocument());
    expect(screen.getByRole("treeitem", { name: "tbl2" })).toBeInTheDocument();
    // どの行も止まり先になっていない状態にはならない (Tab でツリーに入れる)。
    const stops = screen
      .getAllByRole("treeitem")
      .filter((el) => el.getAttribute("tabindex") === "0");
    expect(stops).toHaveLength(1);
  });

  it("止まり先の行が消えたら、先頭の行へ止まり先が戻る", async () => {
    await openTree();
    const tbl1 = screen.getByRole("treeitem", { name: "tbl1" });
    act(() => tbl1.focus());
    expect(tbl1).toHaveAttribute("tabindex", "0");

    // DB を閉じるとテーブル行が外れる。
    fireEvent.click(screen.getByRole("treeitem", { name: "db1" }));
    await waitFor(() => expect(screen.queryByRole("treeitem", { name: "tbl1" })).not.toBeInTheDocument());
    await waitFor(() => {
      const stops = screen
        .getAllByRole("treeitem")
        .filter((el) => el.getAttribute("tabindex") === "0");
      expect(stops).toHaveLength(1);
    });
  });
});

describe("useStableCallbacks (#1314)", () => {
  it("返す関数の参照は変わらず、呼ぶと最新のハンドラへ委譲する", () => {
    const first = vi.fn(() => "a");
    const second = vi.fn(() => "b");
    const { result, rerender } = renderHook(({ fn }) => useStableCallbacks({ onPick: fn }), {
      initialProps: { fn: first as () => string },
    });
    const initial = result.current.onPick;
    expect(initial()).toBe("a");

    rerender({ fn: second as () => string });
    expect(result.current.onPick).toBe(initial);
    expect(initial()).toBe("b");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("未定義のキーは undefined のまま返し、定義の有無が変わったときだけ作り直す", () => {
    const fn = vi.fn();
    const { result, rerender } = renderHook(
      ({ on }) => useStableCallbacks({ onPick: fn, onOptional: on ? fn : undefined }),
      { initialProps: { on: false } },
    );
    expect(result.current.onOptional).toBeUndefined();
    const stable = result.current.onPick;

    rerender({ on: false });
    expect(result.current.onPick).toBe(stable);

    rerender({ on: true });
    expect(result.current.onOptional).toBeTypeOf("function");
  });
});
