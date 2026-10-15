// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  isVersionAtMost,
  loadSkippedUpdateVersion,
  saveSkippedUpdateVersion,
  shouldSkipStartupNotice,
} from "../updateSkip";

describe("update skip (#1631)", () => {
  beforeEach(() => localStorage.clear());

  it("バージョンを数値で比べる", () => {
    expect(isVersionAtMost("1.2.3", "1.2.3")).toBe(true);
    expect(isVersionAtMost("1.2.3", "1.10.0")).toBe(true);
    expect(isVersionAtMost("1.10.0", "1.2.3")).toBe(false);
    expect(isVersionAtMost("v1.2", "1.2.0")).toBe(true);
    expect(isVersionAtMost("1.2.4-beta.1", "1.2.3")).toBe(false);
  });
  it("プレリリースを含めて semver どおりに比べる", () => {
    // プレリリース (1.3.0-beta.1) を見送っても、正式版 1.3.0 は隠さない。
    expect(shouldSkipStartupNotice("1.3.0", "1.3.0-beta.1")).toBe(false);
    expect(shouldSkipStartupNotice("1.3.0-beta.2", "1.3.0-beta.1")).toBe(false);
    expect(shouldSkipStartupNotice("1.3.0-beta.1", "1.3.0-beta.1")).toBe(true);
    expect(shouldSkipStartupNotice("1.3.0-alpha.9", "1.3.0-beta.1")).toBe(true);
    // 正式版を見送ったら、同じ core のプレリリースは出さない。
    expect(shouldSkipStartupNotice("1.3.0-rc.1", "1.3.0")).toBe(true);
    expect(isVersionAtMost("1.0.0-alpha", "1.0.0-alpha.1")).toBe(true);
    expect(isVersionAtMost("1.0.0-alpha.1", "1.0.0-alpha.beta")).toBe(true);
    expect(isVersionAtMost("1.0.0-beta.11", "1.0.0-beta.2")).toBe(false);
    expect(isVersionAtMost("1.0.0+build5", "1.0.0")).toBe(true);
  });
  it("数値版でなければ完全一致だけ見送る", () => {
    expect(isVersionAtMost("nightly", "nightly")).toBe(true);
    expect(isVersionAtMost("nightly", "other")).toBe(false);
  });
  it("見送り済みの版と古い版は出さず、新しい版は出す", () => {
    expect(shouldSkipStartupNotice("1.3.0", "1.3.0")).toBe(true);
    expect(shouldSkipStartupNotice("1.2.0", "1.3.0")).toBe(true);
    expect(shouldSkipStartupNotice("1.3.1", "1.3.0")).toBe(false);
    expect(shouldSkipStartupNotice("1.3.0", null)).toBe(false);
  });
  it("保存と読み戻し", () => {
    expect(loadSkippedUpdateVersion()).toBeNull();
    saveSkippedUpdateVersion("1.3.0");
    expect(loadSkippedUpdateVersion()).toBe("1.3.0");
  });
});
