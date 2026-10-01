// サイドバーのタブ列が日本語ロケールでも 1 行に収まることを実ブラウザで固定する (#1283)。
// jsdom はレイアウトを計算しないため、折り返し (= タブの高さの不揃い) は実 Chromium で測る。
import "../../App.css";
import { beforeEach, expect, test } from "vitest";
import { renderInBrowser } from "./render";
import App from "../../App";
import { setLocale, t, type Locale } from "../../i18n";
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH } from "../../components/sidebarLayout";
import { setFontSizePx } from "../../settings";
import { installTauriMock, onCommand } from "./tauriMock";

beforeEach(() => {
  localStorage.clear();
  installTauriMock();
  onCommand("list_profiles", () => []);
  onCommand("list_snippets", () => []);
  onCommand("list_history", () => []);
  onCommand("list_sandboxes", () => []);
  onCommand("list_tasks", () => []);
});

async function tabHeights(locale: Locale, width: number, fontPx?: number) {
  setLocale(locale);
  localStorage.setItem("noobdb.sidebarWidth", String(width));
  if (fontPx) setFontSizePx(fontPx);
  const screen = await renderInBrowser(<App />);
  const first = screen.getByRole("tab", { name: t("sidebarTabConnections"), exact: true });
  await expect.element(first).toBeVisible();
  const tabs = Array.from(document.querySelectorAll<HTMLElement>('[role="tablist"] > [role="tab"]'))
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
