import src from "../App.tsx?raw";
import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen } from "./testUtils";
import { ResultGrid, type ResultGridHandle } from "../components/ResultGrid";
import { KeepAlive } from "../components/KeepAlive";
import { ResultGridSlot } from "../components/ResultGridSlot";
import { GRID_KEEP_ALIVE_LIMIT } from "../components/keepAliveSet";
import type { QueryResult } from "../api/tauri";
import { setLocale, t } from "../i18n";

// タブ切替・結果ビュー切替で ResultGrid を作り直さない (#1309)。
// DataGrid は本体で useReactTable を 1 回呼ぶので、マウント回数は ResultGrid の
// 「マウント時の初期化」を数える代わりに、Find バーなど内部 state の生存で確かめる。

const mounts = vi.hoisted(() => ({ count: 0 }));
vi.mock("../components/ResultGrid", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../components/ResultGrid")>();
  const React = await import("react");
  const Inner = mod.ResultGrid;
  const Counted = React.forwardRef<unknown, React.ComponentProps<typeof Inner>>((props, ref) => {
    React.useEffect(() => {
      mounts.count += 1;
    }, []);
    return React.createElement(Inner, { ...props, ref } as never);
  });
  return { ...mod, ResultGrid: Counted };
});

function mk(name: string): QueryResult {
  return {
    columns: [{ name: `${name}_col`, type_name: "INT" }],
    rows: Array.from({ length: 5 }, (_, i) => [i]),
    rows_affected: 5,
    elapsed_ms: 1,
  };
}
const results: Record<string, QueryResult> = { a: mk("a"), b: mk("b"), c: mk("c"), d: mk("d") };
const gridBindings = {} as never;

function Host({
  active,
  limit = GRID_KEEP_ALIVE_LIMIT,
  live = ["a", "b", "c", "d"],
  register,
}: {
  /** null なら結果ビュー (チャート等) を表示中でグリッドは隠れる。 */
  active: string | null;
  limit?: number;
  live?: string[];
  register: (h: ResultGridHandle | null) => void;
}) {
  return (
    <KeepAlive activeKey={active} limit={limit} liveKeys={live}>
      {/* 実 App と同じく、アクティブなタブの要素だけを渡す */}
      <ResultGridSlot register={register}>
        {(ref) => (
          <ResultGrid
            ref={ref}
            result={results[active ?? "a"]}
            gridBindings={gridBindings}
          />
        )}
      </ResultGridSlot>
    </KeepAlive>
  );
}

const findInput = () => screen.queryByLabelText(t("gridFindInputAria"));

