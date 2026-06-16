import { describe, expect, it } from "vitest";
import {
  canonicalizeCombo,
  comboMatchesEvent,
  comboToCodeMirror,
  eventToCombo,
  findShortcutConflicts,
  formatCombo,
} from "../shortcutKeys";
import { DEFAULT_SHORTCUT_COMBOS, resolveShortcutBindings, SHORTCUT_SCOPES } from "../shortcuts";

function key(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  } as KeyboardEvent;
}

describe("canonicalizeCombo", () => {
  it("normalizes modifier order and casing", () => {
    expect(canonicalizeCombo("shift+mod+enter")).toBe("Mod+Shift+Enter");
    expect(canonicalizeCombo("Ctrl+k")).toBe("Mod+K");
    expect(canonicalizeCombo("Cmd+Alt+ENTER")).toBe("Mod+Alt+Enter");
  });
});

describe("eventToCombo", () => {
  it("returns null for modifier-only presses", () => {
    expect(eventToCombo(key({ key: "Shift", shiftKey: true }))).toBeNull();
    expect(eventToCombo(key({ key: "Meta", metaKey: true }))).toBeNull();
  });

  it("treats Cmd and Ctrl alike as Mod", () => {
    expect(eventToCombo(key({ key: "k", metaKey: true }))).toBe("Mod+K");
    expect(eventToCombo(key({ key: "k", ctrlKey: true }))).toBe("Mod+K");
  });

  it("encodes Enter with modifiers", () => {
    expect(eventToCombo(key({ key: "Enter", ctrlKey: true, shiftKey: true }))).toBe(
      "Mod+Shift+Enter",
    );
  });
});

describe("comboMatchesEvent", () => {
  it("matches regardless of token order/case", () => {
    expect(comboMatchesEvent("Mod+Enter", key({ key: "Enter", metaKey: true }))).toBe(true);
    expect(comboMatchesEvent("shift+mod+f", key({ key: "F", ctrlKey: true, shiftKey: true }))).toBe(
      true,
    );
  });

  it("does not match when modifiers differ", () => {
    expect(comboMatchesEvent("Mod+Enter", key({ key: "Enter" }))).toBe(false);
    expect(
      comboMatchesEvent("Mod+Enter", key({ key: "Enter", metaKey: true, shiftKey: true })),
    ).toBe(false);
  });
});

describe("formatCombo", () => {
  it("renders platform-neutral labels", () => {
    expect(formatCombo("Mod+Enter")).toBe("Cmd/Ctrl+Enter");
    expect(formatCombo("Mod+Shift+Enter")).toBe("Cmd/Ctrl+Shift+Enter");
    expect(formatCombo("Mod+Alt+Enter")).toBe("Cmd/Ctrl+Alt/Option+Enter");
  });
});

describe("comboToCodeMirror", () => {
  it("uses dash separators and CodeMirror conventions", () => {
    expect(comboToCodeMirror("Mod+Enter")).toBe("Mod-Enter");
    expect(comboToCodeMirror("Mod+Shift+F")).toBe("Mod-Shift-f");
    expect(comboToCodeMirror("Mod+Alt+Enter")).toBe("Mod-Alt-Enter");
  });
});

describe("findShortcutConflicts", () => {
  it("flags same-scope duplicate combos but not cross-scope ones", () => {
    const bindings = {
      run: "Mod+Enter",
      preview: "Mod+Shift+Enter",
      runNewTab: "Mod+Shift+Enter",
      newTab: "Mod+T",
    };
    const scopes = {
      run: "editor",
      preview: "editor",
      runNewTab: "global",
      newTab: "global",
    };
    // preview(editor) と runNewTab(global) は同じキーだがスコープが違うので衝突しない。
    expect(findShortcutConflicts(bindings, scopes)).toEqual(new Set());
  });

  it("flags two bindings sharing a combo within one scope", () => {
    const conflicts = findShortcutConflicts(
      { a: "Mod+K", b: "Mod+K", c: "Mod+P" },
      { a: "global", b: "global", c: "global" },
    );
    expect(conflicts).toEqual(new Set(["a", "b"]));
  });
});

describe("resolveShortcutBindings (defaults + scopes are conflict-free)", () => {
  it("default bindings have no in-scope conflicts", () => {
    const resolved = resolveShortcutBindings({});
    expect(resolved).toEqual(DEFAULT_SHORTCUT_COMBOS);
    expect(findShortcutConflicts(resolved, SHORTCUT_SCOPES)).toEqual(new Set());
  });

  it("applies a valid override and ignores blank ones", () => {
    const resolved = resolveShortcutBindings({ run: "Mod+R", preview: "  " });
    expect(resolved.run).toBe("Mod+R");
    expect(resolved.preview).toBe(DEFAULT_SHORTCUT_COMBOS.preview);
  });
});
