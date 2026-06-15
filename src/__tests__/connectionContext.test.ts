import { describe, it, expect } from "vitest";
import { connectionBandColor } from "../components/titleBarContext";

/**
 * アクティブ接続コンテキストの常時可視化。タイトルバーの帯色ロジックが、
 * 本番接続を危険色で最優先し、通常接続はプロファイル色、未接続は透明にすることを
 * 固定する。
 */
describe("connectionBandColor (#466)", () => {
  it("is transparent when not connected", () => {
    expect(connectionBandColor(null)).toBe("transparent");
    expect(connectionBandColor(undefined)).toBe("transparent");
  });

  it("uses the profile color for a normal connection", () => {
    expect(
      connectionBandColor({ name: "dev", color: "#22c55e", isProduction: false }),
    ).toBe("#22c55e");
  });

  it("falls back to the workspace accent when no profile color is set", () => {
    expect(
      connectionBandColor({ name: "dev", color: null, isProduction: false }),
    ).toBe("var(--ws-accent)");
  });

  it("always uses the danger color for production, even with a custom color", () => {
    expect(
      connectionBandColor({ name: "prod", color: "#22c55e", isProduction: true }),
    ).toBe("var(--status-error)");
  });

  it("uses the warning color while reconnecting, overriding production (#600)", () => {
    expect(
      connectionBandColor({ name: "dev", color: "#22c55e", isProduction: false, status: "reconnecting" }),
    ).toBe("var(--status-warning)");
    // 再接続中は本番の危険色より優先して状態を伝える。
    expect(
      connectionBandColor({ name: "prod", color: null, isProduction: true, status: "reconnecting" }),
    ).toBe("var(--status-warning)");
  });

  it("treats connected / disconnected status like the status-less cases", () => {
    expect(
      connectionBandColor({ name: "dev", color: "#22c55e", isProduction: false, status: "connected" }),
    ).toBe("#22c55e");
    expect(
      connectionBandColor({ name: "prod", color: null, isProduction: true, status: "disconnected" }),
    ).toBe("var(--status-error)");
  });
});
