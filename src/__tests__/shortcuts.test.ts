import { afterEach, describe, expect, it } from "vitest";
import { setLocale, t } from "../i18n";
import {
  SHORTCUTS,
  SHORTCUT_CATEGORY_LABEL,
  SHORTCUT_CATEGORY_ORDER,
} from "../shortcuts";

// ショートカット定義の単一ソース (#448)。HelpView とチートシートが共有するため、
// 文言の欠落やカテゴリの取りこぼしが両画面を同時に壊す。ここで整合性を担保する。

afterEach(() => setLocale("en"));

describe("SHORTCUTS", () => {
  it("各ショートカットの表記・説明が両ロケールで非空に解決される", () => {
    for (const loc of ["en", "ja"] as const) {
      setLocale(loc);
      for (const s of SHORTCUTS) {
        expect(t(s.keysKey).trim().length).toBeGreaterThan(0);
        expect(t(s.descKey).trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("使用されるカテゴリはすべて表示順 (CATEGORY_ORDER) に含まれる", () => {
    const used = new Set(SHORTCUTS.map((s) => s.category));
    for (const category of used) {
      expect(SHORTCUT_CATEGORY_ORDER).toContain(category);
    }
  });

  it("表示順の各カテゴリにラベルキーが対応し、両ロケールで解決される", () => {
    for (const loc of ["en", "ja"] as const) {
      setLocale(loc);
      for (const category of SHORTCUT_CATEGORY_ORDER) {
        expect(t(SHORTCUT_CATEGORY_LABEL[category]).trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("表記キーは重複しない (チートシートの key として一意である必要がある)", () => {
    const keys = SHORTCUTS.map((s) => s.keysKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
