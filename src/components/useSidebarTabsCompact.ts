import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * サイドバーのタブ 1 つぶんの寸法。`requiredSidebarTabsWidth` が「ラベル付きで
 * 並べたときに要る幅」を求めるのに使う。
 */
export interface SidebarTabMetrics {
  /** 左右パディングの合計。 */
  paddingX: number;
  /** アイコンの幅。 */
  iconWidth: number;
  /** アイコンとラベルの間隔。 */
  gap: number;
  /** ラベル文字列の幅。 */
  labelWidth: number;
}

/** ラベル付きで全タブを 1 行に並べるのに要る幅。 */
export function requiredSidebarTabsWidth(tabs: readonly SidebarTabMetrics[]): number {
  return tabs.reduce((sum, tab) => sum + tab.paddingX + tab.iconWidth + tab.gap + tab.labelWidth, 0);
}

/**
 * ラベルを隠してアイコンだけにすべきか。小数点以下の丸めで境界が揺れないよう
 * 1px の余裕を見る。
 */
export function shouldCompactSidebarTabs(available: number, required: number): boolean {
  return required - available > 1;
}

/** ラベル要素に付ける目印。計測でラベルを探すのに使う。 */
export const SIDEBAR_TAB_LABEL_ATTR = "data-sidebar-tab-label";

function measureTab(tab: HTMLElement): SidebarTabMetrics {
  const cs = getComputedStyle(tab);
  const icon = tab.querySelector("svg");
  const label = tab.querySelector<HTMLElement>(`[${SIDEBAR_TAB_LABEL_ATTR}]`);
  return {
    paddingX: (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0),
    iconWidth: icon ? icon.getBoundingClientRect().width : 0,
    gap: parseFloat(cs.columnGap) || 0,
    // ラベルは表示中も visually-hidden 中も white-space: nowrap なので、scrollWidth が
    // 常に文字列の幅になる (隠しているときは 1px の箱からはみ出した分も含む)。
    labelWidth: label ? label.scrollWidth : 0,
  };
}

/**
 * サイドバーのタブ列がラベル付きで収まらない幅になったら `true` を返す。
 *
 * アイコンを付けたぶんタブ列の幅が増え、既定幅より少し狭いだけで常に横スクロール
 * バーが出てしまうため、収まらないときはラベルを隠してアイコンだけにする
 * (ラベルは読み上げ名とツールチップに残す)。必要な幅は表示モードに依らずに
 * 求めるので、切り替えた直後に判定が反転してちらつくことはない。
 *
 * - タブ列の幅の変化 (サイドバーのリサイズ) とアイコンの大きさの変化 (フォント拡大)
 *   を ResizeObserver で拾う。Web フォントの読み込み完了でも測り直す。
 * - ラベルの文言が変わったとき (言語切替) は `labelsKey` (全ラベルを連結した文字列) の
 *   変化で測り直す。
 */
export function useSidebarTabsCompact(
  tablistRef: RefObject<HTMLElement | null>,
  labelsKey: string,
): boolean {
  const [compact, setCompact] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: labelsKey は言語切替で測り直すためのトリガー
  useLayoutEffect(() => {
    const tablist = tablistRef.current;
    if (!tablist) return;
    const update = () => {
      const tabs = Array.from(tablist.querySelectorAll<HTMLElement>('[role="tab"]'));
      const required = requiredSidebarTabsWidth(tabs.map(measureTab));
      setCompact(shouldCompactSidebarTabs(tablist.clientWidth, required));
    };
    update();
    // Web フォントの読み込みでラベルの幅が変わる。アイコンだけの表示中はラベルの箱が
    // 1px 固定で ResizeObserver が反応しないため、読み込み完了で測り直す。
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    fonts?.addEventListener?.("loadingdone", update);
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    if (ro) {
      ro.observe(tablist);
      for (const icon of Array.from(tablist.querySelectorAll("svg"))) ro.observe(icon);
    }
    return () => {
      ro?.disconnect();
      fonts?.removeEventListener?.("loadingdone", update);
    };
  }, [tablistRef, labelsKey]);
  return compact;
}
