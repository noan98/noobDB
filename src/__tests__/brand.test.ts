import { describe, it, expect } from "vitest";
// Vite の `?raw` で CSS / SVG の中身を文字列として取り込み、色値のドリフトを検証する
// (型は `vite/client` が提供。Node の fs/types に依存しない)。
import brandCss from "../App.css?raw";
import illustrationsSrc from "../components/illustrations.tsx?raw";
import faviconSvg from "../../public/brand-icon.svg?raw";
import {
  BRAND_BLUE,
  BRAND_INDIGO,
  BRAND_VIOLET,
  BRAND_GRADIENT_STOPS,
} from "../brand";
import { SANDBOX_BAND_COLOR } from "../sandbox";

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

  it("sandbox band color stays in sync with the brand violet (#1111)", () => {
    // サンドボックス (ローカルコピー) の帯色は brand violet と同一色相で運用する。
    // `sandbox.ts` の定数 (TitleBar の帯がインラインスタイルで参照) と App.css の
    // `--sandbox-solid` (ProfileBadge が Chakra トークン経由で参照) が別々の値に
    // ドリフトすると、同じ「サンドボックス」を指す UI が 2 色に割れる。
    expect(SANDBOX_BAND_COLOR).toBe(BRAND_VIOLET);
    expect(brandCss).toContain("--sandbox-solid: var(--brand-violet)");
  });

  it("matches the favicon gradient stops", () => {
    expect(faviconSvg).toContain(`stop-color="${BRAND_BLUE}"`);
    expect(faviconSvg).toContain(`stop-color="${BRAND_VIOLET}"`);
  });

  /**
   * ウェルカム/プロファイルカード画面のヒーロー背景 (#1163)。
   *
   * `--hero-wash` はハードコードした色を持たず、`--brand-blue` / `--brand-violet`
   * (このスイートで一致を固定している単一ソース) を `color-mix` で薄めて作る。
   * 値そのものの正規表現検証は App.css を書き換えるたびに更新が要って壊れやすい
   * ため避け、代わりに「単一ソースを参照していること」と「不透明度が控えめな
   * 範囲に収まっていること」を固定する。後者は、将来誰かが視認性を上げようとして
   * 割合を大きくし、本文/カードのコントラストを損なう回帰を検知する。
   */
  it("hero wash は brand-blue/violet を単一ソースとして参照し、不透明度が控えめに収まる (#1163)", () => {
    const m = brandCss.match(/--hero-wash:\s*radial-gradient\(([\s\S]*?)\n\s*\);/);
    expect(m, "--hero-wash (radial-gradient) が :root に定義されている").toBeTruthy();
    const body = m![1];

    expect(body).toContain("var(--brand-blue)");
    expect(body).toContain("var(--brand-violet)");

    // color-mix(in srgb, var(--brand-*) N%, transparent) の N (%) を全て抽出し、
    // 「控えめ」の閾値 (15%) を超えないことを確認する。
    const percentages = [...body.matchAll(/color-mix\(in srgb, var\(--brand-\w+\) (\d+)%/g)].map(
      ([, pct]) => Number(pct),
    );
    expect(percentages.length).toBeGreaterThan(0);
    for (const pct of percentages) {
      expect(pct, `hero wash の不透明度 ${pct}% は控えめな上限 (15%) を超えている`).toBeLessThanOrEqual(15);
    }
  });

  it("高コントラストプリセット (hc-light/hc-dark) はヒーローウォッシュを敷かない (#1163)", () => {
    const hcLight = brandCss.match(/:root\[data-theme="hc-light"\]\s*\{([\s\S]*?)\n\}/);
    const hcDark = brandCss.match(/:root\[data-theme="hc-dark"\]\s*\{([\s\S]*?)\n\}/);
    expect(hcLight, "hc-light ブロックが見つかる").toBeTruthy();
    expect(hcDark, "hc-dark ブロックが見つかる").toBeTruthy();
    expect(hcLight![1]).toMatch(/--hero-wash:\s*none;/);
    expect(hcDark![1]).toMatch(/--hero-wash:\s*none;/);
  });
  it("hero halo / rule は brand 単一ソースを参照し、不透明度は 25% 以下、hc-* では無効化する (#1216)", () => {
    const m = brandCss.match(/--hero-halo:\s*radial-gradient\(([\s\S]*?)\n\s*\);/);
    expect(m, "--hero-halo (radial-gradient) が :root に定義されている").toBeTruthy();
    expect(m![1]).toContain("var(--brand-blue)");
    expect(m![1]).toContain("var(--brand-violet)");
    const pcts = [...m![1].matchAll(/color-mix\(in srgb, var\(--brand-\w+\) (\d+)%/g)].map(([, p]) => Number(p));
    expect(pcts.length).toBeGreaterThan(0);
    for (const pct of pcts) expect(pct).toBeLessThanOrEqual(25);
    expect(brandCss).toMatch(/--hero-rule:\s*var\(--brand-gradient\);/);

    for (const theme of ["hc-light", "hc-dark"]) {
      const block = brandCss.match(new RegExp(`:root\\[data-theme="${theme}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`));
      expect(block, `${theme} ブロックが見つかる`).toBeTruthy();
      expect(block![1]).toMatch(/--hero-halo:\s*none;/);
      expect(block![1]).toMatch(/--hero-rule:\s*none;/);
      expect(block![1]).toMatch(/--hero-rule-display:\s*none;/);
    }
  });

  it("イラストの duotone は hc-* で地と接地影を消し、全 svg が noob-illust を持つ (#1216)", () => {
    const hc = brandCss.match(
      /:root\[data-theme="hc-light"\] \.noob-illust,\s*:root\[data-theme="hc-dark"\] \.noob-illust\s*\{([\s\S]*?)\}/,
    );
    expect(hc, "hc-* の .noob-illust 上書きがある").toBeTruthy();
    expect(hc![1]).toMatch(/--illust-body-fill:\s*none;/);
    expect(hc![1]).toMatch(/--illust-ground:\s*none;/);

    const src = illustrationsSrc;
    // 全イラストは className="noob-illust" を付ける Svg ラッパ経由で、生の ChakraSvg は 1 箇所のみ。
    expect(src.match(/<ChakraSvg\b/g)?.length).toBe(1);
    expect(src).toContain('className="noob-illust"');
  });
});
