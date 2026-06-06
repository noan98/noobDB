import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyToClipboard } from "../components/clipboard";

// navigator.clipboard は jsdom で部分的にしか実装されていないため、
// 各テストで Object.defineProperty で差し替えてモックする。
// document.execCommand も jsdom では未定義のため、同様に定義してモックする。

function mockClipboardWriteText(impl: () => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockImplementation(impl) },
    configurable: true,
  });
}

function mockExecCommand(impl: () => boolean) {
  Object.defineProperty(document, "execCommand", {
    value: vi.fn().mockImplementation(impl),
    configurable: true,
    writable: true,
  });
}

describe("copyToClipboard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    // execCommand のモックを元に戻す
    Object.defineProperty(document, "execCommand", {
      value: undefined,
      configurable: true,
      writable: true,
    });
  });

  it("navigator.clipboard.writeText が成功すると true を返す", async () => {
    mockClipboardWriteText(() => Promise.resolve());

    const result = await copyToClipboard("hello");

    expect(result).toBe(true);
    expect((navigator.clipboard as { writeText: ReturnType<typeof vi.fn> }).writeText)
      .toHaveBeenCalledWith("hello");
  });

  it("navigator.clipboard が失敗したとき execCommand でフォールバックし true を返す", async () => {
    mockClipboardWriteText(() => Promise.reject(new Error("not allowed")));
    mockExecCommand(() => true);

    const result = await copyToClipboard("fallback");

    expect(result).toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });

  it("両方の手段が失敗すると false を返す (execCommand が false を返す場合)", async () => {
    mockClipboardWriteText(() => Promise.reject(new Error("not allowed")));
    mockExecCommand(() => false);

    const result = await copyToClipboard("fail");

    expect(result).toBe(false);
  });

  it("execCommand が例外を投げても false を返す", async () => {
    mockClipboardWriteText(() => Promise.reject(new Error("not allowed")));
    mockExecCommand(() => {
      throw new Error("not supported");
    });

    const result = await copyToClipboard("fail");

    expect(result).toBe(false);
  });
});
