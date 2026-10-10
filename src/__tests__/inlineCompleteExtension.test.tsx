import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import {
  inlineCompleteExtension,
  inlineSuggestionOf,
  type InlineCompleteConfig,
  type InlineCompleteTransport,
} from "../components/inlineCompleteExtension";
import type { AiStreamHandlers } from "../api/tauri";
import { toAiSnapshot, DEFAULT_AI_SETTINGS } from "../ai/aiSettings";

const config: InlineCompleteConfig = {
  driver: "mysql",
  maskLiterals: true,
  tables: [{ name: "users", columns: ["id", "name"] }],
  database: "app",
  settings: toAiSnapshot({ ...DEFAULT_AI_SETTINGS, enabled: true, inlineComplete: true, sendScope: "schemaAndSql" }),
};

interface Harness {
  view: EditorView;
  run: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  handlers: AiStreamHandlers[];
  getConfig: ReturnType<typeof vi.fn>;
}

function setup(answer: string | null = "WHERE id = 1", cfg: InlineCompleteConfig | null = config): Harness {
  const handlers: AiStreamHandlers[] = [];
  const run = vi.fn(async () => {});
  const cancel = vi.fn(async () => {});
  const transport: InlineCompleteTransport = {
    listen: async (_id, h) => {
      handlers.push(h);
      return () => {};
    },
    run: run as unknown as InlineCompleteTransport["run"],
    cancel,
  };
  const getConfig = vi.fn(() => cfg);
  void answer;
  const view = new EditorView({
    state: EditorState.create({
      doc: "",
      extensions: [inlineCompleteExtension({ getConfig, transport })],
    }),
    parent: document.body,
  });
  return { view, run, cancel, handlers, getConfig };
}

function type(view: EditorView, text: string) {
  const pos = view.state.doc.length;
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: "input.type",
  });
}

async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}

function key(view: EditorView, k: string): boolean {
  const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  return runScopeHandlers(view, ev, "editor");
}

async function respond(h: Harness, body: string, idx = 0) {
  h.handlers[idx].onDelta?.({ streamId: "x", text: body } as never);
  h.handlers[idx].onDone?.({} as never);
  await flush();
}

