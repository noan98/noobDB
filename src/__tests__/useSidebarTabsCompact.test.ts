import { describe, expect, it } from "vitest";
import {
  requiredSidebarTabsWidth,
  shouldCompactSidebarTabs,
} from "../components/useSidebarTabsCompact";

describe("サイドバータブのアイコンのみ表示の判定", () => {
  const tab = (labelWidth: number) => ({ paddingX: 16, iconWidth: 13, gap: 6, labelWidth });

  it("全タブのパディング・アイコン・間隔・ラベル幅を足し合わせる", () => {
    expect(requiredSidebarTabsWidth([tab(24), tab(60)])).toBe(35 + 24 + 35 + 60);
    expect(requiredSidebarTabsWidth([])).toBe(0);
  });

  it("ラベル付きで収まる幅ならラベルを出す", () => {
    expect(shouldCompactSidebarTabs(300, 298)).toBe(false);
    expect(shouldCompactSidebarTabs(300, 300)).toBe(false);
  });

  it("丸め誤差 (1px 以内) ではアイコンのみに切り替えない", () => {
    expect(shouldCompactSidebarTabs(300, 301)).toBe(false);
  });

  it("収まらない幅ならアイコンのみにする", () => {
    expect(shouldCompactSidebarTabs(250, 298)).toBe(true);
    expect(shouldCompactSidebarTabs(0, 298)).toBe(true);
  });
});
