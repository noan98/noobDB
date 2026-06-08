import { beforeEach, describe, expect, it, vi } from "vitest";
import { copyToClipboard } from "../components/clipboard";

// jsdom では document.execCommand が未定義のため、テスト前に stub として定義する。
function stubExecCommand(returnValue: boolean | (() => never)) {
  if (typeof returnValue === "function") {
    document.execCommand = returnValue as unknown as typeof document.execCommand;
  } else {
    document.execCommand = vi.fn().mockReturnValue(returnValue) as unknown as typeof document.execCommand;
  }
}

describe("copyToClipboard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true when navigator.clipboard succeeds", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const result = await copyToClipboard("hello");
    expect(result).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to execCommand when navigator.clipboard rejects", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("no permission")) },
      configurable: true,
    });
    stubExecCommand(true);
    const result = await copyToClipboard("world");
    expect(result).toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });

  it("returns false when execCommand returns false", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("no permission")) },
      configurable: true,
    });
    stubExecCommand(false);
    const result = await copyToClipboard("test");
    expect(result).toBe(false);
  });

  it("returns false when execCommand throws", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("no permission")) },
      configurable: true,
    });
    stubExecCommand(() => {
      throw new Error("execCommand not supported");
    });
    const result = await copyToClipboard("test");
    expect(result).toBe(false);
  });
});
