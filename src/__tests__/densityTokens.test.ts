import { describe, it, expect } from "vitest";
import css from "../App.css?raw";

/**
 * 表示密度プリセットの CSS トークンのガード。`:root` の既定値と
 * `data-density` 上書きブロックが揃っていること、normal (既定) が従来のグリッド
 * 余白 (5px/10px) と一致する no-op であることを固定する。
 */

function block(selectorRegex: RegExp): string {
  const m = css.match(selectorRegex);
  if (!m) throw new Error(`block not found: ${selectorRegex}`);
  return m[1];
}

const root = block(/:root\s*\{([\s\S]*?)\n\}/);
const compact = block(/:root\[data-density="compact"\]\s*\{([\s\S]*?)\n\}/);
const spacious = block(/:root\[data-density="spacious"\]\s*\{([\s\S]*?)\n\}/);

describe("density tokens", () => {
  it("defines the density vars at :root (normal default)", () => {
    expect(root).toMatch(/--density-cell-py:\s*calc\(5px \* var\(--font-scale\)\);/);
    expect(root).toMatch(/--density-cell-px:\s*calc\(10px \* var\(--font-scale\)\);/);
    expect(root).toMatch(/--density-row-h:\s*30px;/);
  });

  it("overrides the cell padding for compact and spacious", () => {
    expect(compact).toMatch(/--density-cell-py:\s*calc\(2px \* var\(--font-scale\)\);/);
    expect(spacious).toMatch(/--density-cell-py:\s*calc\(9px \* var\(--font-scale\)\);/);
  });

  it("keeps the density vars tracking the font scale on every preset", () => {
    for (const b of [root, compact, spacious]) {
      expect(b).toMatch(/--density-cell-py:\s*calc\([^;]*var\(--font-scale\)[^;]*\);/);
      expect(b).toMatch(/--density-cell-px:\s*calc\([^;]*var\(--font-scale\)[^;]*\);/);
    }
  });

  // #620: density も grid だけでなくコントロール (ボタン/入力欄) の縦余白に効く。
  it("defines the control-padding density axis as a no-op at normal", () => {
    // normal (= :root) のスケールは 1 で、従来のコントロール余白と一致する no-op。
    expect(root).toMatch(/--density-control-scale:\s*1;/);
    expect(root).toMatch(
      /--control-py:\s*calc\(6px \* var\(--font-scale\) \* var\(--density-control-scale\)\);/,
    );
    expect(root).toMatch(/--control-px:\s*calc\(12px \* var\(--font-scale\)\);/);
    expect(root).toMatch(/--field-px:\s*calc\(8px \* var\(--font-scale\)\);/);
  });

  it("shifts the control-padding scale for compact and spacious", () => {
    expect(compact).toMatch(/--density-control-scale:\s*0\.6;/);
    expect(spacious).toMatch(/--density-control-scale:\s*1\.35;/);
  });

  it("makes control vertical padding follow the density axis (not horizontal)", () => {
    // 縦余白は密度軸に追従し、横余白は font-scale のみ (密度で詰めない)。
    expect(root).toMatch(
      /--control-sm-py:\s*calc\([^;]*var\(--density-control-scale\)[^;]*\);/,
    );
    expect(root).toMatch(
      /--field-py:\s*calc\([^;]*var\(--density-control-scale\)[^;]*\);/,
    );
    expect(root).not.toMatch(
      /--control-px:\s*calc\([^;]*var\(--density-control-scale\)[^;]*\);/,
    );
    expect(root).not.toMatch(
      /--field-px:\s*calc\([^;]*var\(--density-control-scale\)[^;]*\);/,
    );
  });
});

// #1023: 密度変更の遷移演出。CSS 側は「値の変化そのものを補間する transition」
// ではなく「変化の瞬間だけ立つ属性に紐づく一度きりの keyframes」であることを
// 固定する — 常時 transition だと数万行のグリッドで再描画コストが乗るため
// (densityTransition.ts のモジュール doc / App.css の該当コメント参照)。
describe("density transition CSS (#1023)", () => {
  it("defines both directions of the settle keyframes", () => {
    expect(css).toMatch(/@keyframes density-settle-grow\s*\{/);
    expect(css).toMatch(/@keyframes density-settle-shrink\s*\{/);
  });

  it("scopes the control animation to the transient attribute, not a bare transition", () => {
    expect(css).toMatch(
      /:root\[data-density-transition="grow"\][^{]*\{[^}]*animation:\s*density-settle-grow/,
    );
    expect(css).toMatch(
      /:root\[data-density-transition="shrink"\][^{]*\{[^}]*animation:\s*density-settle-shrink/,
    );
  });

  it("does not add an always-on transition on the density-consuming properties", () => {
    // padding/height 自体には transition を掛けない (仮想スクロール位置との
    // 競合を避けるための設計判断)。
    expect(root).not.toMatch(/transition:[^;]*padding/);
  });
});
