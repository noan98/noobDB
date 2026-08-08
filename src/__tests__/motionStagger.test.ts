import { describe, it, expect } from "vitest";
import { staggerContainer, staggerTiming, variants } from "../motion";

/**
 * stagger (協調した順次出現) プリセット (#875)。値そのものは motion.ts の
 * `staggerTiming` が単一ソースなので、ここでは「コンテナが timing トークンを
 * 参照していること」と「reduced-motion で stagger が無効化される (同時表示に
 * フォールバックする) こと」の 2 点だけを固定する。
 */
describe("staggerContainer (#875)", () => {
  it("references the staggerTiming tokens when motion is allowed", () => {
    const container = staggerContainer(false);
    const animate = container.animate as { transition: Record<string, number> };
    expect(animate.transition.staggerChildren).toBe(staggerTiming.each);
    expect(animate.transition.delayChildren).toBe(staggerTiming.delay);
  });

  it("collapses to simultaneous appearance under reduced motion", () => {
    const container = staggerContainer(true);
    const animate = container.animate as { transition: Record<string, number> };
    expect(animate.transition.staggerChildren).toBe(0);
    expect(animate.transition.delayChildren).toBe(0);
  });

  it("provides a matching child item preset that fades in", () => {
    const item = variants.staggerItem;
    expect(item.initial).toMatchObject({ opacity: 0 });
    expect(item.animate).toMatchObject({ opacity: 1, y: 0 });
  });
});
