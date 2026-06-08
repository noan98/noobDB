import { describe, it, expect } from "vitest";
import css from "../App.css?raw";

/**
 * タイポグラフィスケールと縦リズムのトークン回帰テスト (#490)。
 *
 * - タイプスケール (--text-*) が --font-scale を内包し、フォントサイズ設定で
 *   スケール全体が相対追従することを固定する。
 * - 行間 (--leading-*) と字間 (--tracking-*) のロールトークンが定義され、
 *   エディタが共有トークンを参照することを固定する。
 */

const root = css.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";

describe("typography scale tracks the font scale (#490)", () => {
  it("every --text-* size is calc(... * var(--font-scale))", () => {
    for (const name of ["2xs", "xs", "sm", "md", "base", "lg", "xl"]) {
      const re = new RegExp(`--text-${name}:\\s*calc\\([^;]*var\\(--font-scale\\)[^;]*\\);`);
      expect(re.test(root), `--text-${name} must scale with --font-scale`).toBe(true);
    }
  });
});

describe("vertical rhythm tokens (#490)", () => {
  it("defines line-height role tokens in ascending order", () => {
    const leadings = ["tight", "snug", "normal", "relaxed"].map((n) => {
      const m = root.match(new RegExp(`--leading-${n}:\\s*([0-9.]+);`));
      expect(m, `--leading-${n} must be defined`).toBeTruthy();
      return Number(m![1]);
    });
    for (let i = 1; i < leadings.length; i++) {
      expect(leadings[i]).toBeGreaterThanOrEqual(leadings[i - 1]);
    }
  });

  it("defines letter-spacing role tokens", () => {
    for (const n of ["tight", "normal", "wide"]) {
      expect(new RegExp(`--tracking-${n}:`).test(root)).toBe(true);
    }
  });

  it("the editor consumes the shared relaxed line-height token", () => {
    expect(/\.cm-editor \.cm-scroller \{[\s\S]*?line-height: var\(--leading-relaxed\)/.test(css)).toBe(
      true,
    );
  });
});
