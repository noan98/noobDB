import { describe, expect, it } from "vitest";
import { dataUrlToBytes } from "../components/imageExport";

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
