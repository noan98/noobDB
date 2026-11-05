import { afterEach, describe, expect, it } from "vitest";
import { cleanup, renderWithProviders, screen } from "./testUtils";
import { AiSurface } from "../components/AiSurface";
import errorExplain from "../components/AiErrorExplain.tsx?raw";
import explainInterpret from "../components/AiExplainInterpret.tsx?raw";
import historySearch from "../components/AiHistorySearch.tsx?raw";
import syncRisk from "../components/AiSyncRisk.tsx?raw";
import resultSummary from "../components/AiResultSummaryPanel.tsx?raw";
import sqlPanel from "../components/AiSqlPanel.tsx?raw";
import impact from "../components/AiImpactAnalysis.tsx?raw";
import lockDiagnose from "../components/AiLockDiagnose.tsx?raw";
import advisorExplain from "../components/AiAdvisorExplain.tsx?raw";

afterEach(cleanup);

/** 要素に効く emotion のルールを、出力順のまま宣言列として連結する。 */
function cssFor(el: Element): string {
  const classes = Array.from(el.classList);
  const out: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      if (classes.some((c) => rule.cssText.includes(`.${c}`))) out.push(rule.cssText);
    }
  }
  return out.join("\n");
}

describe("AiSurface (#2016)", () => {
  it.each(["none", "top", "bottom", "box"] as const)(
    "edge=%s でも左辺は 3px の app.aiAccent (shorthand に上書きされない)",
    (edge) => {
      renderWithProviders(
        <AiSurface edge={edge} data-testid="s">
          x
        </AiSurface>,
      );
      const css = cssFor(screen.getByTestId("s"));
      const last = (re: RegExp) => {
        const all = [...css.matchAll(new RegExp(re.source, "g"))];
        return all.length ? (all[all.length - 1].index ?? -1) : -1;
      };
      expect(css).toMatch(/border-inline-start-width:\s*3px/);
      expect(css).toMatch(/border-inline-start-color:\s*var\(--chakra-colors-app-ai-accent\)/);
      // box の shorthand は左辺指定より前に出力される (後勝ちで消さない)。
      const shorthand = last(/[;{\s]border-width:/);
      if (shorthand >= 0) {
        expect(shorthand).toBeLessThan(last(/border-inline-start-width:/));
      }
      const shorthandColor = last(/[;{\s]border-color:/);
      if (shorthandColor >= 0) {
        expect(shorthandColor).toBeLessThan(last(/border-inline-start-color:/));
      }
    },
  );

  it("data-ai-surface を付ける", () => {
    renderWithProviders(<AiSurface data-testid="s">x</AiSurface>);
    expect(screen.getByTestId("s").hasAttribute("data-ai-surface")).toBe(true);
  });

  it.each([
    ["AiErrorExplain", errorExplain, "ai-error-explain"],
    ["AiExplainInterpret", explainInterpret, "ai-explain-interpret"],
    ["AiHistorySearch", historySearch, "ai-history-search"],
    ["AiSyncRisk", syncRisk, "ai-sync-risk"],
    ["AiResultSummaryPanel", resultSummary, "ai-result-summary-panel"],
    ["AiSqlPanel", sqlPanel, "ai-sql-panel"],
    ["AiImpactAnalysis", impact, "ai-impact-analysis"],
    ["AiLockDiagnose", lockDiagnose, "ai-lock-diagnose"],
    ["AiAdvisorExplain", advisorExplain, "ai-advisor-explain"],
  ])("%s のルートは AiSurface (data-testid=%s)", (_n, src, testid) => {
    expect(src).toMatch(new RegExp(`<AiSurface[^>]*data-testid="${testid}"`));
  });
});
