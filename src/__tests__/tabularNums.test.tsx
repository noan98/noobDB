import { describe, expect, it } from "vitest";
import { chakra } from "@chakra-ui/react";
import { renderWithProviders } from "./testUtils";
import { CountUp } from "../components/CountUp";

/**
 * 等幅数字トークン `textStyle="numeric"` (#1072) のテスト。
 *
 * カウントアップやライブ更新する数値は比例数字だと桁形が変わるたびに横幅が揺れる。
 * 等幅数字は theme.ts の `textStyles.numeric` を単一ソースとし (直書きは
 * designTokens.test.ts が禁止)、ここではそのトークンが実際に
 * `font-variant-numeric: tabular-nums` として出力されることを固定する。
 */

/** 注入済みスタイルシートの全ルールを 1 本の文字列にする。 */
function allCssText(): string {
  return Array.from(document.styleSheets)
    .flatMap((sheet) => {
      try {
        return Array.from(sheet.cssRules).map((r) => r.cssText);
      } catch {
        return [];
      }
    })
    .join("\n")
    .concat(
      Array.from(document.querySelectorAll("style"))
        .map((s) => s.textContent ?? "")
        .join("\n"),
    );
}

/** 要素に付いたクラスのどれかが tabular-nums を宣言しているか。 */
function hasTabularNums(el: Element): boolean {
  if (getComputedStyle(el).fontVariantNumeric === "tabular-nums") return true;
  const css = allCssText();
  return Array.from(el.classList).some((cls) => {
    const escaped = cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\.${escaped}[^{]*\\{[^}]*font-variant-numeric:\\s*tabular-nums`);
    return re.test(css);
  });
}

describe("textStyle numeric (#1072)", () => {
  it("CountUp の見える桁は等幅数字で描画される", () => {
    const { container } = renderWithProviders(<CountUp value={1234} />);
    const visible = container.querySelector('[aria-hidden="true"]');
    expect(visible).toBeTruthy();
    expect(visible?.textContent).toBe((1234).toLocaleString());
    expect(hasTabularNums(visible as Element)).toBe(true);
  });

  it("style prop の textStyle=\"numeric\" が tabular-nums を出力する", () => {
    const { container } = renderWithProviders(
      <chakra.span data-testid="n" textStyle="numeric">
        42
      </chakra.span>,
    );
    const el = container.querySelector('[data-testid="n"]') as Element;
    expect(hasTabularNums(el)).toBe(true);
  });

  it("css オブジェクト内の textStyle: \"numeric\" (tdCss などの形) も tabular-nums を出力する", () => {
    const { container } = renderWithProviders(
      <chakra.span data-testid="n" css={{ textStyle: "numeric", fontWeight: 600 }}>
        42
      </chakra.span>,
    );
    const el = container.querySelector('[data-testid="n"]') as Element;
    expect(hasTabularNums(el)).toBe(true);
  });
});
