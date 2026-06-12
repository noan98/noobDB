import { describe, it, expect } from "vitest";
import css from "../App.css?raw";
import themeSrc from "../theme.ts?raw";
import gridSrc from "../components/ResultGrid.tsx?raw";

/**
 * フォーカス/選択の視覚言語統一の回帰テスト。フォーカスリングがトークン化
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

/**
 * グリッドセル / 範囲選択の inset リング。
 * 矩形選択範囲では隣接セルのリングが外側で重なると輪郭が読みづらいため、
 * すべてのセルフォーカス/選択を inset box-shadow に統一する。
 */
describe("grid cell focus ring uses inset token (#540)", () => {
  const root = css.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";

  it("defines the --focus-ring-inset token in :root", () => {
    expect(/--focus-ring-inset:/.test(root), "--focus-ring-inset must be defined").toBe(true);
  });

  it("--focus-ring-inset uses inset box-shadow syntax", () => {
    // トークン値が `inset` キーワードで始まっていること。
    expect(/--focus-ring-inset:\s*inset/.test(root)).toBe(true);
  });

  it("active cell (is-active-cell) uses --focus-ring-inset instead of outline", () => {
    // is-active-cell のスタイルで --focus-ring-inset を参照していること。
    expect(gridSrc).toMatch(/is-active-cell[\s\S]{0,200}focus-ring-inset/);
  });

  it("editable cell :focus-within uses --focus-ring-inset instead of outline", () => {
    // 編集中セルのスタイルで --focus-ring-inset を参照していること。
    expect(gridSrc).toMatch(/is-editable-cell:focus-within[\s\S]{0,200}focus-ring-inset/);
  });

  it("is-active-cell does not use outline (inset ring replaces it)", () => {
    // アクティブセルのフォーカス表示に旧来の `outlineOffset: "-2px"` が残っていないこと。
    // (outline: none は残るが outlineOffset は不要)。
    expect(/is-active-cell[^}]+outlineOffset:\s*"-2px"/.test(gridSrc)).toBe(false);
  });

  it("range-selected cells (is-selected-cell) use inset box-shadow", () => {
    // 範囲選択セル (アクティブではない) にも inset リングが付くこと。
    expect(gridSrc).toMatch(/is-selected-cell[^"]*:not\(.is-active-cell\)[\s\S]{0,300}inset/);
  });
});
