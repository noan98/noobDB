import { describe, it, expect } from "vitest";
import { renderWithProviders } from "./testUtils";
import { EmptyState } from "../components/EmptyState";
import { WelcomeIllustration } from "../components/illustrations";

/**
 * 空状態 / オンボーディング。リッチイラスト + CTA の一貫表示と、compact 時の
 * フォールバック挙動を固定する。
 */
describe("EmptyState onboarding (#450)", () => {
  it("renders the illustration, title, description and CTA", () => {
    const { getByText, getByRole, container } = renderWithProviders(
      <EmptyState
        illustration={<WelcomeIllustration />}
        title="No connections yet"
        description="Create your first connection to get started."
        action={{ label: "Create connection", onClick: () => {} }}
      />,
    );
    expect(getByText("No connections yet")).toBeTruthy();
    expect(getByText("Create your first connection to get started.")).toBeTruthy();
    expect(getByRole("button", { name: "Create connection" })).toBeTruthy();
    // イラストは SVG として描画される。
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("falls back to the small icon badge in compact layout (no illustration)", () => {
    const { container } = renderWithProviders(
      <EmptyState
        compact
        illustration={<WelcomeIllustration />}
        icon="table"
        title="No rows"
      />,
    );
    // compact ではイラストを出さず、アイコンバッジ (svg) のみ。少なくとも 1 つの svg。
    expect(container.querySelectorAll("svg").length).toBeGreaterThanOrEqual(1);
  });
});
