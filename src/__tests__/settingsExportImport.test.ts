import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_ACCENT_COLOR,
  DEFAULT_SETTINGS,
  MAX_FONT_SIZE_PX,
  SETTINGS_EXPORT_KIND,
  SETTINGS_EXPORT_VERSION,
  deserializeSettingsImport,
  serializeSettingsExport,
} from "../settings";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("serializeSettingsExport (#679)", () => {
  it("wraps the settings in a kind/version/exportedAt envelope", () => {
    const json = serializeSettingsExport(DEFAULT_SETTINGS, "2026-01-01T00:00:00.000Z");
    const parsed = JSON.parse(json);
    expect(parsed.kind).toBe(SETTINGS_EXPORT_KIND);
    expect(parsed.version).toBe(SETTINGS_EXPORT_VERSION);
    expect(parsed.exportedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(parsed.settings).toEqual(DEFAULT_SETTINGS);
  });

  it("defaults exportedAt to the current time when omitted", () => {
    const json = serializeSettingsExport(DEFAULT_SETTINGS);
    const parsed = JSON.parse(json);
    expect(typeof parsed.exportedAt).toBe("string");
    expect(() => new Date(parsed.exportedAt)).not.toThrow();
  });
});

describe("deserializeSettingsImport (#679)", () => {
  it("round-trips settings produced by serializeSettingsExport", () => {
    const customized = {
      ...DEFAULT_SETTINGS,
      fontSizePx: 18,
      density: "compact" as const,
      shortcutOverrides: { runQuery: "Mod-Enter" },
    };
    const json = serializeSettingsExport(customized);
    const restored = deserializeSettingsImport(json);
    expect(restored).toEqual(customized);
  });

  it("accepts a bare Settings-shaped object without the export envelope", () => {
    const bare = { ...DEFAULT_SETTINGS, fontSizePx: 20 };
    const restored = deserializeSettingsImport(JSON.stringify(bare));
    expect(restored.fontSizePx).toBe(20);
  });

  it("normalizes out-of-range or malformed fields instead of throwing", () => {
    const malformed = JSON.stringify({
      kind: SETTINGS_EXPORT_KIND,
      version: 1,
      settings: { fontSizePx: 9999, accentColor: "not-a-color", density: "gigantic" },
    });
    const restored = deserializeSettingsImport(malformed);
    expect(restored.fontSizePx).toBeLessThanOrEqual(MAX_FONT_SIZE_PX);
    expect(restored.accentColor).toBe(DEFAULT_ACCENT_COLOR);
    expect(restored.density).toBe("normal");
  });

  it("falls back to full defaults for a non-object settings payload", () => {
    const restored = deserializeSettingsImport(JSON.stringify({ settings: 42 }));
    expect(restored).toEqual(DEFAULT_SETTINGS);
  });

  it("throws on invalid JSON so callers can surface a parse error", () => {
    expect(() => deserializeSettingsImport("{not json")).toThrow();
  });
});

// `resetAllSettings` / `resetAppearanceDefaults` / `replaceAllSettings` mutate the
// module-level singleton store, so each test re-imports the module fresh
// (same pattern as storageResilience.test.ts) to avoid cross-test pollution.
describe("resetAllSettings (#679)", () => {
  it("resets every section, including keybinding overrides, back to defaults", async () => {
    vi.resetModules();
    const mod = await import("../settings");
    mod.setFontSizePx(20);
    mod.setDensity("compact");
    mod.setShortcutBinding("runQuery", "Mod-Enter");
    expect(mod.getSettings()).not.toEqual(mod.DEFAULT_SETTINGS);

    mod.resetAllSettings();

    expect(mod.getSettings()).toEqual(mod.DEFAULT_SETTINGS);
  });
});

describe("resetAppearanceDefaults (#679)", () => {
  it("resets only the appearance fields, leaving other sections untouched", async () => {
    vi.resetModules();
    const mod = await import("../settings");
    mod.setFontSizePx(20);
    mod.setDensity("compact");
    mod.setAccentColor("#123456");
    mod.setAutoLimitEnabled(false);

    mod.resetAppearanceDefaults();

    const s = mod.getSettings();
    expect(s.fontSizePx).toBe(mod.DEFAULT_FONT_SIZE_PX);
    expect(s.density).toBe(mod.DEFAULT_DENSITY);
    expect(s.accentColor).toBe(mod.DEFAULT_ACCENT_COLOR);
    // Unrelated section is untouched by the appearance-scoped reset.
    expect(s.autoLimitEnabled).toBe(false);
  });
});

describe("replaceAllSettings (#679)", () => {
  it("adopts an imported settings object wholesale", async () => {
    vi.resetModules();
    const mod = await import("../settings");
    const imported = mod.deserializeSettingsImport(
      mod.serializeSettingsExport({ ...mod.DEFAULT_SETTINGS, fontSizePx: 22 }),
    );

    mod.replaceAllSettings(imported);

    expect(mod.getSettings().fontSizePx).toBe(22);
  });

  it("normalizes the replacement as defense in depth", async () => {
    vi.resetModules();
    const mod = await import("../settings");

    mod.replaceAllSettings({ ...mod.DEFAULT_SETTINGS, fontSizePx: 9999 });

    expect(mod.getSettings().fontSizePx).toBeLessThanOrEqual(mod.MAX_FONT_SIZE_PX);
  });
});
