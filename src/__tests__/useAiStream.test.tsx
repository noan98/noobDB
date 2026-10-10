import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, renderWithProviders, screen } from "./testUtils";
import type { AiDoneEvent, AiStreamHandlers as WireHandlers } from "../api/tauri";

const runAiRequest = vi.fn();
const cancelStream = vi.fn().mockResolvedValue({ cancelled: true, deliveredRows: 0 });
const unlisten = vi.fn();
let wire: WireHandlers | null = null;
let streamIds: string[] = [];
// 購読の確立を遅らせたいテスト用。解決関数を取り出して任意のタイミングで進める。
let subscribeGate: Promise<void> | null = null;

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    listenAiStream: vi.fn(async (id: string, h: WireHandlers) => {
      streamIds.push(id);
      await (subscribeGate ?? Promise.resolve());
      wire = h;
      return unlisten;
    }),
    api: {
      ...actual.api,
      runAiRequest: (...a: unknown[]) => runAiRequest(...a),
      cancelStream: (...a: unknown[]) => cancelStream(...a),
    },
  };
});

import { useAiStream, type AiStreamRequest } from "../ai/useAiStream";
import { AiStreamProgress } from "../components/AiStreamProgress";
import { DEFAULT_SETTINGS } from "../settings";
import { toAiSnapshot } from "../ai/aiSettings";

const request: AiStreamRequest = {
  task: "generic",
  prompt: "p",
  settings: toAiSnapshot(DEFAULT_SETTINGS.ai),
};

const doneEvent: AiDoneEvent = {
  streamId: "x",
  model: "m-actual",
  requestedModel: "m-req",
  fallbackUsed: true,
  stopReason: "end_turn",
  usage: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 5, cacheCreationInputTokens: 1 },
};

function handlers() {
  return {
    onDone: vi.fn(),
    onError: vi.fn(),
    onCancelled: vi.fn(),
  };
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  runAiRequest.mockResolvedValue(undefined);
  wire = null;
  streamIds = [];
  subscribeGate = null;
});

