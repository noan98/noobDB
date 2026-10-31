import { describe, it, expect } from "vitest";
import { renderWithProviders } from "./testUtils";
import { FeatureIcon } from "../components/FeatureIcon";
import { EmptyState } from "../components/EmptyState";

/** フィーチャーアイコンタイル (#1954): 3 面共通の寸法・色味 variant を固定する。 */
describe("FeatureIcon (#1954)", () => {
  it("既定は md + accent で、装飾として aria-hidden", () => {
    const { container } = renderWithProviders(<FeatureIcon icon="database" />);
    const tile = container.querySelector("[data-feature-icon]");
    expect(tile?.getAttribute("data-feature-icon")).toBe("md");
    expect(tile?.getAttribute("data-tone")).toBe("accent");
    expect(tile?.getAttribute("aria-hidden")).toBe("true");
    expect(tile?.querySelector("svg")).toBeTruthy();
  });

  it("size / tone を切り替えられる", () => {
    const { container } = renderWithProviders(<FeatureIcon icon="database" size="lg" tone="muted" />);
    const tile = container.querySelector("[data-feature-icon]");
    expect(tile?.getAttribute("data-feature-icon")).toBe("lg");
    expect(tile?.getAttribute("data-tone")).toBe("muted");
  });

  it("EmptyState は icon をアクセント調のタイルで描画し、compact では sm になる", () => {
    const full = renderWithProviders(<EmptyState icon="database" title="t" />);
    expect(full.container.querySelector("[data-feature-icon='lg'][data-tone='accent']")).toBeTruthy();
    full.unmount();
    const compact = renderWithProviders(<EmptyState icon="database" title="t" compact />);
    expect(compact.container.querySelector("[data-feature-icon='sm']")).toBeTruthy();
  });
});
