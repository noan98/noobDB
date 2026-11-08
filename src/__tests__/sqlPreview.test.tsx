import { describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "./testUtils";
import { SqlPreview } from "../components/SqlPreview";
import {
  SQL_HIGHLIGHT_MAX_CHARS,
  SQL_HIGHLIGHT_MAX_LINES,
  SQL_TOKEN_STYLE,
  shouldHighlightSql,
} from "../components/sqlHighlight";

// SQL プレビューの色分け (#2157)。エディタと同じ `--syntax-*` 変数で着色し、大きな SQL は単色にする。

describe("shouldHighlightSql (閾値)", () => {
  it("上限ちょうどは色分けし、超えたら単色", () => {
    expect(shouldHighlightSql("SELECT 1")).toBe(true);
    expect(shouldHighlightSql(Array(SQL_HIGHLIGHT_MAX_LINES).fill("a").join("\n"))).toBe(true);
    expect(
      shouldHighlightSql(
        Array(SQL_HIGHLIGHT_MAX_LINES + 1)
          .fill("a")
          .join("\n"),
      ),
    ).toBe(false);
    expect(shouldHighlightSql("a".repeat(SQL_HIGHLIGHT_MAX_CHARS))).toBe(true);
    expect(shouldHighlightSql("a".repeat(SQL_HIGHLIGHT_MAX_CHARS + 1))).toBe(false);
  });
});

describe("SqlPreview", () => {
  it("キーワード・文字列・数値をエディタと同じ配色の CSS 変数で着色し、全文は保つ", () => {
    renderWithProviders(<SqlPreview sql={"SELECT 'x', 42\nFROM t"} driver="mysql" data-testid="p" />);
    const pre = screen.getByTestId("p");
    expect(pre).toHaveAttribute("data-sql-highlight", "on");
    expect(pre.textContent).toBe("SELECT 'x', 42\nFROM t");
    const colored = [...pre.querySelectorAll("span")].map((e) => [e.textContent, e.style.color]);
    expect(colored).toContainEqual(["SELECT", SQL_TOKEN_STYLE.keyword.color]);
    expect(colored).toContainEqual(["'x'", SQL_TOKEN_STYLE.string.color]);
    expect(colored).toContainEqual(["42", SQL_TOKEN_STYLE.number.color]);
    // 色リテラルは使わず、テーマ追従の変数だけ。
    for (const [, color] of colored) expect(color).toMatch(/^var\(--syntax-/);
  });

  it("空のときは empty の文言を単色で出す", () => {
    renderWithProviders(<SqlPreview sql="" driver="postgres" empty="(empty)" data-testid="p" />);
    const pre = screen.getByTestId("p");
    expect(pre).toHaveAttribute("data-sql-highlight", "off");
    expect(pre).toHaveTextContent("(empty)");
    expect(pre.querySelector("span")).toBeNull();
  });

  it("閾値を超える SQL は単色にフォールバックする", () => {
    const big = Array(SQL_HIGHLIGHT_MAX_LINES + 1)
      .fill("SELECT 1;")
      .join("\n");
    renderWithProviders(<SqlPreview sql={big} driver="mysql" data-testid="p" />);
    const pre = screen.getByTestId("p");
    expect(pre).toHaveAttribute("data-sql-highlight", "off");
    expect(pre.querySelector("span")).toBeNull();
    expect(pre.textContent).toBe(big);
  });
});
