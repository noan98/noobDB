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

  it("animate=false の間はフラグを消費せず、true になった時点で再生する", () => {
    const { container, rerender } = renderWithProviders(
      <HeroHeader title="a" subtitle="b" animate={false} />,
    );
    expect(container.querySelector(".brand-mark-anim")).toBeNull();
    rerender(<HeroHeader title="a" subtitle="b" animate />);
    expect(container.querySelector(".brand-mark-anim")).toBeTruthy();
  });

  it("Welcome → Profile の遷移後 (別インスタンス) は静止する", () => {
    const welcome = renderWithProviders(<HeroHeader title="a" subtitle="b" animate />);
    expect(welcome.container.querySelector(".brand-mark-anim")).toBeTruthy();
    welcome.unmount();
    const profile = renderWithProviders(<HeroHeader title="c" subtitle="d" animate />);
    expect(profile.container.querySelector(".brand-mark-anim")).toBeNull();
  });
});
