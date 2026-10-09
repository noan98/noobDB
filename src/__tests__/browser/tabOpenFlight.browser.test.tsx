import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { MotionConfig } from "motion/react";
import { renderInBrowser } from "./render";
import { TabBar, type TabInfo } from "../../components/TabBar";
import { FlightIcon } from "../../components/FlightIcon";
import { Icon } from "../../components/Icon";
import {
  beginTabOpenFlight,
  resetTabOpenFlightForTest,
  useTabOpenFlightFor,
} from "../../sharedElement";

// サイドバー行 → 新規タブのアイコン morph (#1415) を実ブラウザで検証する。
// 起点 (行のアイコン) は終点 (タブ) が現れても DOM に残るので、飛行中だけ
// layoutId を持つ構成で「実際に起点付近から動き出す」ことを確かめる。

const NEW_TAB: TabInfo = { id: "t2", kind: "table", title: "users", database: "appdb", table: "users" };

function Harness() {
  const [tabs, setTabs] = useState<TabInfo[]>([{ id: "t1", kind: "query", title: "Query 1" }]);
  const flight = useTabOpenFlightFor("appdb", "users");
  return (
    <div>
      <div data-testid="origin" style={{ position: "absolute", left: 40, top: 400 }}>
        <FlightIcon flightId={flight}>
          <Icon name="table" />
        </FlightIcon>
      </div>
      <button type="button" data-testid="open" onClick={() => setTabs((p) => [...p, NEW_TAB])}>
        open
      </button>
      <TabBar tabs={tabs} activeTabId="t1" onSelect={() => {}} onClose={() => {}} onNew={() => {}} />
    </div>
  );
}

function tabIcon(): HTMLElement | null {
  return document.querySelector('[role="tab"][aria-selected="false"] svg');
}

async function frame() {
  await new Promise((r) => requestAnimationFrame(() => r(null)));
}

/** タブ生成の直後から約 0.5 秒、毎フレームのアイコン top を記録する。 */
let originOpacities: number[] = [];

async function openTab(): Promise<number[]> {
  originOpacities = [];
  beginTabOpenFlight("appdb", "users");
  await frame();
  (document.querySelector('[data-testid="open"]') as HTMLElement).click();
  const tops: number[] = [];
  const end = performance.now() + 500;
  while (performance.now() < end) {
    await frame();
    const el = tabIcon();
    if (el) tops.push(el.getBoundingClientRect().top);
    const o = document.querySelector('[data-testid="origin"] svg')?.parentElement;
    if (o) originOpacities.push(Number(getComputedStyle(o).opacity));
  }
  return tops;
}

describe("新規タブ生成の shared-element morph (#1415, 実ブラウザ)", () => {
  afterEach(() => resetTabOpenFlightForTest());

  it("通常: 終点アイコンは起点 (下方) から動き出し、最終位置へ収まる", async () => {
    await renderInBrowser(
      <MotionConfig reducedMotion="never">
        <Harness />
      </MotionConfig>,
    );
    const tops = await openTab();
    const final = tops[tops.length - 1];
    // 起点は y=400 付近、タブバーは上端。morph 中は最終位置より明らかに下のフレームがある。
    expect(Math.max(...tops)).toBeGreaterThan(final + 50);
    expect(Math.abs(tops[tops.length - 1] - tops[tops.length - 2])).toBeLessThan(1);
  });

  it("reduced-motion (always): morph せず最初のフレームから最終位置にいる", async () => {
    await renderInBrowser(
      <MotionConfig reducedMotion="always">
        <Harness />
      </MotionConfig>,
    );
    const tops = await openTab();
    const final = tops[tops.length - 1];
    expect(Math.max(...tops) - final).toBeLessThan(2);
    // 共有 layoutId のクロスフェードも走らせない: 飛行中も起点は消えない。
    expect(Math.min(...originOpacities)).toBe(1);
  });

  it("飛行が終わったあと、起点アイコンは不透明に戻る", async () => {
    await renderInBrowser(
      <MotionConfig reducedMotion="never">
        <Harness />
      </MotionConfig>,
    );
    await openTab();
    resetTabOpenFlightForTest();
    await new Promise((r) => setTimeout(r, 400));
    const icon = document.querySelector('[data-testid="origin"] svg') as Element;
    expect(getComputedStyle(icon.parentElement as Element).opacity).toBe("1");
  });
});
