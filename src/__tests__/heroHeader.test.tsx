import { describe, expect, it } from "vitest";
import { HeroHeader } from "../components/HeroHeader";
import { renderWithProviders } from "./testUtils";

describe("HeroHeader (#1955)", () => {
  it("BrandMark・見出し・サブタイトル・罫線を束ねて描画する", () => {
    const { container, getByText } = renderWithProviders(<HeroHeader title="タイトル" subtitle="サブ" />);
    expect(getByText("タイトル")).toBeTruthy();
    expect(getByText("サブ")).toBeTruthy();
    expect(container.querySelector("svg")).toBeTruthy();
  });
});
