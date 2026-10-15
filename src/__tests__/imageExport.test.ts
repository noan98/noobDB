import { describe, expect, it } from "vitest";
import { dataUrlToBytes, resolvePngExportOptions, themeBackground } from "../components/imageExport";
import { DEFAULT_IMAGE_EXPORT_PREFS, sanitizeImageExportPrefs } from "../components/imageExportPrefs";

describe("dataUrlToBytes", () => {
  it("base64 の data URL をデコードする", () => {
    // "PNG" の base64 は "UE5H"。
    const bytes = dataUrlToBytes("data:image/png;base64,UE5H");
    expect(Array.from(bytes)).toEqual([0x50, 0x4e, 0x47]);
  });

  it("URI エンコードされた SVG data URL をデコードする", () => {
    const svg = "<svg><rect/></svg>";
    const url = "data:image/svg+xml," + encodeURIComponent(svg);
    const bytes = dataUrlToBytes(url);
    expect(new TextDecoder().decode(bytes)).toBe(svg);
  });

  it("マルチバイト文字を UTF-8 として往復できる", () => {
    const svg = "<text>表</text>";
    const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    const bytes = dataUrlToBytes(url);
    expect(new TextDecoder().decode(bytes)).toBe(svg);
  });

  it("不正な data URL は例外", () => {
    expect(() => dataUrlToBytes("not-a-data-url")).toThrow();
  });
});

describe("resolvePngExportOptions / imageExportPrefs (#1628)", () => {
  it("倍率はそのままピクセル比になり、背景は白・透過・テーマで解決される", () => {
    expect(resolvePngExportOptions(3, "white")).toEqual({ pixelRatio: 3, background: "#ffffff" });
    expect(resolvePngExportOptions(1, "transparent")).toEqual({ pixelRatio: 1, background: "transparent" });
    expect(resolvePngExportOptions(2, "theme").pixelRatio).toBe(2);
    expect(resolvePngExportOptions(2, "theme").background).toBe(themeBackground());
  });
  it("保存値の検証: 未知の値・壊れた値は既定 (2x・テーマ) に倒す", () => {
    expect(sanitizeImageExportPrefs({ scale: 3, background: "white" })).toEqual({
      scale: 3,
      background: "white",
    });
    expect(sanitizeImageExportPrefs({ scale: 7, background: "pink" })).toEqual(DEFAULT_IMAGE_EXPORT_PREFS);
    expect(sanitizeImageExportPrefs(null)).toEqual(DEFAULT_IMAGE_EXPORT_PREFS);
    expect(sanitizeImageExportPrefs("x")).toEqual(DEFAULT_IMAGE_EXPORT_PREFS);
  });
});
