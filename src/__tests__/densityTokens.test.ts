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
});
