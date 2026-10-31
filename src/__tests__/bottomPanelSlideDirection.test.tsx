import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "./testUtils";
import { BottomPanel } from "../components/BottomPanel";
import type { BottomPanelTab } from "../components/bottomPanelTabs";

/**
 * ボトムパネルのタブ切替で、中身の入場方向がインジケータの滑る向きと揃うこと (#1952)。
 * `KeepAlive` に渡る `slideDirection` を直接観測する (jsdom では見た目の x 移動を測れない)。
 */

const seen = vi.hoisted(() => ({ dirs: [] as Array<number | undefined> }));

vi.mock("../components/KeepAlive", () => ({
  KeepAlive: ({ slideDirection, children }: { slideDirection?: number; children: ReactNode }) => {
    seen.dirs.push(slideDirection);
    return <div>{children}</div>;
  },
}));

const TABS: BottomPanelTab[] = ["advisor", "inspector", "processes", "health"];

function panel(tab: BottomPanelTab) {
  return (
    <BottomPanel tab={tab} tabs={TABS} label={(k) => k} onSelect={() => {}} onClose={() => {}}>
      <div>body</div>
    </BottomPanel>
  );
}

describe("BottomPanel スライド方向 (#1952)", () => {
  it("右のタブへ +1、左へ -1、初回は 0 で KeepAlive に渡す", () => {
    seen.dirs.length = 0;
    const view = renderWithProviders(panel("inspector"));
    expect(seen.dirs.at(-1)).toBe(0);
    view.rerender(panel("health"));
    expect(seen.dirs.at(-1)).toBe(1);
    view.rerender(panel("advisor"));
    expect(seen.dirs.at(-1)).toBe(-1);
  });
});
