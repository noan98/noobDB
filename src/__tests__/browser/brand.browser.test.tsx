import { afterEach, describe, expect, it } from "vitest";
import { renderInBrowser } from "./render";
import { t } from "../../i18n";
import { BrandMark, BrandLockup } from "../../brand";
import { SplashScreen } from "../../components/SplashScreen";
import { HelpView } from "../../components/HelpView";

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

  describe("スプラッシュの hero-wash (#1216)", () => {
    afterEach(() => document.documentElement.removeAttribute("data-theme"));
    const rootBg = () => {
      const el = document.querySelector('[aria-hidden="true"]');
      return getComputedStyle(el as Element).backgroundImage;
    };

    it("通常テーマでは radial-gradient が描画される (bg ショートハンドに打ち消されない)", async () => {
      document.documentElement.setAttribute("data-theme", "light");
      await renderInBrowser(<SplashScreen />);
      await expect.poll(rootBg).toContain("radial-gradient");
    });

    it("hc-dark では none", async () => {
      document.documentElement.setAttribute("data-theme", "hc-dark");
      await renderInBrowser(<SplashScreen />);
      await expect.poll(rootBg).toBe("none");
    });
  });

  describe("シグネチャ・アニメーション (#1505)", () => {
    afterEach(() => document.documentElement.removeAttribute("data-theme"));
    const animName = (sel: string) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).animationName : null;
    };

    it("animate で n と横線に keyframe が付く", async () => {
      await renderInBrowser(<BrandMark size={96} animate />);
      await expect.poll(() => animName(".brand-mark-n")).toBe("brand-mark-n-draw");
      await expect.poll(() => animName(".brand-mark-bar")).toBe("brand-mark-bar-slide");
    });

    it("animate 無しは従来の静的ロゴ (アニメ用クラスが付かない)", async () => {
      await renderInBrowser(<BrandMark size={96} />);
      await expect.poll(() => document.querySelector("svg")).toBeTruthy();
      expect(document.querySelector(".brand-mark-anim, .brand-mark-n, .brand-mark-bar")).toBeNull();
    });

    it("mono トーンでは animate を無視する", async () => {
      await renderInBrowser(<BrandMark size={48} tone="mono" animate />);
      await expect.poll(() => document.querySelector("svg")).toBeTruthy();
      expect(document.querySelector(".brand-mark-anim")).toBeNull();
    });

    it("hc-* では静止する", async () => {
      document.documentElement.setAttribute("data-theme", "hc-dark");
      await renderInBrowser(<BrandMark size={96} animate />);
      await expect.poll(() => animName(".brand-mark-n")).toBe("none");
      await expect.poll(() => animName(".brand-mark-bar")).toBe("none");
    });

    it("アプリ内モーション量が reduced なら即時化される", async () => {
      document.documentElement.setAttribute("data-motion", "reduced");
      try {
        await renderInBrowser(<BrandMark size={96} animate />);
        await expect
          .poll(() => {
            const el = document.querySelector(".brand-mark-n");
            return el ? parseFloat(getComputedStyle(el).animationDuration) : null;
          })
          .toBeLessThan(0.001);
      } finally {
        document.documentElement.removeAttribute("data-motion");
      }
    });
  });

  describe("設定・ヘルプのヘッダ罫線 (#1878)", () => {
    afterEach(() => document.documentElement.removeAttribute("data-theme"));
    const rule = () => document.querySelector('[data-testid="modal-header-brand-rule"]');

    it("通常テーマではブランドグラデーションの罫線が表示される", async () => {
      document.documentElement.setAttribute("data-theme", "dark");
      await renderInBrowser(<HelpView onClose={() => {}} />);
      await expect.poll(() => (rule() ? getComputedStyle(rule() as Element).display : null)).toBe("block");
      expect(getComputedStyle(rule() as Element).backgroundImage).toContain("linear-gradient");
    });

    it("hc-dark では罫線が消える", async () => {
      document.documentElement.setAttribute("data-theme", "hc-dark");
      await renderInBrowser(<HelpView onClose={() => {}} />);
      await expect.poll(() => (rule() ? getComputedStyle(rule() as Element).display : null)).toBe("none");
    });
  });
});
