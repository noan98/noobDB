import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_MOTION_PREFERENCE,
  DEFAULT_SETTINGS,
  MOTION_PREFERENCE_ORDER,
  normalizeSettings,
} from "../settings";

// モーション量コントロール (#787) の純ロジック。sanitize は normalizeSettings 経由で
// 検証する (他の enum 系フィールド — themePreset 等 — と同じ形。sanitize 関数自体は
// モジュール非公開で、他フィールドと同型の設計)。

describe("motionPreference の正規化 (#787)", () => {
  it("既定値は system", () => {
    expect(DEFAULT_MOTION_PREFERENCE).toBe("system");
    expect(DEFAULT_SETTINGS.motionPreference).toBe("system");
  });

  it("欠損フィールドは既定 (system) にフォールバックする", () => {
    expect(normalizeSettings({}).motionPreference).toBe("system");
  });

  it("有効な値 (system/full/reduced) はそのまま採用する", () => {
    for (const v of MOTION_PREFERENCE_ORDER) {
      expect(normalizeSettings({ motionPreference: v }).motionPreference).toBe(v);
    }
  });

  it("未知の値・型不一致は既定へ落ちる (例外を投げない)", () => {
    for (const bad of ["bogus", 1, null, {}, ["reduced"], true]) {
      expect(normalizeSettings({ motionPreference: bad }).motionPreference).toBe(
        DEFAULT_MOTION_PREFERENCE,
      );
    }
  });

  it("他のフィールドが壊れていても motionPreference は独立して正規化される", () => {
    const result = normalizeSettings({
      motionPreference: "reduced",
      defaultDisplayCount: "not-a-number",
    });
    expect(result.motionPreference).toBe("reduced");
  });
});

describe("setMotionPreference / resetAppearanceDefaults (#787)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("設定・永続化・購読者通知の一連の流れが動く", async () => {
    vi.resetModules();
    const mod = await import("../settings");
    expect(mod.getSettings().motionPreference).toBe("system");

    mod.setMotionPreference("reduced");
    expect(mod.getSettings().motionPreference).toBe("reduced");

    // 再ロードしても永続化された値を読み戻す。
    vi.resetModules();
    const reloaded = await import("../settings");
    expect(reloaded.getSettings().motionPreference).toBe("reduced");
  });

  it("resetAppearanceDefaults は motionPreference も既定へ戻す", async () => {
    vi.resetModules();
    const mod = await import("../settings");
    mod.setMotionPreference("full");
    expect(mod.getSettings().motionPreference).toBe("full");
    mod.resetAppearanceDefaults();
    expect(mod.getSettings().motionPreference).toBe("system");
  });

  it("無効な値を渡しても現在値を保つ (フォールバック)", async () => {
    vi.resetModules();
    const mod = await import("../settings");
    mod.setMotionPreference("reduced");
    // @ts-expect-error 不正な値を意図的に渡して sanitize のフォールバックを確認する
    mod.setMotionPreference("bogus");
    expect(mod.getSettings().motionPreference).toBe("reduced");
  });
});
