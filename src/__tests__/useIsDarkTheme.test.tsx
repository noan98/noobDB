import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useIsDarkTheme } from "../colorScale";

describe("useIsDarkTheme の購読 (#1616)", () => {
  it("複数コンポーネントが購読しても MutationObserver は 1 つで、全員が 0 になったら disconnect する", async () => {
    const Orig = globalThis.MutationObserver;
    let created = 0;
    let disconnected = 0;
    class Counting extends Orig {
      constructor(cb: MutationCallback) {
        super(cb);
        created++;
      }
      disconnect() {
        disconnected++;
        super.disconnect();
      }
    }
    vi.stubGlobal("MutationObserver", Counting);
    try {
      document.documentElement.setAttribute("data-theme", "light");
      const a = renderHook(() => useIsDarkTheme());
      const b = renderHook(() => useIsDarkTheme());
      expect(created).toBe(1);
      await act(async () => {
        document.documentElement.setAttribute("data-theme", "dark");
        await Promise.resolve();
      });
      expect(a.result.current).toBe(true);
      expect(b.result.current).toBe(true);
      a.unmount();
      expect(disconnected).toBe(0);
      b.unmount();
      expect(disconnected).toBe(1);
    } finally {
      vi.unstubAllGlobals();
      document.documentElement.removeAttribute("data-theme");
    }
  });
});
