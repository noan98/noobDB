// @vitest-environment jsdom
// 「トンネル開通」(#1866) を connecting → connected の 1 回だけ再生することを固定する。
import { ChakraProvider } from "@chakra-ui/react";
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionStatusDot,
  shouldPlayTunnelOpen,
  type ConnectionDotStatus,
} from "../components/ConnectionStatusDot";
import { system } from "../theme";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(status: ConnectionDotStatus, strict = false) {
  if (!host) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  }
  const dot = (
    <ChakraProvider value={system}>
      <ConnectionStatusDot status={status} label={status} />
    </ChakraProvider>
  );
  act(() => root?.render(strict ? <StrictMode>{dot}</StrictMode> : dot));
  return host.querySelector("span") as HTMLElement;
}

// jsdom はレイアウトが無く getClientRects が常に空になるため、「表示中」として扱う。
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
});

afterEach(() => {
  vi.restoreAllMocks();
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.documentElement.removeAttribute("data-motion");
  document.documentElement.removeAttribute("data-theme");
  vi.unstubAllGlobals();
});

describe("shouldPlayTunnelOpen", () => {
  it("connecting → connected だけ true", () => {
    expect(shouldPlayTunnelOpen("connecting", "connected")).toBe(true);
    expect(shouldPlayTunnelOpen(null, "connected")).toBe(false);
    expect(shouldPlayTunnelOpen("idle", "connected")).toBe(false);
    expect(shouldPlayTunnelOpen("connected", "connected")).toBe(false);
    expect(shouldPlayTunnelOpen("connecting", "error")).toBe(false);
  });
});

describe("ConnectionStatusDot", () => {
  it("connecting から connected へ変わった瞬間にクラスが付き、animationend で外れる", () => {
    render("connecting");
    const el = render("connected");
    expect(el.classList.contains("is-tunnel-open")).toBe(true);
    act(() => {
      el.dispatchEvent(new Event("animationend"));
    });
    expect(el.classList.contains("is-tunnel-open")).toBe(false);
  });

  it("初期表示で既に connected なら再生しない (再レンダーでも)", () => {
    const el = render("connected");
    expect(el.classList.contains("is-tunnel-open")).toBe(false);
    render("connected");
    expect(el.classList.contains("is-tunnel-open")).toBe(false);
  });

  it("再生後の再レンダーでは重複再生しないが、再接続 (connecting を経る) ではもう一度再生する", () => {
    render("connecting");
    const el = render("connected");
    act(() => {
      el.dispatchEvent(new Event("animationend"));
    });
    render("connected");
    expect(el.classList.contains("is-tunnel-open")).toBe(false);
    render("idle");
    render("connecting");
    render("connected");
    expect(el.classList.contains("is-tunnel-open")).toBe(true);
  });

  it("animationcancel でもクラスが外れ、リスナーも解除される", () => {
    render("connecting");
    const el = render("connected");
    const spy = vi.spyOn(el, "removeEventListener");
    el.getAnimations = () => [];
    act(() => {
      el.dispatchEvent(new Event("animationcancel"));
    });
    expect(el.classList.contains("is-tunnel-open")).toBe(false);
    expect(spy).toHaveBeenCalledWith("animationend", expect.any(Function));
    expect(spy).toHaveBeenCalledWith("animationcancel", expect.any(Function));
  });

  it("新しい再生が走っている間に届いた古い animationcancel では外さない", () => {
    render("connecting");
    const el = render("connected");
    el.getAnimations = () => [{} as Animation];
    act(() => {
      el.dispatchEvent(new Event("animationcancel"));
    });
    expect(el.classList.contains("is-tunnel-open")).toBe(true);
  });

  it("子孫から届いた animationend では外さない", () => {
    render("connecting");
    const el = render("connected");
    const child = document.createElement("i");
    el.appendChild(child);
    child.dispatchEvent(new Event("animationend", { bubbles: true }));
    expect(el.classList.contains("is-tunnel-open")).toBe(true);
  });

  it("再生中に別状態へ変わるとクラスが残らない", () => {
    render("connecting");
    const el = render("connected");
    expect(el.classList.contains("is-tunnel-open")).toBe(true);
    render("idle");
    expect(el.classList.contains("is-tunnel-open")).toBe(false);
  });

  it("非表示 (レイアウトなし) の間に遷移しても再生しない", () => {
    render("connecting");
    const el = host?.querySelector("span") as HTMLElement;
    vi.spyOn(el, "getClientRects").mockReturnValue([] as unknown as DOMRectList);
    render("connected");
    expect(el.classList.contains("is-tunnel-open")).toBe(false);
  });

  it("StrictMode の二重 effect でも connecting → connected で 1 回だけ付く", () => {
    render("connecting", true);
    const el = render("connected", true);
    expect(el.classList.contains("is-tunnel-open")).toBe(true);
  });

  it("StrictMode でも初期 connected では再生しない", () => {
    const el = render("connected", true);
    expect(el.classList.contains("is-tunnel-open")).toBe(false);
  });

  it("reduced-motion では再生しない", () => {
    document.documentElement.setAttribute("data-motion", "reduced");
    render("connecting");
    expect(render("connected").classList.contains("is-tunnel-open")).toBe(false);
  });

  it("ハイコントラストテーマでは再生しない", () => {
    document.documentElement.setAttribute("data-theme", "hc-dark");
    render("connecting");
    expect(render("connected").classList.contains("is-tunnel-open")).toBe(false);
  });
});
