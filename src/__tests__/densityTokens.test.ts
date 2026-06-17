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
