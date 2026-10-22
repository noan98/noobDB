import { useState } from "react";
import { describe, expect, it } from "vitest";
import { MotionConfig } from "motion/react";
import { renderInBrowser } from "./render";
import { TabBar, type TabInfo } from "../../components/TabBar";

// タブを閉じたときの右側タブの詰め直しグライド (#1765) を実ブラウザで検証する。
// 退場完了で DOM から外れた直後、右側のタブに `translate` の WAAPI が 1 回だけ走る。

const TABS: TabInfo[] = [1, 2, 3, 4].map((n) => ({ id: `t${n}`, kind: "query", title: `Query ${n}` }));

function Harness({ reduced = false }: { reduced?: boolean }) {
  const [tabs, setTabs] = useState<TabInfo[]>(TABS);
  return (
    <MotionConfig reducedMotion={reduced ? "always" : "never"}>
      <button
        type="button"
        data-testid="close"
        onClick={() => setTabs((p) => p.filter((x) => x.id !== "t2"))}
      >
        close
      </button>
      <TabBar tabs={tabs} activeTabId="t1" onSelect={() => {}} onClose={() => {}} onNew={() => {}} />
    </MotionConfig>
  );
}

const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

/** 閉じた直後から約 1 秒、`translate` を動かす Animation が付いた要素の数を毎フレーム数える。 */
async function countGlides(): Promise<number> {
  (document.querySelector('[data-testid="close"]') as HTMLElement).click();
  let max = 0;
  const end = performance.now() + 1000;
  while (performance.now() < end) {
    await frame();
    const n = document
      .getAnimations()
      .filter((a) =>
        (a.effect as KeyframeEffect | null)?.getKeyframes().some((k) => "translate" in k),
      ).length;
    max = Math.max(max, n);
  }
  return max;
}

describe("タブを閉じたときのグライド (#1765)", () => {
  it("閉じたタブより右の 2 枚が滑り、左のタブは動かない", async () => {
    await renderInBrowser(<Harness />);
    await frame();
    expect(await countGlides()).toBe(2);
  });

  it("reduced-motion では滑らせない", async () => {
    await renderInBrowser(<Harness reduced />);
    await frame();
    expect(await countGlides()).toBe(0);
  });
});
