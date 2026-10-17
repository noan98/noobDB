import { render } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import { describe, expect, it } from "vitest";
import { CircularReveal } from "../components/CircularReveal";

const origin = { x: 100, y: 50 };
const noop = () => {};

function mount(reduced: "never" | "always", props: Partial<Parameters<typeof CircularReveal>[0]> = {}) {
  render(
    <MotionConfig reducedMotion={reduced}>
      <CircularReveal origin={origin} variant="disc" color="red" opacity={0.3} onDone={noop} {...props} />
    </MotionConfig>,
  );
  return document.body.querySelector<HTMLElement>("[data-reveal]");
}

describe("CircularReveal (#1582)", () => {
  it("disc は円形のクリップで描く", () => {
    const el = mount("never");
    expect(el?.dataset.reveal).toBe("disc");
    expect(el?.getAttribute("aria-hidden")).toBe("true");
  });

  it("hole は旧テーマ色で覆い、穴を開ける", () => {
    const el = mount("never", { variant: "hole", color: "black" });
    expect(el?.dataset.reveal).toBe("hole");
  });

  it("reduced-motion では円にせず平坦なクロスフェード (従来の色・不透明度)", () => {
    const el = mount("always", { variant: "hole", color: "black", flatColor: "white", flatOpacity: 0.5 });
    expect(el?.dataset.reveal).toBe("flat");
    expect(el?.style.opacity).toBe("0.5");
  });

  it("plain (高コントラスト) でも平坦", () => {
    const el = mount("never", { plain: true });
    expect(el?.dataset.reveal).toBe("flat");
    expect(el?.style.opacity).toBe("0.3");
  });
});
