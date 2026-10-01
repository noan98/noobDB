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
