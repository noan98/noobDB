// ツリーのインデントガイド線の入切 (#2452): 設定 treeGuides が <html data-tree-guides> へ反映され、
// オフのときガイド線の色トークンが透明になることを実ブラウザで固定する。
import "../../App.css";
import { beforeEach, expect, test } from "vitest";
import { renderInBrowser } from "./render";
import App from "../../App";
import { setLocale, t } from "../../i18n";
import { setTreeGuides } from "../../settings";
import { installTauriMock, onCommand } from "./tauriMock";

beforeEach(() => {
  localStorage.clear();
  installTauriMock();
  onCommand("list_profiles", () => []);
  onCommand("list_snippets", () => []);
  onCommand("list_history", () => []);
  onCommand("list_sandboxes", () => []);
  onCommand("list_tasks", () => []);
  setLocale("en");
  setTreeGuides(true);
});

test("設定オフで data-tree-guides=off になり、線の色が透明になる", async () => {
  const screen = await renderInBrowser(<App />);
  await expect
    .element(screen.getByRole("tab", { name: t("sidebarTabConnections"), exact: true }))
    .toBeVisible();
  const root = document.documentElement;
  await expect.poll(() => root.getAttribute("data-tree-guides")).toBe("on");
  setTreeGuides(false);
  await expect.poll(() => root.getAttribute("data-tree-guides")).toBe("off");
  expect(getComputedStyle(root).getPropertyValue("--tree-guide").trim()).toBe("transparent");
  setTreeGuides(true);
});
