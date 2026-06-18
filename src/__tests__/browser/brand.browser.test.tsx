import { describe, expect, it } from "vitest";
import { renderInBrowser } from "./render";
import { t } from "../../i18n";
import { BrandMark, BrandLockup } from "../../brand";
import { SplashScreen } from "../../components/SplashScreen";

// ブランドビジュアル (#619) の実ブラウザスモーク。ロゴマーク・ワードマーク・
// スプラッシュが例外なく描画されることを確認する (両テーマ破綻の自動検出は
// 将来の visual.browser に乗せられる)。
describe("ブランドビジュアル (実ブラウザ)", () => {
  it("ブランドマークが SVG として描画される", async () => {
    await renderInBrowser(<BrandMark size={48} />);
    // 装飾なので role からは隠れる (aria-hidden)。DOM 上に svg が出ることを確認。
    await expect.poll(() => document.querySelector("svg")).toBeTruthy();
  });

  it("ロックアップがワードマークを描画する", async () => {
    const screen = await renderInBrowser(<BrandLockup />);
    await expect.element(screen.getByText("noob")).toBeVisible();
    await expect.element(screen.getByText("DB", { exact: true })).toBeVisible();
  });

  it("スプラッシュがタグラインを描画する", async () => {
    const screen = await renderInBrowser(<SplashScreen />);
    await expect.element(screen.getByText(t("splashTagline"))).toBeVisible();
  });
});
