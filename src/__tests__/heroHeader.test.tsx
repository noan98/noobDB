import { beforeEach, describe, expect, it } from "vitest";
import { HeroHeader, resetHeroAnimationForTest } from "../components/HeroHeader";
import { renderWithProviders } from "./testUtils";

describe("HeroHeader (#1955)", () => {
  it("BrandMark・見出し・サブタイトル・罫線を束ねて描画する", () => {
    const { container, getByText } = renderWithProviders(<HeroHeader title="タイトル" subtitle="サブ" />);
    expect(getByText("タイトル")).toBeTruthy();
    expect(getByText("サブ")).toBeTruthy();
    expect(container.querySelector("svg")).toBeTruthy();
  });
});

describe("HeroHeader animate (#2042)", () => {
  beforeEach(() => resetHeroAnimationForTest());

  it("animate 指定の初回だけマークを再生し、2 回目以降は静止する", () => {
    const first = renderWithProviders(<HeroHeader title="a" subtitle="b" animate />);
    expect(first.container.querySelector(".brand-mark-anim")).toBeTruthy();
    first.unmount();
    const second = renderWithProviders(<HeroHeader title="a" subtitle="b" animate />);
    expect(second.container.querySelector(".brand-mark-anim")).toBeNull();
  });

  it("animate 未指定なら再生しない", () => {
    const { container } = renderWithProviders(<HeroHeader title="a" subtitle="b" />);
    expect(container.querySelector(".brand-mark-anim")).toBeNull();
  });
});
