// @vitest-environment jsdom (settings が localStorage に触れるため)
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  DEFAULT_WINDOW_MATERIAL,
  WINDOW_MATERIAL_ORDER,
  normalizeSettings,
} from "../settings";
import { effectiveWindowMaterial } from "../windowMaterial";

describe("windowMaterial の正規化 (#2359)", () => {
  it("既定は none (既存ユーザの見た目は変わらない)", () => {
    expect(DEFAULT_WINDOW_MATERIAL).toBe("none");
    expect(DEFAULT_SETTINGS.windowMaterial).toBe("none");
    expect(normalizeSettings({}).windowMaterial).toBe("none");
  });

  it("有効な値はそのまま採用し、未知の値・型不一致は none へ落ちる", () => {
    for (const v of WINDOW_MATERIAL_ORDER) {
      expect(normalizeSettings({ windowMaterial: v }).windowMaterial).toBe(v);
    }
    for (const bad of ["acrylic", 1, null, {}, true]) {
      expect(normalizeSettings({ windowMaterial: bad }).windowMaterial).toBe("none");
    }
  });
});

describe("effectiveWindowMaterial (#2359)", () => {
  it("対応環境かつ通常コントラストなら設定値をそのまま使う", () => {
    expect(effectiveWindowMaterial("mica", true, false)).toBe("mica");
    expect(effectiveWindowMaterial("mica-alt", true, false)).toBe("mica-alt");
    expect(effectiveWindowMaterial("none", true, false)).toBe("none");
  });

  it("非対応の OS (Windows 10 / macOS / Linux) では none", () => {
    expect(effectiveWindowMaterial("mica", false, false)).toBe("none");
  });

  it("ハイコントラストでは none", () => {
    expect(effectiveWindowMaterial("mica-alt", true, true)).toBe("none");
  });
});
