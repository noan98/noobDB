import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { buildShortcutHints, classifyFocus, hintContextFor } from "../shortcutHint";
import { resolveShortcutBindings } from "../shortcuts";
import { t } from "../i18n";
import {
  resetAllSettings,
  setShortcutHintDelayMs,
  setShortcutHintEnabled,
  DEFAULT_SETTINGS,
} from "../settings";
import { ShortcutHintOverlay } from "../components/ShortcutHintOverlay";
import { renderWithProviders, screen, fireEvent } from "./testUtils";

// 退場アニメ (rAF 駆動) はフェイクタイマーで進まないため、motion は素通しにして表示の有無だけを検証する。
vi.mock("motion/react", async () => {
  const React = await import("react");
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    motion: {
      div: ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) =>
        React.createElement("div", { style }, children),
    },
    useReducedMotion: () => false,
  };
});

const none = { shift: false, alt: false };

describe("buildShortcutHints (#1487)", () => {
  const bindings = resolveShortcutBindings(undefined);

  it("エディタ文脈ではエディタのショートカットを含み、グリッド専用は含まない", () => {
    const keys = buildShortcutHints("editor", bindings, none, t).map((i) => i.key);
    expect(keys).toContain("run");
    expect(keys).toContain("format");
    expect(keys).not.toContain("gridCopy");
  });

  it("グリッド文脈ではグリッドのショートカットを含み、エディタ専用は含まない", () => {
    const keys = buildShortcutHints("grid", bindings, none, t).map((i) => i.key);
    expect(keys).toContain("gridCopy");
    expect(keys).not.toContain("run");
  });

  it("全画面サーフェスでは global カテゴリだけに絞る", () => {
    const items = buildShortcutHints("surface", bindings, none, t);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.category === "global")).toBe(true);
  });

  it("主修飾キーを使わないコンボ (F1 / Alt+矢印) と Modal 専用の項目は出さない", () => {
    const keys = buildShortcutHints("grid", bindings, none, t).map((i) => i.key);
    expect(keys).not.toContain("openHelp");
    expect(keys).not.toContain("gridPageNext");
    expect(keys).not.toContain("shortcutModalSubmitTitle");
  });

  it("再割り当て済みのキーを反映する", () => {
    const custom = resolveShortcutBindings({ format: "Mod+Shift+K" });
    const format = buildShortcutHints("editor", custom, none, t).find((i) => i.key === "format");
    expect(format?.keys).toBe("Cmd/Ctrl+Shift+K");
  });

  it("主修飾キーを外した再割り当ては一覧から消える", () => {
    const custom = resolveShortcutBindings({ format: "Alt+F" });
    expect(buildShortcutHints("editor", custom, none, t).some((i) => i.key === "format")).toBe(false);
  });

  it("同じコンボはエディタ側 (具体スコープ) を優先して重複させない", () => {
    const items = buildShortcutHints("editor", bindings, none, t);
    const same = items.filter((i) => i.keys === "Cmd/Ctrl+Shift+Enter");
    expect(same.map((i) => i.key)).toEqual(["preview"]);
  });

  it("Shift を押している間は Shift 付きのコンボだけに絞る", () => {
    const items = buildShortcutHints("editor", bindings, { shift: true, alt: false }, t);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.keys.split("+").includes("Shift"))).toBe(true);
  });
});

describe("classifyFocus / hintContextFor (#1487)", () => {
  it("CodeMirror 内はエディタ、grid ロールはグリッド、素の入力欄は text", () => {
    document.body.innerHTML = `
      <div class="cm-editor"><div class="cm-content" contenteditable="true" id="cm"></div></div>
      <div role="grid"><div tabindex="0" id="g"></div></div>
      <input id="i" type="text" /><input id="c" type="checkbox" /><textarea id="ta"></textarea>`;
    const el = (id: string) => document.getElementById(id);
    expect(classifyFocus(el("cm"))).toBe("editor");
    expect(classifyFocus(el("g"))).toBe("grid");
    expect(classifyFocus(el("i"))).toBe("text");
    expect(classifyFocus(el("ta"))).toBe("text");
    expect(classifyFocus(el("c"))).toBe("other");
    expect(classifyFocus(null)).toBe("other");
    document.body.innerHTML = "";
  });

  it("サーフェス表示中はフォーカスに関わらず surface", () => {
    expect(hintContextFor("editor", true)).toBe("surface");
    expect(hintContextFor("editor", false)).toBe("editor");
    expect(hintContextFor("other", false)).toBe("global");
  });
});

