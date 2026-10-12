import { afterEach, describe, expect, it } from "vitest";
import { setLocale, t } from "../i18n";
import {
  filterShortcuts,
  SHORTCUTS,
  SHORTCUT_CATEGORY_LABEL,
  SHORTCUT_CATEGORY_ORDER,
} from "../shortcuts";

// ショートカット定義の単一ソース。HelpView とチートシートが共有するため、
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

describe("filterShortcuts (#1540)", () => {
  const items = [
    { id: 1, label: "Open command palette", keys: "Ctrl+K" },
    { id: 2, label: "Format SQL", keys: "Ctrl+Shift+F" },
    { id: 3, label: "コマンドパレットを開く", keys: "⌘K" },
  ];
  const texts = (x: (typeof items)[number]) => ({ label: x.label, keys: x.keys });

  it("空クエリ (空白のみ含む) は全件を元の順序で返す", () => {
    expect(filterShortcuts(items, "", texts)).toEqual(items);
    expect(filterShortcuts(items, "   ", texts)).toEqual(items);
    expect(filterShortcuts(items, "", texts)).not.toBe(items);
  });

  it("表示名の部分一致 (大文字小文字を区別しない)", () => {
    expect(filterShortcuts(items, "FORMAT", texts).map((x) => x.id)).toEqual([2]);
    expect(filterShortcuts(items, "パレット", texts).map((x) => x.id)).toEqual([3]);
  });

  it("キー表記の部分一致は空白と + を無視する", () => {
    expect(filterShortcuts(items, "ctrl+k", texts).map((x) => x.id)).toEqual([1, 3]);
    // 表記ゆれ: cmd+k / ⌘K / Command K / ctrl k はどれも Cmd/Ctrl+K に当たる。
    for (const q of ["cmd+k", "⌘K", "Command K", "ctrl k", "control+k"]) {
      expect(filterShortcuts([{ id: 9, label: "x", keys: "Cmd/Ctrl+K" }], q, (i) => i)).toHaveLength(1);
    }
    // Ctrl と Cmd は同じ主修飾キーとして扱う (一覧の表記は Cmd/Ctrl)。
    expect(filterShortcuts(items, "Ctrl K", texts).map((x) => x.id)).toEqual([1, 3]);
    expect(filterShortcuts(items, "shift f", texts).map((x) => x.id)).toEqual([2]);
    expect(filterShortcuts(items, "⌘k", texts).map((x) => x.id)).toEqual([1, 3]);
  });

  it("一致が無ければ空、記号だけのクエリはキー側に誤一致しない", () => {
    expect(filterShortcuts(items, "zzz", texts)).toEqual([]);
    expect(filterShortcuts(items, "+", texts).map((x) => x.id)).toEqual([]);
  });

  it("定義順を保つ", () => {
    expect(filterShortcuts(items, "k", texts).map((x) => x.id)).toEqual([1, 3]);
  });
});
