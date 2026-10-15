import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, deserializeSettingsImport, serializeSettingsExport } from "../settings";
import { diffSettingsPaths } from "../settingsDiff";

describe("diffSettingsPaths (#1631)", () => {
  it("同じなら空", () => {
    expect(diffSettingsPaths({ a: 1, b: { c: [1, 2] } }, { a: 1, b: { c: [1, 2] } })).toEqual([]);
  });
  it("変わった項目をキー順に返し、オブジェクトは 1 段掘り下げる", () => {
    expect(
      diffSettingsPaths({ z: 1, a: "x", o: { p: 1, q: 2 } }, { z: 2, a: "x", o: { p: 1, q: 3 } }),
    ).toEqual(["o.q", "z"]);
  });
  it("配列の中身の違いと追加・削除されたキーを検出する", () => {
    expect(diffSettingsPaths({ l: [1], g: 1 }, { l: [1, 2], n: 1 })).toEqual(["g", "l", "n"]);
  });
  it("実際のエクスポート往復では差分が出ない", () => {
    const next = deserializeSettingsImport(serializeSettingsExport(DEFAULT_SETTINGS));
    expect(diffSettingsPaths(DEFAULT_SETTINGS, next)).toEqual([]);
  });
});