describe("ShortcutHintOverlay (#1487)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetAllSettings();
    setShortcutHintDelayMs(DEFAULT_SETTINGS.shortcutHintDelayMs);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  const down = (init: KeyboardEventInit) => fireEvent.keyDown(window, init);
  const up = (init: KeyboardEventInit) => fireEvent.keyUp(window, init);
  const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
  const delay = () => DEFAULT_SETTINGS.shortcutHintDelayMs;
  const overlay = () => screen.queryByTestId("shortcut-hint-overlay");

  it("修飾キーを遅延より長く押し続けると出て、離すと消える", () => {
    renderWithProviders(<ShortcutHintOverlay surface={false} isBlocked={() => false} />);
    down({ key: "Control", ctrlKey: true });
    wait(delay() - 50);
    expect(overlay()).toBeNull();
    wait(100);
    expect(overlay()).not.toBeNull();
    up({ key: "Control", ctrlKey: false });
    wait(1000);
    expect(overlay()).toBeNull();
  });

  it("短く押しただけ / 普通のショートカット入力 (Ctrl+K) では出ない", () => {
    renderWithProviders(<ShortcutHintOverlay surface={false} isBlocked={() => false} />);
    down({ key: "Control", ctrlKey: true });
    wait(100);
    up({ key: "Control" });
    wait(delay() * 2);
    expect(overlay()).toBeNull();

    down({ key: "Control", ctrlKey: true });
    down({ key: "k", ctrlKey: true });
    wait(delay() * 2);
    expect(overlay()).toBeNull();
  });

  it("キー処理を横取りしない (preventDefault しない)", () => {
    renderWithProviders(<ShortcutHintOverlay surface={false} isBlocked={() => false} />);
    const ev = new KeyboardEvent("keydown", { key: "Control", ctrlKey: true, cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("表示中に Esc / 他のキー / ウィンドウのフォーカス喪失で閉じる", () => {
    renderWithProviders(<ShortcutHintOverlay surface={false} isBlocked={() => false} />);
    for (const close of [
      () => down({ key: "Escape", ctrlKey: true }),
      () => down({ key: "k", ctrlKey: true }),
      () => fireEvent.blur(window),
    ]) {
      down({ key: "Control", ctrlKey: true });
      wait(delay() + 10);
      expect(overlay()).not.toBeNull();
      close();
      expect(overlay()).toBeNull();
      up({ key: "Control" });
    }
  });

  it("IME 変換中は反応しない", () => {
    renderWithProviders(<ShortcutHintOverlay surface={false} isBlocked={() => false} />);
    down({ key: "Control", ctrlKey: true });
    fireEvent(document, new Event("compositionstart"));
    wait(delay() + 10);
    expect(overlay()).toBeNull();
    fireEvent(document, new Event("compositionend"));
    up({ key: "Control" });

    down({ key: "Process", keyCode: 229, isComposing: true });
    down({ key: "Control", ctrlKey: true, isComposing: true });
    wait(delay() + 10);
    // isComposing の keydown は待機を始めない。
    expect(overlay()).toBeNull();
  });

  it("テキスト入力欄・ブロック中・設定オフでは出ない", () => {
    document.body.insertAdjacentHTML("beforeend", '<input id="txt" type="text" />');
    const input = document.getElementById("txt") as HTMLInputElement;
    const { unmount } = renderWithProviders(<ShortcutHintOverlay surface={false} isBlocked={() => false} />);
    input.focus();
    down({ key: "Control", ctrlKey: true });
    wait(delay() + 10);
    expect(overlay()).toBeNull();
    up({ key: "Control" });
    input.blur();
    unmount();

    const blocked = renderWithProviders(<ShortcutHintOverlay surface={false} isBlocked={() => true} />);
    down({ key: "Control", ctrlKey: true });
    wait(delay() + 10);
    expect(overlay()).toBeNull();
    up({ key: "Control" });
    blocked.unmount();

    setShortcutHintEnabled(false);
    renderWithProviders(<ShortcutHintOverlay surface={false} isBlocked={() => false} />);
    down({ key: "Control", ctrlKey: true });
    wait(delay() + 10);
    expect(overlay()).toBeNull();
  });

  it("設定した遅延に従う", () => {
    setShortcutHintDelayMs(1500);
    renderWithProviders(<ShortcutHintOverlay surface={false} isBlocked={() => false} />);
    down({ key: "Control", ctrlKey: true });
    wait(1400);
    expect(overlay()).toBeNull();
    wait(200);
    expect(overlay()).not.toBeNull();
  });
});