describe("結果グリッドの keep-alive (#1309)", () => {
  beforeEach(() => {
    setLocale("en");
    mounts.count = 0;
  });

  it("上限は 3〜5 個の定数", () => {
    expect(GRID_KEEP_ALIVE_LIMIT).toBeGreaterThanOrEqual(3);
    expect(GRID_KEEP_ALIVE_LIMIT).toBeLessThanOrEqual(5);
  });

  it("タブを往復しても再マウントされず、Find バーの状態が保たれる", () => {
    let handle: ResultGridHandle | null = null;
    const register = (h: ResultGridHandle | null) => {
      handle = h;
    };
    const view = renderWithProviders(<Host active="a" register={register} />);
    act(() => handle!.openFind());
    expect(findInput()).toBeInTheDocument();
    view.rerender(<Host active="b" register={register} />);
    view.rerender(<Host active="a" register={register} />);
    expect(mounts.count).toBe(2); // a と b の 2 回だけ (a は作り直されない)
    expect(findInput()).toBeInTheDocument();
  });

  it("結果ビュー (チャート等) へ切り替えて戻っても再マウントされない", () => {
    let handle: ResultGridHandle | null = null;
    const register = (h: ResultGridHandle | null) => {
      handle = h;
    };
    const view = renderWithProviders(<Host active="a" register={register} />);
    act(() => handle!.openFind());
    view.rerender(<Host active={null} register={register} />);
    expect(handle).toBeNull(); // 隠れている間はハンドルを公開しない
    view.rerender(<Host active="a" register={register} />);
    expect(mounts.count).toBe(1);
    expect(findInput()).toBeInTheDocument();
  });

  it("保持数の上限を超えた古いタブは破棄される (メモリが増え続けない)", () => {
    const register = vi.fn();
    const view = renderWithProviders(<Host active="a" limit={2} register={register} />);
    for (const k of ["b", "c"]) view.rerender(<Host active={k} limit={2} register={register} />);
    expect(document.querySelectorAll("[data-keep-alive-active]")).toHaveLength(2);
    // a は追い出されたので、戻ると新しくマウントされる
    view.rerender(<Host active="a" limit={2} register={register} />);
    expect(mounts.count).toBe(4);
    expect(document.querySelectorAll("[data-keep-alive-active]")).toHaveLength(2);
  });

  it("閉じたタブは上限に達していなくても保持から外れる", () => {
    const register = vi.fn();
    const view = renderWithProviders(<Host active="a" register={register} />);
    view.rerender(<Host active="b" register={register} />);
    expect(document.querySelectorAll("[data-keep-alive-active]")).toHaveLength(2);
    view.rerender(<Host active="b" live={["b", "c"]} register={register} />);
    expect(document.querySelectorAll("[data-keep-alive-active]")).toHaveLength(1);
  });

  it("ref (ペイン単位の登録先) はアクティブなタブのグリッドだけを指す", () => {
    const calls: Array<ResultGridHandle | null> = [];
    const register = (h: ResultGridHandle | null) => {
      calls.push(h);
    };
    const view = renderWithProviders(<Host active="a" register={register} />);
    const handleA = calls[calls.length - 1];
    expect(handleA).not.toBeNull();
    view.rerender(<Host active="b" register={register} />);
    const handleB = calls[calls.length - 1];
    expect(handleB).not.toBeNull();
    expect(handleB).not.toBe(handleA);
    // b をアクティブにしたあと、登録先は b のハンドルで、Find は b のグリッドで開く
    act(() => handleB!.openFind());
    const inputs = document.querySelectorAll(`[aria-label="${t("gridFindInputAria")}"]`);
    expect(inputs).toHaveLength(1);
    const owner = (inputs[0] as HTMLElement).closest("[data-keep-alive-active]") as HTMLElement;
    expect(owner.dataset.keepAliveActive).toBe("true");
    // a に戻すと a のハンドルに戻る
    view.rerender(<Host active="a" register={register} />);
    expect(calls[calls.length - 1]).toBe(handleA);
  });

  it("隠れている間は行を描かず (全行フォールバックに落ちない)、再表示で描き直す", () => {
    const register = vi.fn();
    const view = renderWithProviders(<Host active="a" register={register} />);
    const rowsIn = () =>
      Array.from(document.querySelectorAll("[data-keep-alive-active]")).map((el) => [
        (el as HTMLElement).dataset.keepAliveActive,
        el.querySelectorAll("tbody tr").length,
      ]);
    expect(rowsIn()).toEqual([["true", 5]]);
    view.rerender(<Host active="b" register={register} />);
    const states = rowsIn();
    expect(states).toContainEqual(["false", 0]); // a は保持しているが行は描かない
    expect(states).toContainEqual(["true", 5]);
    view.rerender(<Host active="a" register={register} />);
    expect(rowsIn()).toContainEqual(["true", 5]);
  });

  it("App は ResultGrid に key={tab.id} を付けず KeepAlive 経由で保持する", () => {
    const i = src.indexOf("<ResultGrid\n");
    expect(i).toBeGreaterThan(0);
    expect(src.slice(i, i + 120)).not.toMatch(/key=\{tab\.id\}/);
    expect(src).toContain("limit={GRID_KEEP_ALIVE_LIMIT}");
    expect(src).toContain("<ResultGridSlot register={getGridRefSetter(pane.id)}>");
  });
});
