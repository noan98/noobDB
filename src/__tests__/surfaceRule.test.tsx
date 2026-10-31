import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "../theme";
import { SurfaceRule } from "../components/SurfaceRule";
import perfPanelSrc from "../components/PerfPanel.tsx?raw";
import schemaCompareSrc from "../components/SchemaCompareView.tsx?raw";
import usersPanelSrc from "../components/UsersPanel.tsx?raw";
import erDiagramSrc from "../components/ERDiagramView.tsx?raw";
import pinnedSrc from "../components/PinnedComparisonView.tsx?raw";
import serverInfoSrc from "../components/ServerInfoPanel.tsx?raw";
import tableStatsSrc from "../components/TableStatisticsPanel.tsx?raw";
import sqliteMaintSrc from "../components/SqliteMaintenancePanel.tsx?raw";
import surfaceRuleSrc from "../components/SurfaceRule.tsx?raw";

/** #1938: サーフェス見出しのブランド罫線は --hero-rule(-display) だけを参照する (色リテラルを持たない)。 */
describe("SurfaceRule (#1938)", () => {
  it("--hero-rule / --hero-rule-display を参照する装飾要素を描画する", () => {
    const { getByTestId } = render(
      <ChakraProvider value={system}>
        <SurfaceRule />
      </ChakraProvider>,
    );
    const el = getByTestId("surface-brand-rule");
    expect(el.getAttribute("aria-hidden")).toBe("true");
    expect(surfaceRuleSrc).toContain('background: "var(--hero-rule)"');
    expect(surfaceRuleSrc).toContain('display: "var(--hero-rule-display)"');
    expect(surfaceRuleSrc.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("最上位見出しを持つ全画面サーフェス/主要パネルが SurfaceRule を使う", () => {
    for (const src of [
      perfPanelSrc,
      schemaCompareSrc,
      usersPanelSrc,
      erDiagramSrc,
      pinnedSrc,
      serverInfoSrc,
      tableStatsSrc,
      sqliteMaintSrc,
    ]) {
      expect(src).toContain("<SurfaceRule />");
    }
  });
});