describe("AI インライン補完の CodeMirror 拡張", () => {
  beforeEach(() => {
    // jsdom に無い、CodeMirror の計測が呼ぶ Range の矩形 API。
    const rangeProto = Range.prototype as unknown as Record<string, unknown>;
    rangeProto.getClientRects ??= () => [];
    rangeProto.getBoundingClientRect ??= () => new DOMRect();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("入力が止まってから問い合わせ、薄い文字で提案する", async () => {
    const h = setup();
    type(h.view, "SELECT * FROM users ");
    await vi.advanceTimersByTimeAsync(599);
    expect(h.run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(h.run).toHaveBeenCalledTimes(1);
    const arg = h.run.mock.calls[0][0] as { systemCached: string; prompt: string };
    expect(arg.systemCached).toContain("users(id, name)");
    await respond(h, "WHERE id = 1");
    expect(inlineSuggestionOf(h.view.state)).toEqual({ pos: 20, text: "WHERE id = 1" });
    expect(h.view.dom.querySelector(".cm-inline-suggest")?.textContent).toBe("WHERE id = 1");
  });

  it("Tab で確定し、確定は次の問い合わせを起こさない", async () => {
    const h = setup();
    type(h.view, "SELECT * FROM users ");
    await vi.advanceTimersByTimeAsync(700);
    await respond(h, "WHERE id = 1");
    expect(key(h.view, "Tab")).toBe(true);
    expect(h.view.state.doc.toString()).toBe("SELECT * FROM users WHERE id = 1");
    expect(h.view.state.selection.main.head).toBe(32);
    expect(inlineSuggestionOf(h.view.state)).toBeNull();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.run).toHaveBeenCalledTimes(1);
  });

  it("提案がないときは Tab / Esc を奪わない", () => {
    const h = setup();
    expect(key(h.view, "Tab")).toBe(false);
    expect(key(h.view, "Escape")).toBe(false);
  });

  it("Esc で破棄する", async () => {
    const h = setup();
    type(h.view, "SELECT * FROM users ");
    await vi.advanceTimersByTimeAsync(700);
    await respond(h, "WHERE id = 1");
    expect(key(h.view, "Escape")).toBe(true);
    expect(inlineSuggestionOf(h.view.state)).toBeNull();
    expect(h.view.state.doc.toString()).toBe("SELECT * FROM users ");
  });

  it("入力の継続で提案を破棄し、進行中の要求を中止する", async () => {
    const h = setup();
    type(h.view, "SELECT * FROM users ");
    await vi.advanceTimersByTimeAsync(700);
    type(h.view, "W");
    expect(h.cancel).toHaveBeenCalledTimes(1);
    // 古い応答が届いても出さない。
    await respond(h, "WHERE id = 1");
    expect(inlineSuggestionOf(h.view.state)).toBeNull();
    await vi.advanceTimersByTimeAsync(700);
    expect(h.run).toHaveBeenCalledTimes(2);
  });

  it("提案後のカーソル移動で破棄する", async () => {
    const h = setup();
    type(h.view, "SELECT * FROM users ");
    await vi.advanceTimersByTimeAsync(700);
    await respond(h, "WHERE id = 1");
    h.view.dispatch({ selection: { anchor: 3 } });
    expect(inlineSuggestionOf(h.view.state)).toBeNull();
  });

  it("応答待ちの間にカーソルが動いたら出さない", async () => {
    const h = setup();
    type(h.view, "SELECT * FROM users ");
    await vi.advanceTimersByTimeAsync(700);
    h.view.dispatch({ selection: { anchor: 3 } });
    await respond(h, "WHERE id = 1");
    expect(inlineSuggestionOf(h.view.state)).toBeNull();
  });

  it("3 秒を超えたら中止して提案を出さない", async () => {
    const h = setup();
    type(h.view, "SELECT * FROM users ");
    await vi.advanceTimersByTimeAsync(700);
    await vi.advanceTimersByTimeAsync(3100);
    expect(h.cancel).toHaveBeenCalled();
    await respond(h, "WHERE id = 1");
    expect(inlineSuggestionOf(h.view.state)).toBeNull();
  });

  it("同じ入力はキャッシュから出し、再送しない", async () => {
    const h = setup();
    type(h.view, "SELECT * FROM users ");
    await vi.advanceTimersByTimeAsync(700);
    await respond(h, "WHERE id = 1");
    // 同じ文脈のまま入力し直す (全文を同じ内容で置き換える)。
    h.view.dispatch({
      changes: { from: 0, to: 20, insert: "SELECT * FROM users " },
      selection: { anchor: 20 },
      userEvent: "input.type",
    });
    expect(inlineSuggestionOf(h.view.state)).toBeNull();
    await vi.advanceTimersByTimeAsync(700);
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(inlineSuggestionOf(h.view.state)?.text).toBe("WHERE id = 1");
  });

  it("設定が送信不可 (null) なら一切送らない", async () => {
    const h = setup("x", null);
    type(h.view, "SELECT * FROM users ");
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.getConfig).toHaveBeenCalled();
    expect(h.run).not.toHaveBeenCalled();
    expect(h.handlers).toHaveLength(0);
  });

  it("プログラムによる書き換え (ユーザ入力でない) では問い合わせない", async () => {
    const h = setup();
    h.view.dispatch({ changes: { from: 0, insert: "SELECT * FROM users " } });
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.run).not.toHaveBeenCalled();
  });

  it("IME 変換中は問い合わせない", async () => {
    const h = setup();
    type(h.view, "SELECT * FROM users ");
    Object.defineProperty(h.view, "composing", { value: true, configurable: true });
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.run).not.toHaveBeenCalled();
  });

  it("複数カーソルでは出さない", async () => {
    const h = setup();
    type(h.view, "SELECT * FROM users ");
    h.view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(20), EditorSelection.cursor(3)], 0) });
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.run).not.toHaveBeenCalled();
  });

  it("貼り付けや削除では問い合わせを予約しない", async () => {
    const h = setup();
    h.view.dispatch({ changes: { from: 0, insert: "SELECT * FROM users " }, userEvent: "input.paste" });
    h.view.dispatch({ changes: { from: 19, to: 20 }, userEvent: "delete.backward" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.run).not.toHaveBeenCalled();
  });

  it("destroy で進行中の要求を中止する", async () => {
    const h = setup();
    type(h.view, "SELECT * FROM users ");
    await vi.advanceTimersByTimeAsync(700);
    h.view.destroy();
    expect(h.cancel).toHaveBeenCalledTimes(1);
  });

  it("入力が短い間は送らない", async () => {
    const h = setup();
    type(h.view, "SE");
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.run).not.toHaveBeenCalled();
  });
});
