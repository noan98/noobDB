import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { renderWithProviders } from "./testUtils";
import { QueryEditor } from "../components/QueryEditor";
import { DEFAULT_SETTINGS, replaceAllSettings } from "../settings";
import { resetAiKeyStoreForTest, setAiKeyPresent } from "../ai/aiKeyStore";

// #1479: QueryEditor の配線。設定オフ・schemaOnly・本番では一切送らず、条件がそろうと送る。
const mocks = vi.hoisted(() => ({
  run: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    listenAiStream: mocks.listen,
    api: { ...actual.api, runAiRequest: mocks.run, cancelStream: vi.fn(async () => {}) },
  };
});

function setAi(over: { inlineComplete: boolean; sendScope: "schemaOnly" | "schemaAndSql" }) {
  replaceAllSettings({
    ...DEFAULT_SETTINGS,
    ai: { ...DEFAULT_SETTINGS.ai, enabled: true, consentGiven: true, ...over },
  });
  setAiKeyPresent(true);
}

async function typeAndWait(isProduction: boolean) {
  renderWithProviders(<QueryEditor onRun={vi.fn()} isProduction={isProduction} />);
  await waitFor(() => expect(document.querySelector(".cm-editor")).toBeTruthy());
  const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement);
  if (!view) throw new Error("no view");
  act(() => {
    view.dispatch({
      changes: { from: 0, insert: "SELECT * FROM users " },
      selection: { anchor: 20 },
      userEvent: "input.type",
    });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
}

describe("QueryEditor のインライン補完の配線 (#1479)", () => {
  beforeEach(() => {
    mocks.run.mockClear();
    mocks.listen.mockClear();
    resetAiKeyStoreForTest();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("機能オフでは送らない", async () => {
    setAi({ inlineComplete: false, sendScope: "schemaAndSql" });
    await typeAndWait(false);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("送信範囲が schemaOnly では送らない", async () => {
    setAi({ inlineComplete: true, sendScope: "schemaOnly" });
    await typeAndWait(false);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("本番接続では送らない", async () => {
    setAi({ inlineComplete: true, sendScope: "schemaAndSql" });
    await typeAndWait(true);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("条件がそろえば inlineComplete タスクで送る", async () => {
    setAi({ inlineComplete: true, sendScope: "schemaAndSql" });
    await typeAndWait(false);
    expect(mocks.run).toHaveBeenCalledTimes(1);
    const arg = mocks.run.mock.calls[0] as unknown as [{ task: string }];
    expect(arg[0].task).toBe("inlineComplete");
  });
});
