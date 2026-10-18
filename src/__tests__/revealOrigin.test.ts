import { beforeEach, describe, expect, it } from "vitest";
import {
  isHighContrastDataTheme,
  recordKey,
  recordPointer,
  resetRevealOrigin,
  resolveRevealOrigin,
  revealClipPath,
  revealRadius,
} from "../components/revealOrigin";

const vp = { width: 1280, height: 800 };

describe("revealOrigin (#1582)", () => {
  beforeEach(() => resetRevealOrigin());

  it("ポインタ操作が無ければ画面中央", () => {
    expect(resolveRevealOrigin(100, 1000, vp)).toEqual({ x: 640, y: 400 });
  });

  it("直近のポインタ座標を原点にする", () => {
    recordPointer({ x: 1200, y: 20 }, 100);
    expect(resolveRevealOrigin(600, 1000, vp)).toEqual({ x: 1200, y: 20 });
  });

  it("許容時間を過ぎたポインタ操作は無視して中央へ", () => {
    recordPointer({ x: 1200, y: 20 }, 100);
    expect(resolveRevealOrigin(1101, 1000, vp)).toEqual({ x: 640, y: 400 });
  });

  it("ポインタ操作より後のキー操作 (ショートカット等) では中央へ", () => {
    recordPointer({ x: 1200, y: 20 }, 100);
    recordKey(200);
    expect(resolveRevealOrigin(300, 1000, vp)).toEqual({ x: 640, y: 400 });
  });

  it("キー操作より後のポインタ操作は有効", () => {
    recordKey(50);
    recordPointer({ x: 10, y: 10 }, 100);
    expect(resolveRevealOrigin(200, 1000, vp)).toEqual({ x: 10, y: 10 });
  });

  it("半径は最も遠い角までの距離", () => {
    expect(revealRadius({ x: 0, y: 0 }, vp)).toBe(Math.ceil(Math.hypot(1280, 800)));
    expect(revealRadius({ x: 640, y: 400 }, vp)).toBe(Math.ceil(Math.hypot(640, 400)));
    expect(revealRadius({ x: 1280, y: 800 }, vp)).toBe(Math.ceil(Math.hypot(1280, 800)));
  });

  it("clip-path 文字列を組み立てる", () => {
    expect(revealClipPath({ x: 10.4, y: 20.6 }, 0)).toBe("circle(0px at 10px 21px)");
  });

  it("高コントラストテーマを判定する", () => {
    expect(isHighContrastDataTheme("hc-dark")).toBe(true);
    expect(isHighContrastDataTheme("hc-light")).toBe(true);
    expect(isHighContrastDataTheme("dark")).toBe(false);
    expect(isHighContrastDataTheme("cb-dark")).toBe(false);
  });
});
