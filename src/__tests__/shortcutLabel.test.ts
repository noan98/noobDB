import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { labelWithShortcut, shortcutTooltip } from "../shortcutLabel";
import { resolveShortcutBindings } from "../shortcuts";

describe("labelWithShortcut", () => {
  it("appends the formatted combo in parentheses", () => {
    expect(labelWithShortcut("Command palette", "Mod+K")).toBe("Command palette (Cmd/Ctrl+K)");
    expect(labelWithShortcut("Run", "Mod+Shift+Enter")).toBe("Run (Cmd/Ctrl+Shift+Enter)");
  });

  it("returns the bare label when there is no combo", () => {
    expect(labelWithShortcut("Tasks", undefined)).toBe("Tasks");
    expect(labelWithShortcut("Tasks", null)).toBe("Tasks");
    expect(labelWithShortcut("Tasks", "")).toBe("Tasks");
  });

  it("handles single-key combos", () => {
    expect(labelWithShortcut("Help", "F1")).toBe("Help (F1)");
  });
});

describe("shortcutTooltip", () => {
  it("follows user overrides", () => {
    const b = resolveShortcutBindings({ toggleSidebar: "Mod+Alt+B" });
    expect(shortcutTooltip("Collapse sidebar", b, "toggleSidebar")).toBe(
      "Collapse sidebar (Cmd/Ctrl+Alt/Option+B)",
    );
  });

  it("uses the default binding otherwise", () => {
    const b = resolveShortcutBindings(undefined);
    expect(shortcutTooltip("Settings", b, "openSettings")).toBe("Settings (Cmd/Ctrl+,)");
  });
});

// ボタン側の結線 (#1265 / #1275 / #1278)。ツールチップのキー表記が手書きに
// 戻らず、必ず解決済みバインド経由で出ていることを固定する。
describe("button wiring", () => {
  const read = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");
  const app = read("App.tsx");

  it("exposes the command palette button with its shortcut", () => {
    expect(app).toMatch(/onClick=\{\(\) => setShowCommandPalette\(true\)\}/);
    expect(app).toMatch(/shortcutTooltip\(t\("appCommandPalette"\), shortcutBindings, "commandPalette"\)/);
  });

  it.each([
    ["appThemeToLight", "toggleTheme"],
    ["appHelp", "openHelp"],
    ["appSettings", "openSettings"],
    ["sidebarCollapse", "toggleSidebar"],
    ["sidebarExpand", "toggleSidebar"],
  ])("shows the %s tooltip with the %s combo", (key, id) => {
    expect(app).toContain(`${key}`);
    expect(app).toMatch(new RegExp(`shortcutTooltip\\([^\\n]*${key}[^\\n]*"${id}"`));
  });

  it("passes the new-tab combo to TabBar and run/preview tooltips use bindings", () => {
    expect(app).toContain("newTabCombo={shortcutBindings.newTab}");
    const editor = read("components/QueryEditor.tsx");
    expect(editor).toContain("labelWithShortcut(runTitleBase, runCombo)");
    expect(editor).toContain("onRunInNewTab");
    expect(read("components/TabBar.tsx")).toContain("labelWithShortcut(t(\"tabNew\"), newTabCombo)");
  });
});
