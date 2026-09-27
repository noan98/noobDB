// 「コピー → 1500ms だけ確認表示 → 自動で戻る」を管理する共通フック (#1158) の
// タイマー遷移・unmount cleanup・失敗時トーストを固定する。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { ChakraProvider } from "@chakra-ui/react";
import type { ReactNode } from "react";
import { t } from "../i18n";
import { system } from "../theme";
import { ToastProvider, useToast } from "../components/Toast";

vi.mock("../components/clipboard", () => ({
  copyToClipboard: vi.fn(),
}));

import { copyToClipboard } from "../components/clipboard";
import { useCopyFeedback, useKeyedCopyFeedback, COPY_FEEDBACK_DURATION_MS } from "../components/useCopyFeedback";

const copyToClipboardMock = vi.mocked(copyToClipboard);

function wrapper({ children }: { children: ReactNode }) {
  return (
    <ChakraProvider value={system}>
      <ToastProvider>{children}</ToastProvider>
    </ChakraProvider>
  );
}

describe("useCopyFeedback", () => {
  beforeEach(() => {
    copyToClipboardMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("コピー成功で copied が true になり、1500ms 後に自動で false へ戻る", async () => {
    copyToClipboardMock.mockResolvedValue(true);
    const { result } = renderHook(() => useCopyFeedback(), { wrapper });

    expect(result.current.copied).toBe(false);

    await act(async () => {
      await result.current.copy("hello");
    });
    expect(result.current.copied).toBe(true);
    expect(copyToClipboardMock).toHaveBeenCalledWith("hello");

    act(() => {
      vi.advanceTimersByTime(COPY_FEEDBACK_DURATION_MS - 1);
    });
    expect(result.current.copied).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.copied).toBe(false);
  });

  it("連続コピーはタイマーを延長する (最初のタイマーで消えない)", async () => {
    copyToClipboardMock.mockResolvedValue(true);
    const { result } = renderHook(() => useCopyFeedback(), { wrapper });

    await act(async () => {
      await result.current.copy("first");
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    await act(async () => {
      await result.current.copy("second");
    });
    // 2 回目のコピーから 1000ms しか経っていないので、1 回目のタイマー (合計
    // 1500ms 時点) では消えず、コピー確認は表示され続ける。
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.copied).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.copied).toBe(false);
  });

  it("失敗時はトーストを出し、copied は変化しない", async () => {
    copyToClipboardMock.mockResolvedValue(false);
    const { result } = renderHook(
      () => ({ copyFeedback: useCopyFeedback(), toast: useToast() }),
      { wrapper },
    );
    const errorSpy = vi.spyOn(result.current.toast, "error");

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.copyFeedback.copy("nope");
    });
    expect(ok).toBe(false);
    expect(result.current.copyFeedback.copied).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(t("clipboardCopyFailed"));
  });

  it("unmount 後にタイマーが発火しても setState しない (クリーンアップ済み)", async () => {
    copyToClipboardMock.mockResolvedValue(true);
    const { result, unmount } = renderHook(() => useCopyFeedback(), { wrapper });

    await act(async () => {
      await result.current.copy("hello");
    });
    expect(result.current.copied).toBe(true);

    // unmount 後にタイマーを進めても React の act 警告 (unmount 後の setState)
    // が出ないこと。cleanup effect がタイマーを止めていなければここで警告が飛ぶ。
    unmount();
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(COPY_FEEDBACK_DURATION_MS);
      });
    }).not.toThrow();
  });
});

describe("useKeyedCopyFeedback", () => {
  beforeEach(() => {
    copyToClipboardMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("キーごとに copiedKey を切り替え、1500ms 後に null へ戻る", async () => {
    copyToClipboardMock.mockResolvedValue(true);
    const { result } = renderHook(() => useKeyedCopyFeedback<number>(), { wrapper });

    expect(result.current.copiedKey).toBeNull();

    await act(async () => {
      await result.current.copy(1, "row-1-sql");
    });
    expect(result.current.copiedKey).toBe(1);

    await act(async () => {
      await result.current.copy(2, "row-2-sql");
    });
    // 直近にコピーした行だけが確認表示になる (同時に複数行は光らない)。
    expect(result.current.copiedKey).toBe(2);

    act(() => {
      vi.advanceTimersByTime(COPY_FEEDBACK_DURATION_MS);
    });
    expect(result.current.copiedKey).toBeNull();
  });

  it("失敗時は copiedKey を変更せずトーストを出す", async () => {
    copyToClipboardMock.mockResolvedValue(false);
    const { result } = renderHook(
      () => ({ copyFeedback: useKeyedCopyFeedback<number>(), toast: useToast() }),
      { wrapper },
    );
    const errorSpy = vi.spyOn(result.current.toast, "error");

    await act(async () => {
      await result.current.copyFeedback.copy(1, "row-1-sql");
    });
    expect(result.current.copyFeedback.copiedKey).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(t("clipboardCopyFailed"));
  });

  it("unmount 後にタイマーが発火しても setState しない", async () => {
    copyToClipboardMock.mockResolvedValue(true);
    const { result, unmount } = renderHook(() => useKeyedCopyFeedback<number>(), { wrapper });

    await act(async () => {
      await result.current.copy(1, "row-1-sql");
    });
    unmount();
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(COPY_FEEDBACK_DURATION_MS);
      });
    }).not.toThrow();
  });
});
