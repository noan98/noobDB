import { beforeEach, describe, expect, it, vi } from "vitest";

// AI ストリーム (`run_ai_request`, #1534) の Channel 振り分け。Tauri の Channel / invoke を
// モックし、(1) `kind` ごとにハンドラへ渡る (error は errorKind → kind に読み替え)、
// (2) listen 前の runAiRequest は同期 throw ではなく reject になる、を固定する。
const { FakeChannel } = vi.hoisted(() => ({
  FakeChannel: class {
    onmessage: (msg: unknown) => void = () => {};
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: FakeChannel }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { api, listenAiStream } from "../api/tauri";

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(undefined);
});

const request = {
  streamId: "ai1",
  task: "sqlGenerate",
  prompt: "p",
  settings: {},
} as unknown as Parameters<typeof api.runAiRequest>[0];

describe("runAiRequest / listenAiStream", () => {
  it("listenAiStream より前に呼ぶと同期 throw ではなく reject になる", async () => {
    let promise: Promise<void> | undefined;
    expect(() => {
      promise = api.runAiRequest({ ...request, streamId: "never-listened" });
    }).not.toThrow();
    await expect(promise).rejects.toThrow(/listenAiStream/);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("listen した Channel を onEvent として run_ai_request へ渡す", async () => {
    await listenAiStream("ai1", {});
    await api.runAiRequest(request);
    const [cmd, args] = mockInvoke.mock.calls[0] as [string, Record<string, unknown>];
    expect(cmd).toBe("run_ai_request");
    expect(args.onEvent).toBeInstanceOf(FakeChannel);
  });

  it("kind ごとにハンドラへ振り分け、error は errorKind を kind に読み替え、未知の kind は無視する", async () => {
    const handlers = {
      onDelta: vi.fn(),
      onRetrying: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      onCancelled: vi.fn(),
    };
    await listenAiStream("ai2", handlers);
    await api.runAiRequest({ ...request, streamId: "ai2" });
    const channel = (mockInvoke.mock.calls[0][1] as { onEvent: InstanceType<typeof FakeChannel> })
      .onEvent;

    channel.onmessage({ kind: "delta", text: "hi" });
    expect(handlers.onDelta).toHaveBeenCalledWith({ streamId: "ai2", text: "hi" });

    channel.onmessage({ kind: "retrying", attempt: 1, maxAttempts: 3, delayMs: 500 });
    expect(handlers.onRetrying).toHaveBeenCalledWith({
      streamId: "ai2",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 500,
    });

    const usage = {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
    channel.onmessage({
      kind: "done",
      model: "m",
      requestedModel: "m0",
      fallbackUsed: true,
      stopReason: "end_turn",
      usage,
    });
    expect(handlers.onDone).toHaveBeenCalledWith({
      streamId: "ai2",
      model: "m",
      requestedModel: "m0",
      fallbackUsed: true,
      stopReason: "end_turn",
      usage,
    });

    channel.onmessage({ kind: "error", error: "busy", errorKind: "aiOverloaded" });
    expect(handlers.onError).toHaveBeenCalledWith({
      streamId: "ai2",
      error: "busy",
      kind: "aiOverloaded",
    });

    channel.onmessage({ kind: "cancelled", deliveredRows: 7 });
    expect(handlers.onCancelled).toHaveBeenCalledWith({ streamId: "ai2", deliveredRows: 7 });

    channel.onmessage({ kind: "future-kind" });
    expect(handlers.onDelta).toHaveBeenCalledTimes(1);
  });

  it("unlisten 後はメッセージを無視し、再度 run すると reject する", async () => {
    const onDelta = vi.fn();
    const unlisten = await listenAiStream("ai3", { onDelta });
    await api.runAiRequest({ ...request, streamId: "ai3" });
    const channel = (mockInvoke.mock.calls[0][1] as { onEvent: InstanceType<typeof FakeChannel> })
      .onEvent;
    unlisten();
    channel.onmessage({ kind: "delta", text: "late" });
    expect(onDelta).not.toHaveBeenCalled();
    await expect(api.runAiRequest({ ...request, streamId: "ai3" })).rejects.toThrow();
  });
});
