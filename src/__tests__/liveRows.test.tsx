import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { renderWithProviders as render } from "./testUtils";
import { LiveFlashOverlay, useLiveChanges } from "../components/LiveRows";
import type { LiveField } from "../components/liveDiff";

interface Row {
  id: number;
  v: number;
}
const keyOf = (r: Row) => r.id;
const fields: readonly LiveField<Row, "v">[] = [{ name: "v", changed: (a, b) => a.v !== b.v }];

describe("useLiveChanges resetKey (#2213)", () => {
  it("rows と同時に resetKey が変わった世代は光らせない", () => {
    const { result, rerender } = renderHook(
      ({ rows, reset }: { rows: Row[]; reset: boolean }) => useLiveChanges(rows, keyOf, fields, reset),
      { initialProps: { rows: [{ id: 1, v: 1 }], reset: false } },
    );
    rerender({ rows: [{ id: 1, v: 2 }], reset: false });
    expect(result.current.flashToken(1, "v")).not.toBeNull();
    rerender({ rows: [{ id: 1, v: 3 }], reset: true });
    expect(result.current.flashToken(1, "v")).toBeNull();
    // 次のポーリングからは通常どおり光る。
    rerender({ rows: [{ id: 1, v: 4 }], reset: true });
    expect(result.current.flashToken(1, "v")).not.toBeNull();
  });
});

describe("LiveFlashOverlay (#2213)", () => {
  it("token が null なら何も描画せず、数値なら兄弟として ring を出す", () => {
    const { container, rerender } = render(
      <div>
        <span data-testid="tile">tile</span>
        <LiveFlashOverlay token={null} />
      </div>,
    );
    expect(container.querySelector("[data-live-flash]")).toBeNull();
    const tile = container.querySelector("[data-testid=tile]");
    rerender(
      <div>
        <span data-testid="tile">tile</span>
        <LiveFlashOverlay token={1} />
      </div>,
    );
    expect(container.querySelector(".flash-ring")).not.toBeNull();
    // 中身は包まないので、フラッシュの前後で同じ DOM のまま。
    expect(container.querySelector("[data-testid=tile]")).toBe(tile);
  });
});
