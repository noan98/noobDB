import { describe, it, expect } from "vitest";
// Vite の `?raw` で CSS / SVG の中身を文字列として取り込み、色値のドリフトを検証する
// (型は `vite/client` が提供。Node の fs/types に依存しない)。
import brandCss from "../App.css?raw";
import faviconSvg from "../../public/brand-icon.svg?raw";
import {
  BRAND_BLUE,
  BRAND_INDIGO,
  BRAND_VIOLET,
  BRAND_GRADIENT_STOPS,
} from "../brand";

/**
 * ブランドカラー (#619) の整合性を固定する。色値は 3 か所に出る:
 *   - `brand.tsx` の定数 (TS から参照)
 *   - `App.css` の `--brand-*` (CSS / スプラッシュのグラデーションが参照)
 *   - `public/brand-icon.svg` (favicon)
 * いずれかだけ変えるとブランドがちぐはぐになるため、ここで一致を検証してドリフトを
 * 防ぐ。
 */
describe("brand colors (#619)", () => {
  const HEX = /^#[0-9a-f]{6}$/;

  it("exposes valid 6-digit hex constants", () => {
    expect(BRAND_BLUE).toMatch(HEX);
    expect(BRAND_INDIGO).toMatch(HEX);
    expect(BRAND_VIOLET).toMatch(HEX);
  });

  it("gradient runs blue -> violet", () => {
    expect(BRAND_GRADIENT_STOPS).toEqual([BRAND_BLUE, BRAND_VIOLET]);
  });

  it("matches the --brand-* CSS variables in App.css", () => {
    expect(brandCss).toContain(`--brand-blue: ${BRAND_BLUE}`);
    expect(brandCss).toContain(`--brand-indigo: ${BRAND_INDIGO}`);
    expect(brandCss).toContain(`--brand-violet: ${BRAND_VIOLET}`);
  });

  it("matches the favicon gradient stops", () => {
    expect(faviconSvg).toContain(`stop-color="${BRAND_BLUE}"`);
    expect(faviconSvg).toContain(`stop-color="${BRAND_VIOLET}"`);
  });
});
