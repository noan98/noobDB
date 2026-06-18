import { describe, expect, it } from "vitest";

import {
  clamp,
  fractionBounds,
  normalizeFraction,
  parseLayoutMode,
  toggleLayoutMode,
} from "../components/paneLayout";

// エディタ/結果スプリットペイン (#618) の純ロジック。Splitter の配分計算と
// App のレイアウトモード正規化/トグルが副作用なしで決まることを固定する。
describe("paneLayout", () => {
  describe("clamp", () => {
    it("範囲内はそのまま、範囲外は端に丸める", () => {
      expect(clamp(0.5, 0, 1)).toBe(0.5);
      expect(clamp(-1, 0, 1)).toBe(0);
      expect(clamp(2, 0, 1)).toBe(1);
    });
  });

  describe("fractionBounds", () => {
    it("両側に minSize を確保できる広さでは下限/上限を返す", () => {
      // total=1000, minSize=120 → minF=0.12, maxF=0.88
      expect(fractionBounds(1000, 120)).toEqual({ minF: 0.12, maxF: 0.88 });
    });

    it("両側に minSize を確保できない狭さでは 0..1 の全域を許可する", () => {
      expect(fractionBounds(200, 120)).toEqual({ minF: 0, maxF: 1 });
      // ちょうど境界 (total === 2*minSize) も全域扱い (> で判定)
      expect(fractionBounds(240, 120)).toEqual({ minF: 0, maxF: 1 });
    });

    it("total が非正でも全域を返し、0 除算を避ける", () => {
      expect(fractionBounds(0, 120)).toEqual({ minF: 0, maxF: 1 });
      expect(fractionBounds(-50, 120)).toEqual({ minF: 0, maxF: 1 });
    });
  });

  describe("normalizeFraction", () => {
    it("0 < f < 1 の有限数のみ採用する", () => {
      expect(normalizeFraction(0.4, 0.5)).toBe(0.4);
      expect(normalizeFraction("0.42", 0.5)).toBe(0.42);
    });

    it("範囲外/非数値/null は fallback を返す", () => {
      expect(normalizeFraction(0, 0.5)).toBe(0.5);
      expect(normalizeFraction(1, 0.5)).toBe(0.5);
      expect(normalizeFraction(1.5, 0.5)).toBe(0.5);
      expect(normalizeFraction(-0.2, 0.5)).toBe(0.5);
      expect(normalizeFraction(NaN, 0.5)).toBe(0.5);
      expect(normalizeFraction(null, 0.5)).toBe(0.5);
      expect(normalizeFraction("abc", 0.5)).toBe(0.5);
      expect(normalizeFraction("", 0.5)).toBe(0.5);
    });
  });

  describe("parseLayoutMode", () => {
    it("既知のモードはそのまま、未知値は normal", () => {
      expect(parseLayoutMode("result")).toBe("result");
      expect(parseLayoutMode("editor")).toBe("editor");
      expect(parseLayoutMode("normal")).toBe("normal");
      expect(parseLayoutMode(null)).toBe("normal");
      expect(parseLayoutMode("garbage")).toBe("normal");
      expect(parseLayoutMode(42)).toBe("normal");
    });
  });

  describe("toggleLayoutMode", () => {
    it("対象と同じならオフ (normal)、違えば対象へ切り替える", () => {
      expect(toggleLayoutMode("normal", "result")).toBe("result");
      expect(toggleLayoutMode("result", "result")).toBe("normal");
      // 別モードからは対象へ直接切り替わる (排他)
      expect(toggleLayoutMode("editor", "result")).toBe("result");
      expect(toggleLayoutMode("normal", "editor")).toBe("editor");
      expect(toggleLayoutMode("editor", "editor")).toBe("normal");
      expect(toggleLayoutMode("result", "editor")).toBe("editor");
    });
  });
});
