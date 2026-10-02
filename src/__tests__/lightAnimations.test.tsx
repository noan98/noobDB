import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MotionConfig } from "motion/react";
import { beforeAll, describe, expect, it } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { ChakraProvider } from "@chakra-ui/react";
import { StreamProgressBar } from "../components/StreamProgressBar";
import { TabBar, type TabInfo } from "../components/TabBar";
import { variants } from "../motion";
import { system } from "../theme";
import { renderWithProviders, screen } from "./testUtils";

/**
 * レイアウトを起こす補間 (height / width / grid-template-columns) と、描画のやり直しを
 * 伴う補間 (box-shadow) を軽い transform / opacity へ置き換えたこと、および reduced-motion
 * で opacity の補間が止まることを固定する (#1322)。
 */
const read = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

beforeAll(() => {
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

function bar(active: boolean, reducedMotion: "never" | "always") {
  return (
    <MotionConfig reducedMotion={reducedMotion}>
      <ChakraProvider value={system}>
        <StreamProgressBar active={active} />
      </ChakraProvider>
    </MotionConfig>
  );
}

describe("StreamProgressBar (#1322)", () => {
  it("2px の領域を常に確保し、height を補間しない", async () => {
    const { container, rerender } = render(bar(false, "never"));
    const host = container.firstElementChild as HTMLElement;
    expect(host.style.height).toBe("2px");
    rerender(bar(true, "never"));
    const inner = host.firstElementChild as HTMLElement;
    expect(inner).toBeTruthy();
    expect(inner.style.height).toBe("");
    expect(host.style.height).toBe("2px");
  });

  it("reduced-motion では opacity の補間を止めて即時に表示する", async () => {
    const { container, rerender } = render(bar(false, "always"));
    rerender(bar(true, "always"));
    const inner = (container.firstElementChild as HTMLElement).firstElementChild as HTMLElement;
    await waitFor(() => expect(inner.style.opacity).toBe("1"));
  });
});

describe("TabBar の追加・削除 (#1322)", () => {
  const TABS: TabInfo[] = [{ id: "t1", kind: "query", title: "Query 1" }];
  const tabBar = (tabs: TabInfo[]) => (
    <TabBar tabs={tabs} activeTabId="t1" onSelect={() => {}} onClose={() => {}} onNew={() => {}} />
  );

  it("width を補間せず、reduced-motion でも opacity が即時に 1 になる", async () => {
    const { rerender } = renderWithProviders(
      <MotionConfig reducedMotion="always">{tabBar(TABS)}</MotionConfig>,
    );
    rerender(
      <MotionConfig reducedMotion="always">
        {tabBar([...TABS, { id: "t2", kind: "query", title: "Query 2" }])}
      </MotionConfig>,
    );
    const tab = screen.getByText("Query 2").closest<HTMLElement>(
      '[role="tab"]',
    ) as HTMLElement;
    await waitFor(() => expect(tab.style.opacity).toBe("1"));
    expect(tab.style.width).not.toBe("0px");
  });

  it("variants.fadeScaleX は opacity と scaleX だけを動かす", () => {
    for (const v of [variants.fadeScaleX.initial, variants.fadeScaleX.animate]) {
      expect(Object.keys(v).sort()).toEqual(["opacity", "scaleX"]);
    }
  });
});

describe("ソース上のガード (#1322)", () => {
  it("StreamProgressBar / TabBar は height・width を補間しない", () => {
    expect(read("components/StreamProgressBar.tsx").split("export function DeterminateProgressBar")[0]).not.toMatch(
      /height:\s*0/,
    );
    expect(read("components/TabBar.tsx")).not.toMatch(/width:\s*0/);
  });

  it("サイドバーの開閉で grid-template-columns を補間しない", () => {
    expect(read("App.tsx")).not.toMatch(/grid-template-columns var\(--dur/);
  });

  it("フラッシュ系 keyframes は opacity だけを動かす (box-shadow は 1 回きりの箱用のみ)", () => {
    const css = read("App.css");
    for (const name of ["apply-flash", "find-current-pulse"]) {
      const m = css.match(new RegExp(`@keyframes ${name} \\{[\\s\\S]*?\\n\\}`));
      expect(m, name).not.toBeNull();
      expect(m?.[0]).not.toContain("box-shadow");
      expect(m?.[0]).toContain("opacity");
    }
  });

  it("Modal のぼかしは入場完了後にだけ付ける", () => {
    const src = read("components/Modal.tsx");
    expect(src).toContain("onAnimationComplete");
    expect(src).toMatch(/&\[data-blurred\]/);
  });
});
