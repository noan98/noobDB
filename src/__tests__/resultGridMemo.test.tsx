import { useState } from "react";
import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, fireEvent } from "./testUtils";
import { ResultGrid } from "../components/ResultGrid";
import { useKeyedStable } from "../useKeyedStable";
import type { QueryResult } from "../api/tauri";
import { setLocale } from "../i18n";

// DataGrid は本体で useReactTable を 1 回呼ぶ (ラッパーの ResultGrid は呼ばない)。
// その呼び出し回数を DataGrid の再レンダー回数として数える (#1313)。
const tableRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("@tanstack/react-table", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@tanstack/react-table")>();
  return {
    ...mod,
    useTable: ((...args: Parameters<typeof mod.useTable>) => {
      tableRenders.count += 1;
      return mod.useTable(...args);
    }) as typeof mod.useTable,
  };
});

const result: QueryResult = {
  columns: [
    { name: "id", type_name: "INT" },
    { name: "name", type_name: "VARCHAR" },
  ],
  rows: Array.from({ length: 20 }, (_, i) => [i, `row-${i}`]),
  rows_affected: 20,
  elapsed_ms: 1,
};

// App から渡る props は参照が固定されている前提 (App 側は useKeyedStable で固定する)。
const noop = () => {};
const saveAsTable = noop;
const gridBindings = {} as never;

function Harness({ streaming = false }: { streaming?: boolean }) {
  const [n, setN] = useState(0);
  return (
    <div>
      <button onClick={() => setN((v) => v + 1)}>rerender:{n}</button>
      <ResultGrid
        result={result}
        streaming={streaming}
        onSaveAsTable={saveAsTable}
        gridBindings={gridBindings}
      />
    </div>
  );
}

describe("結果グリッドの再レンダー抑制 (#1313)", () => {
  beforeEach(() => setLocale("en"));
  afterEach(() => vi.useRealTimers());

  it("親が再レンダーされても DataGrid は再レンダーされない", () => {
    renderWithProviders(<Harness />);
    const base = tableRenders.count;
    expect(base).toBeGreaterThan(0);
    for (let i = 0; i < 5; i++) fireEvent.click(screen.getByText(new RegExp(`rerender:${i}`)));
    expect(tableRenders.count).toBe(base);
  });

  it("ストリーミングの経過時間の更新で DataGrid は再レンダーされず、表示だけが進む", () => {
    vi.useFakeTimers();
    renderWithProviders(<Harness streaming />);
    const base = tableRenders.count;
    expect(document.body.textContent).toContain("(00:00)");
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(tableRenders.count).toBe(base);
    expect(document.body.textContent).toContain("(00:02)");
  });

  it("親の再レンダーではツールバーの計測 (レイアウト読み取り) が走らない", () => {
    renderWithProviders(<Harness />);
    const original = HTMLElement.prototype.getBoundingClientRect;
    let toolbarReads = 0;
    const spy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.dataset.toolbarAction) toolbarReads += 1;
        return original.call(this);
      });
    for (let i = 0; i < 5; i++) fireEvent.click(screen.getByText(new RegExp(`rerender:${i}`)));
    spy.mockRestore();
    expect(toolbarReads).toBe(0);
  });
});

describe("useKeyedStable", () => {
  it("同じキーなら関数の参照が固定され、最新のクロージャへ委譲する", () => {
    const seen: Array<ReturnType<ReturnType<typeof useKeyedStable>["fn"]>> = [];
    let stable: ReturnType<typeof useKeyedStable> | null = null;
    function C({ v }: { v: number }) {
      stable = useKeyedStable();
      const f = stable.fn("a", () => v);
      seen.push(f as never);
      return null;
    }
    const { rerender } = renderWithProviders(<C v={1} />);
    rerender(<C v={2} />);
    expect(seen[0]).toBe(seen[1]);
    expect((seen[1] as () => number)()).toBe(2);
    const s = stable as unknown as ReturnType<typeof useKeyedStable>;
    expect(s.memo("m", [1], () => ({}))).toBe(s.memo("m", [1], () => ({})));
    expect(s.memo("m", [1], () => ({}))).not.toBe(s.memo("m", [2], () => ({})));
  });
});
