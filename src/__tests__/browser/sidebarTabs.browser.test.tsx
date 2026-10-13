// サイドバーのタブ列が日本語ロケールでも 1 行に収まることを実ブラウザで固定する (#1283)。
// jsdom はレイアウトを計算しないため、折り返し (= タブの高さの不揃い) は実 Chromium で測る。
import "../../App.css";
import { beforeEach, expect, test } from "vitest";
import { renderInBrowser } from "./render";
import App from "../../App";
import { setLocale, t, type Locale } from "../../i18n";
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH } from "../../components/sidebarLayout";
import { DEFAULT_FONT_SIZE_PX, setFontSizePx } from "../../settings";
import { installTauriMock, onCommand } from "./tauriMock";

beforeEach(() => {
  localStorage.clear();
  installTauriMock();
  onCommand("list_profiles", () => []);
  onCommand("list_snippets", () => []);
  onCommand("list_history", () => []);
  onCommand("list_sandboxes", () => []);
  onCommand("list_tasks", () => []);
  // フォント拡大のテストが変えた文字サイズを、後続のテストへ持ち越さない。
  setFontSizePx(DEFAULT_FONT_SIZE_PX);
});

async function tabHeights(locale: Locale, width: number, fontPx?: number) {
  setLocale(locale);
  localStorage.setItem("noobdb.sidebarWidth", String(width));
  if (fontPx) setFontSizePx(fontPx);
  const screen = await renderInBrowser(<App />);
  const first = screen.getByRole("tab", { name: t("sidebarTabConnections"), exact: true });
  await expect.element(first).toBeVisible();
  const tabs = Array.from(document.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"]'))
    .filter((el) => el.closest('[aria-label="' + t("sidebarTablistAria") + '"]'));
  expect(tabs.length).toBe(4);
  return tabs.map((el) => el.getBoundingClientRect().height);
}

function expectSingleLine(heights: number[]) {
  // 全タブの高さが揃い、2 行ぶん (最小のタブの 1.5 倍) には膨らんでいない。
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1);
  const labelLine = parseFloat(getComputedStyle(document.documentElement).fontSize);
  expect(heights[0]).toBeLessThan(labelLine * 3);
}

test("日本語・既定幅 (300px) で 4 タブが 1 行に収まる", async () => {
  expectSingleLine(await tabHeights("ja", SIDEBAR_DEFAULT_WIDTH));
});

test("日本語・最小幅でも折り返さない", async () => {
  expectSingleLine(await tabHeights("ja", SIDEBAR_MIN_WIDTH));
});

test("日本語・フォント拡大でも折り返さない", async () => {
  expectSingleLine(await tabHeights("ja", SIDEBAR_MIN_WIDTH, 20));
});

test("英語・既定幅で見た目が変わらず 1 行", async () => {
  expectSingleLine(await tabHeights("en", SIDEBAR_DEFAULT_WIDTH));
});

function sidebarTablist(): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[role="tablist"][aria-label="${t("sidebarTablistAria")}"]`);
  if (!el) throw new Error("sidebar tablist not found");
  return el;
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

test("タブを切り替えても下線のアニメーションでスクロールバーが出ない", async () => {
  setLocale("ja");
  localStorage.setItem("noobdb.sidebarWidth", String(SIDEBAR_DEFAULT_WIDTH));
  const screen = await renderInBrowser(<App />);
  await expect.element(screen.getByRole("tab", { name: t("sidebarTabConnections"), exact: true })).toBeVisible();
  const tablist = sidebarTablist();
  // 右端の「ローカル」へ移るときに下線のスプリングが行き過ぎて、タブ列の幅を
  // 一瞬はみ出していた。アニメーション中の毎フレームで、はみ出していないことを確かめる。
  for (const key of ["local", "connections", "local", "snippets"]) {
    (document.getElementById(`sidebar-tab-${key}`) as HTMLElement).click();
    const start = performance.now();
    while (performance.now() - start < 600) {
      await nextFrame();
      expect(tablist.scrollWidth).toBeLessThanOrEqual(tablist.clientWidth);
      expect(tablist.scrollHeight).toBeLessThanOrEqual(tablist.clientHeight);
    }
  }
});

test("各タブにアイコンが付き、既定幅ではラベルも見える", async () => {
  setLocale("ja");
  localStorage.setItem("noobdb.sidebarWidth", String(SIDEBAR_DEFAULT_WIDTH));
  const screen = await renderInBrowser(<App />);
  const first = screen.getByRole("tab", { name: t("sidebarTabConnections"), exact: true });
  await expect.element(first).toBeVisible();
  const tabs = Array.from(sidebarTablist().querySelectorAll<HTMLElement>('[role="tab"]'));
  expect(tabs).toHaveLength(4);
  for (const tab of tabs) {
    expect(tab.querySelector("svg")).not.toBeNull();
    const label = tab.querySelector<HTMLElement>("[data-sidebar-tab-label]");
    expect(label?.getBoundingClientRect().width ?? 0).toBeGreaterThan(1);
  }
});

test("最小幅ではアイコンだけになり、横スクロールせず読み上げ名は残る", async () => {
  setLocale("ja");
  localStorage.setItem("noobdb.sidebarWidth", String(SIDEBAR_MIN_WIDTH));
  const screen = await renderInBrowser(<App />);
  // 読み上げ名 (アクセシブルネーム) はラベルのまま。
  await expect.element(screen.getByRole("tab", { name: t("sidebarTabSnippets"), exact: true })).toBeInTheDocument();
  const tablist = sidebarTablist();
  await expect.poll(() => tablist.scrollWidth <= tablist.clientWidth).toBe(true);
  for (const label of Array.from(tablist.querySelectorAll<HTMLElement>("[data-sidebar-tab-label]"))) {
    expect(label.getBoundingClientRect().width).toBeLessThanOrEqual(1);
  }
});
