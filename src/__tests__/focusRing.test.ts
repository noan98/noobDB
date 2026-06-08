import { describe, it, expect } from "vitest";
import css from "../App.css?raw";
import themeSrc from "../theme.ts?raw";

/**
 * フォーカス/選択の視覚言語統一 (#475) の回帰テスト。フォーカスリングがトークン化
 * され、フォーム要素が :focus-visible に統一され、エラー入力が危険色リングへ分岐
 * することを固定する。
 */
describe("focus ring tokens (#475)", () => {
  const root = css.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";

  it("defines the focus ring tokens (width/color/composed/danger)", () => {
    for (const name of ["focus-ring-width", "focus-ring-color", "focus-ring", "focus-ring-danger"]) {
      expect(new RegExp(`--${name}:`).test(root), `--${name} must be defined`).toBe(true);
    }
  });

  it("buttons and form fields use :focus-visible with the shared ring token", () => {
    expect(/button:focus-visible \{[\s\S]*?box-shadow: var\(--focus-ring\)/.test(css)).toBe(true);
    expect(/input:focus-visible, select:focus-visible \{[\s\S]*?box-shadow: var\(--focus-ring\)/.test(css)).toBe(
      true,
    );
  });

  it("does not focus-ring form fields on bare :focus (mouse clicks stay quiet)", () => {
    // 旧 `input:focus, select:focus { ... }` ルールが残っていないこと。
    expect(/\binput:focus,\s*select:focus\s*\{/.test(css)).toBe(false);
  });

  it("error inputs switch to the danger ring", () => {
    expect(/input\[aria-invalid="true"\]:focus-visible/.test(css)).toBe(true);
    expect(/box-shadow: var\(--focus-ring-danger\)/.test(css)).toBe(true);
  });
});

describe("Chakra recipes adopt focus-visible (#475)", () => {
  it("input/select/textarea recipes use _focusVisible and the danger ring", () => {
    expect(themeSrc).toMatch(/const focusRing = "var\(--focus-ring\)"/);
    expect(themeSrc).toMatch(/focusRingDanger = "var\(--focus-ring-danger\)"/);
    expect(themeSrc).toMatch(/aria-invalid='true'/);
    // バリデーション失敗時に bare _focus へ戻していないこと。
    expect(themeSrc).not.toMatch(/_focus: \{ outline: "none", borderColor: "app.accent"/);
  });
});
