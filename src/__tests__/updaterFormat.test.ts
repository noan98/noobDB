import { describe, expect, it } from "vitest";
import {
  displayVersion,
  downloadProgressPercent,
  truncateReleaseNotes,
} from "../updaterFormat";

describe("downloadProgressPercent (#705)", () => {
  it("computes a rounded percentage", () => {
    expect(downloadProgressPercent(50, 100)).toBe(50);
    expect(downloadProgressPercent(1, 3)).toBe(33);
  });

  it("returns null when the total size is unknown", () => {
    expect(downloadProgressPercent(10, undefined)).toBeNull();
    expect(downloadProgressPercent(10, 0)).toBeNull();
    expect(downloadProgressPercent(10, -5)).toBeNull();
    expect(downloadProgressPercent(10, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("clamps to the 0..100 range", () => {
    expect(downloadProgressPercent(-5, 100)).toBe(0);
    expect(downloadProgressPercent(0, 100)).toBe(0);
    expect(downloadProgressPercent(200, 100)).toBe(100);
  });

  it("treats a non-finite downloaded count as zero progress", () => {
    expect(downloadProgressPercent(Number.NaN, 100)).toBe(0);
    expect(downloadProgressPercent(Number.POSITIVE_INFINITY, 100)).toBe(0);
  });
});

describe("truncateReleaseNotes (#705)", () => {
  it("returns an empty string for missing notes", () => {
    expect(truncateReleaseNotes(undefined)).toBe("");
    expect(truncateReleaseNotes("")).toBe("");
    expect(truncateReleaseNotes("   ")).toBe("");
  });

  it("trims surrounding whitespace", () => {
    expect(truncateReleaseNotes("  hello  ")).toBe("hello");
  });

  it("passes short notes through unchanged", () => {
    expect(truncateReleaseNotes("fixed a bug", 600)).toBe("fixed a bug");
  });

  it("truncates long notes with an ellipsis", () => {
    const body = "x".repeat(1000);
    const out = truncateReleaseNotes(body, 600);
    expect(out).toHaveLength(601); // 600 chars + ellipsis
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("displayVersion (#705)", () => {
  it("strips a leading v and trims", () => {
    expect(displayVersion("v1.2.3")).toBe("1.2.3");
    expect(displayVersion(" V0.1.0 ")).toBe("0.1.0");
    expect(displayVersion("2.0.0")).toBe("2.0.0");
  });

  it("falls back to a placeholder for empty/missing values", () => {
    expect(displayVersion(null)).toBe("?");
    expect(displayVersion(undefined)).toBe("?");
    expect(displayVersion("")).toBe("?");
    expect(displayVersion("   ")).toBe("?");
  });
});