describe("useAiStream (#1470)", () => {
  it("リクエスト引数にストリーム ID を足して run_ai_request へ渡し、delta を text に貯める", async () => {
    const { result } = renderHook(() => useAiStream({ idPrefix: "t" }));
    const h = handlers();
    expect(result.current.acquire()).toBe(true);
    await act(async () => {
      await result.current.start({ ...request, system: "sys" }, h);
    });
    expect(runAiRequest).toHaveBeenCalledTimes(1);
    const arg = runAiRequest.mock.calls[0][0];
    expect(arg.streamId).toMatch(/^t_/);
    expect(arg.system).toBe("sys");
    expect(arg.prompt).toBe("p");
    expect(result.current.running).toBe(true);
    act(() => wire?.onDelta?.({ streamId: "x", text: "ab" }));
    act(() => wire?.onDelta?.({ streamId: "x", text: "cd" }));
    expect(result.current.text).toBe("abcd");
  });

  it("完了: 本文をパースして渡し、完了イベント (モデル・使用量) をそのまま保持する", async () => {
    const { result } = renderHook(() => useAiStream({ idPrefix: "t" }));
    const h = { ...handlers(), parse: (s: string) => s.toUpperCase() };
    result.current.acquire();
    await act(async () => {
      await result.current.start(request, h);
    });
    act(() => {
      wire?.onDelta?.({ streamId: "x", text: "hi" });
      wire?.onDone?.(doneEvent);
    });
    expect(h.onDone).toHaveBeenCalledWith({ text: "hi", parsed: "HI", event: doneEvent });
    expect(result.current.running).toBe(false);
    expect(result.current.done).toEqual(doneEvent);
    expect(unlisten).toHaveBeenCalled();
    // 実行権が戻っているので次の要求を受け付ける。
    expect(result.current.acquire()).toBe(true);
  });

  it("エラー / 拒否 (aiRefused) / 中止を区別して通知する", async () => {
    const { result } = renderHook(() => useAiStream({ idPrefix: "t" }));
    const h1 = handlers();
    result.current.acquire();
    await act(async () => {
      await result.current.start(request, h1);
    });
    act(() => wire?.onError?.({ streamId: "x", error: "boom", kind: "aiApi" }));
    expect(h1.onError).toHaveBeenCalledWith({ message: "boom", kind: "aiApi", refused: false });

    const h2 = handlers();
    result.current.acquire();
    await act(async () => {
      await result.current.start(request, h2);
    });
    act(() => wire?.onError?.({ streamId: "x", error: "no", kind: "aiRefused" }));
    expect(h2.onError).toHaveBeenCalledWith({ message: "no", kind: "aiRefused", refused: true });

    const h3 = handlers();
    result.current.acquire();
    await act(async () => {
      await result.current.start(request, h3);
    });
    act(() => wire?.onCancelled?.({ streamId: "x", deliveredRows: 0 } as never));
    expect(h3.onCancelled).toHaveBeenCalledTimes(1);
    expect(h3.onDone).not.toHaveBeenCalled();
  });

  it("run_ai_request 自体が失敗したら onError (kind: invoke) で通知し、購読を外して実行権を戻す", async () => {
    runAiRequest.mockRejectedValueOnce(new Error("ipc down"));
    const { result } = renderHook(() => useAiStream({ idPrefix: "t" }));
    const h = handlers();
    result.current.acquire();
    await act(async () => {
      await result.current.start(request, h);
    });
    expect(h.onError).toHaveBeenCalledWith({ message: "Error: ipc down", kind: "invoke", refused: false });
    expect(unlisten).toHaveBeenCalled();
    expect(result.current.running).toBe(false);
    expect(result.current.acquire()).toBe(true);
  });

  it("二重実行は acquire が弾き、release で戻る", () => {
    const { result } = renderHook(() => useAiStream({ idPrefix: "t" }));
    expect(result.current.acquire()).toBe(true);
    expect(result.current.acquire()).toBe(false);
    result.current.release();
    expect(result.current.acquire()).toBe(true);
  });

  it("実行中の中止は cancel_stream を呼ぶ", async () => {
    const { result } = renderHook(() => useAiStream({ idPrefix: "t" }));
    result.current.acquire();
    await act(async () => {
      await result.current.start(request, handlers());
    });
    const id = runAiRequest.mock.calls[0][0].streamId;
    act(() => result.current.cancel());
    expect(cancelStream).toHaveBeenCalledWith(id);
  });

  it("登録前の中止 (購読の確立待ち): 要求を送らず、購読を外して onCancelled を呼ぶ", async () => {
    let open: () => void = () => {};
    subscribeGate = new Promise<void>((r) => {
      open = r;
    });
    const { result } = renderHook(() => useAiStream({ idPrefix: "t" }));
    const h = handlers();
    result.current.acquire();
    let p: Promise<void> = Promise.resolve();
    act(() => {
      p = result.current.start(request, h);
    });
    act(() => result.current.cancel());
    await act(async () => {
      open();
      await p;
    });
    expect(runAiRequest).not.toHaveBeenCalled();
    expect(unlisten).toHaveBeenCalled();
    expect(h.onCancelled).toHaveBeenCalledTimes(1);
    expect(result.current.running).toBe(false);
    expect(result.current.acquire()).toBe(true);
  });

  it("登録前の中止 (run_ai_request の応答待ち): 登録が済んだ後に cancel_stream を取り直す", async () => {
    let finish: () => void = () => {};
    runAiRequest.mockReturnValueOnce(
      new Promise<void>((r) => {
        finish = r;
      }),
    );
    const { result } = renderHook(() => useAiStream({ idPrefix: "t" }));
    result.current.acquire();
    let p: Promise<void> = Promise.resolve();
    await act(async () => {
      p = result.current.start(request, handlers());
    });
    const id = runAiRequest.mock.calls[0][0].streamId;
    act(() => result.current.cancel());
    // cancel 自体の空振り分
    cancelStream.mockClear();
    await act(async () => {
      finish();
      await p;
    });
    expect(cancelStream).toHaveBeenCalledWith(id);
  });

  it("アンマウント: 実行中なら cancel_stream と購読解除をする", async () => {
    const { result, unmount } = renderHook(() => useAiStream({ idPrefix: "t" }));
    const h = handlers();
    result.current.acquire();
    await act(async () => {
      await result.current.start(request, h);
    });
    const id = runAiRequest.mock.calls[0][0].streamId;
    unmount();
    expect(cancelStream).toHaveBeenCalledWith(id);
    expect(unlisten).toHaveBeenCalled();
    expect(h.onDone).not.toHaveBeenCalled();
  });

  it("アンマウント: 購読の確立待ち中なら、確立後に購読を外して要求を送らない", async () => {
    let open: () => void = () => {};
    subscribeGate = new Promise<void>((r) => {
      open = r;
    });
    const { result, unmount } = renderHook(() => useAiStream({ idPrefix: "t" }));
    const h = handlers();
    result.current.acquire();
    let p: Promise<void> = Promise.resolve();
    act(() => {
      p = result.current.start(request, h);
    });
    unmount();
    await act(async () => {
      open();
      await p;
    });
    expect(unlisten).toHaveBeenCalled();
    expect(runAiRequest).not.toHaveBeenCalled();
    expect(h.onCancelled).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
  });

  it("reset: 購読を外して結果を捨て、以後ハンドラは呼ばれず実行権が戻る", async () => {
    const { result } = renderHook(() => useAiStream({ idPrefix: "t" }));
    const h = handlers();
    result.current.acquire();
    await act(async () => {
      await result.current.start(request, h);
    });
    const handlersAtStart = wire;
    act(() => result.current.reset());
    expect(unlisten).toHaveBeenCalled();
    expect(result.current.running).toBe(false);
    // 解除前に届いた古いイベントが来ても無視する。
    act(() => handlersAtStart?.onDone?.(doneEvent));
    expect(h.onDone).not.toHaveBeenCalled();
    expect(result.current.acquire()).toBe(true);
  });

  it("受信中は経過秒数が進み、完了すると止まる", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useAiStream({ idPrefix: "t" }));
    result.current.acquire();
    await act(async () => {
      await result.current.start(request, handlers());
    });
    expect(result.current.elapsedSec).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(result.current.elapsedSec).toBe(3);
    act(() => wire?.onDone?.(doneEvent));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(result.current.elapsedSec).toBe(3);
  });
});

describe("AiStreamProgress (#1470)", () => {
  it("応答開始前は待機文言と経過秒数、届いたら「受信中」と文字数、構造化出力は指定フィールドだけ見せる", () => {
    const { rerender } = renderWithProviders(<AiStreamProgress stream={{ text: "", elapsedSec: 2 }} fields={["explanation"]} />);
    expect(screen.getByTestId("ai-stream-elapsed").textContent).toMatch(/2/);
    expect(screen.queryByTestId("ai-stream-preview")).toBeNull();
    rerender(
      <AiStreamProgress stream={{ text: '{"explanation":"途中の文章', elapsedSec: 5 }} fields={["explanation"]} />,
    );
    expect(screen.getByTestId("ai-stream-preview").textContent).toBe("途中の文章");
    expect(screen.getByTestId("ai-stream-elapsed").textContent).toMatch(/5/);
    rerender(<AiStreamProgress stream={{ text: '{"explanation":"x', elapsedSec: 5 }} previewText={false} />);
    expect(screen.queryByTestId("ai-stream-preview")).toBeNull();
  });
});
