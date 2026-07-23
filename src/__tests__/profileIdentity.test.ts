import { describe, it, expect } from "vitest";
import {
  chipForeground,
  groupAvatarColor,
  groupAvatarForeground,
  groupInitials,
  normalizeChipColor,
  profileBadgeKinds,
  workspaceSpineColor,
} from "../profileIdentity";
import { CATEGORICAL } from "../colorScale";
import { ACCENT_FG_DARK, ACCENT_FG_LIGHT } from "../accent";

// 接続プロファイルのビジュアルアイデンティティ (#663) の純ロジック検証。
// ConnectionList / TitleBar / 本番接続確認ダイアログが共有する色/イニシャル
// 決定ロジックの境界ケースをここで固定する。

describe("profileBadgeKinds (#663)", () => {
  it("returns no badges when neither flag is set", () => {
    expect(profileBadgeKinds({ is_production: false, read_only: false })).toEqual([]);
  });

  it("returns production first, then readOnly, when both are set", () => {
    expect(profileBadgeKinds({ is_production: true, read_only: true })).toEqual([
      "production",
      "readOnly",
    ]);
  });

  it("returns just the one flag that is set", () => {
    expect(profileBadgeKinds({ is_production: true, read_only: false })).toEqual(["production"]);
    expect(profileBadgeKinds({ is_production: false, read_only: true })).toEqual(["readOnly"]);
  });
});

describe("normalizeChipColor (#663)", () => {
  it("passes through a normal hex color", () => {
    expect(normalizeChipColor("#22c55e")).toBe("#22c55e");
  });

  it("treats null/undefined/empty/whitespace-only as unset", () => {
    expect(normalizeChipColor(null)).toBeNull();
    expect(normalizeChipColor(undefined)).toBeNull();
    expect(normalizeChipColor("")).toBeNull();
    expect(normalizeChipColor("   ")).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeChipColor("  #123456  ")).toBe("#123456");
  });
});

describe("chipForeground (#663)", () => {
  it("picks the light foreground for a dark color", () => {
    expect(chipForeground("#0a2540")).toBe(ACCENT_FG_LIGHT);
  });

  it("picks the dark foreground for a light color", () => {
    expect(chipForeground("#fef3c7")).toBe(ACCENT_FG_DARK);
  });

  it("returns null for unset/invalid colors", () => {
    expect(chipForeground(null)).toBeNull();
    expect(chipForeground(undefined)).toBeNull();
    expect(chipForeground("")).toBeNull();
    expect(chipForeground("not-a-color")).toBeNull();
  });
});

describe("groupInitials (#663)", () => {
  it("returns empty string for empty/whitespace-only input", () => {
    expect(groupInitials("")).toBe("");
    expect(groupInitials("   ")).toBe("");
  });

  it("returns the single character as-is (uppercased) for a 1-char name", () => {
    expect(groupInitials("a")).toBe("A");
  });

  it("takes the first two codepoints of a single word, uppercased", () => {
    expect(groupInitials("production")).toBe("PR");
  });

  it("takes the first letter of the first two words for multi-word names", () => {
    expect(groupInitials("Prod Team")).toBe("PT");
    // 3 語以上でも先頭 2 語だけを使う。
    expect(groupInitials("Prod Team Extra")).toBe("PT");
  });

  it("handles Japanese group names (single word: first two chars)", () => {
    expect(groupInitials("本番環境")).toBe("本番");
  });

  it("handles Japanese multi-word group names (space-separated)", () => {
    expect(groupInitials("本番 チーム")).toBe("本チ");
  });

  it("does not split a surrogate-pair emoji in half", () => {
    // 🚀 は UTF-16 のサロゲートペア。Array.from はこれを 1 コードポイントとして扱う。
    expect(groupInitials("🚀")).toBe("🚀");
    expect(groupInitials("🚀Ops")).toBe("🚀O");
  });

  it("collapses repeated internal whitespace between words", () => {
    expect(groupInitials("Prod    Team")).toBe("PT");
  });
});

describe("groupAvatarColor / groupAvatarForeground (#663)", () => {
  it("is stable for the same name", () => {
    expect(groupAvatarColor("Production")).toBe(groupAvatarColor("Production"));
  });

  it("returns a color from the shared categorical palette", () => {
    expect(CATEGORICAL).toContain(groupAvatarColor("Production"));
    expect(CATEGORICAL).toContain(groupAvatarColor("Staging"));
  });

  it("differentiates at least some distinct names (not a constant function)", () => {
    const names = ["Production", "Staging", "QA", "Analytics", "Ops", "Dev"];
    const colors = new Set(names.map(groupAvatarColor));
    expect(colors.size).toBeGreaterThan(1);
  });

  it("handles the empty string without throwing", () => {
    expect(() => groupAvatarColor("")).not.toThrow();
    expect(CATEGORICAL).toContain(groupAvatarColor(""));
  });

  it("returns a valid AA-contrast foreground for its own background", () => {
    const fg = groupAvatarForeground("Production");
    expect([ACCENT_FG_LIGHT, ACCENT_FG_DARK]).toContain(fg);
  });
});

describe("workspaceSpineColor (#791)", () => {
  it("returns transparent when there is no active connection", () => {
    expect(workspaceSpineColor(null)).toBe("transparent");
  });

  it("falls back to the workspace accent when color is unset", () => {
    expect(workspaceSpineColor({ is_production: false, color: null })).toBe(
      "var(--ws-accent, var(--accent))",
    );
    expect(workspaceSpineColor({ is_production: false })).toBe("var(--ws-accent, var(--accent))");
    expect(workspaceSpineColor({ is_production: false, color: "   " })).toBe(
      "var(--ws-accent, var(--accent))",
    );
  });

  it("uses the profile's custom color when set", () => {
    expect(workspaceSpineColor({ is_production: false, color: "#22c55e" })).toBe("#22c55e");
  });

  it("always uses the danger token for production, overriding any custom color", () => {
    expect(workspaceSpineColor({ is_production: true, color: "#22c55e" })).toBe(
      "var(--status-error)",
    );
    expect(workspaceSpineColor({ is_production: true, color: null })).toBe("var(--status-error)");
  });
});
