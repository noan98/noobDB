import { describe, it, expect } from "vitest";
import {
  accentWashOpacity,
  accentWashSpec,
  shouldFireAccentWash,
} from "../components/accentWash";

/**
 * 接続切替時のアクセント/環境ウォッシュ (#978) の純ロジック。発火判定
 * (接続 id が変化したときのみ) と、色/強度の決定 (安全網の識別性を弱めない
 * こと) を固定する。
 */
describe("shouldFireAccentWash", () => {
  it("does not fire when the key is unchanged (same-connection re-render)", () => {
    expect(shouldFireAccentWash("abc", "abc")).toBe(false);
    expect(shouldFireAccentWash(null, null)).toBe(false);
  });

  it("fires when switching to a different active connection", () => {
    expect(shouldFireAccentWash("abc", "def")).toBe(true);
    expect(shouldFireAccentWash(null, "abc")).toBe(true);
  });

  it("does not fire on disconnect (non-null to null)", () => {
    expect(shouldFireAccentWash("abc", null)).toBe(false);
  });
});

describe("accentWashOpacity", () => {
  it("is stronger for production connections (誤操作防止のため)", () => {
    const prod = accentWashOpacity({ name: "prod", color: null, isProduction: true });
    const normal = accentWashOpacity({ name: "dev", color: "#22c55e", isProduction: false });
    expect(prod).toBeGreaterThan(normal);
  });

  it("defaults to the normal opacity when there is no connection", () => {
    expect(accentWashOpacity(null)).toBe(accentWashOpacity(undefined));
  });
});

describe("accentWashSpec", () => {
  it("is null when there is no active connection (no wash to show)", () => {
    expect(accentWashSpec(null)).toBeNull();
    expect(accentWashSpec(undefined)).toBeNull();
  });

  it("uses the danger color for production, matching the title bar band (#791)", () => {
    const spec = accentWashSpec({ name: "prod", color: "#22c55e", isProduction: true });
    expect(spec?.color).toBe("var(--status-error)");
  });

  it("uses the sandbox color, preserving its identifiability (#747)", () => {
    const spec = accentWashSpec({
      name: "sbx",
      color: "#22c55e",
      isProduction: false,
      isSandbox: true,
    });
    expect(spec?.color).toBe("#8b5cf6");
  });

  it("uses the profile color for a normal connection", () => {
    const spec = accentWashSpec({ name: "dev", color: "#2563eb", isProduction: false });
    expect(spec?.color).toBe("#2563eb");
    expect(spec?.opacity).toBeLessThan(accentWashOpacity({ name: "p", color: null, isProduction: true }));
  });

  it("falls back to the workspace accent when no profile color is set", () => {
    const spec = accentWashSpec({ name: "dev", color: null, isProduction: false });
    expect(spec?.color).toBe("var(--ws-accent)");
  });
});
