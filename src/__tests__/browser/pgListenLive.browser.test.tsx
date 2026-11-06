import { beforeEach, describe, expect, it, vi } from "vitest";
import { MotionConfig } from "motion/react";
import { renderInBrowser } from "./render";
import type { PgListenStreamHandlers } from "../../api/tauri";

// LISTEN/NOTIFY 監視パネルのライブフィード (#2093) を実ブラウザで検証する:
// 新着フラッシュ・表示一時停止 (読んでいる行が動かない)・チャンネル絞り込み。

let handlers: PgListenStreamHandlers | null = null;

vi.mock("../../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/tauri")>();
  return {
    ...actual,
    listenPgListenStream: vi.fn(async (_id: string, h: PgListenStreamHandlers) => {
      handlers = h;
      return () => {};
    }),
    api: {
      ...actual.api,
      startPgListen: vi.fn(async () => undefined),
      pgListenAddChannel: vi.fn(async () => undefined),
      pgListenRemoveChannel: vi.fn(async () => undefined),
      cancelStream: vi.fn(async () => ({ cancelled: true, deliveredRows: 0 })),
    },
  };
});

import { PgListenPanel } from "../../components/PgListenPanel";

const note = (channel: string, payload: string, n: number) => ({
  channel,
  payload,
  payloadTruncated: false,
  pid: 1,
  receivedAtMs: n,
});
const rows = () => Array.from(document.querySelectorAll("[data-testid='pglisten-row']")) as HTMLElement[];
const byId = (id: string) => document.querySelector(`[data-testid='${id}']`) as HTMLElement;

async function mount() {
  const screen = await renderInBrowser(
    <MotionConfig reducedMotion="never">
      <div style={{ width: 800, height: 600, display: "flex", flexDirection: "column" }}>
        <PgListenPanel sessionId="s1" driver="postgres" />
      </div>
    </MotionConfig>,
  );
  const input = document.querySelector("[data-testid='pglisten-channel-input']") as HTMLInputElement;
  for (const c of ["a", "b"]) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, c);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    byId("pglisten-add").click();
    await expect.poll(() => byId(`pglisten-filter-${c}`)).toBeTruthy();
  }
  byId("pglisten-start").click();
  await expect.poll(() => handlers).not.toBeNull();
  handlers?.onStarted?.({ channels: ["a", "b"] });
  return screen;
}

describe("LISTEN/NOTIFY ライブフィード (#2093, 実ブラウザ)", () => {
  beforeEach(() => {
    handlers = null;
    localStorage.clear();
  });

  it("新着行はフラッシュ (apply-flash) が再生され、点が脈動する", async () => {
    await mount();
    await expect.poll(() => byId("pglisten-status").getAttribute("data-status")).toBe("listening");
    const dot = byId("pglisten-status").querySelector("[data-pulsing]") as HTMLElement;
    // キーフレーム本体は App.css (このテストでは未読込) なので、指定だけ確かめる。
    expect(dot.style.animation).toContain("pulse");
    handlers?.onNotification?.(note("a", "one", 1));
    await expect.poll(() => rows().length).toBe(1);
    const flash = rows()[0].querySelector("[data-live-flash]") as HTMLElement;
    expect(flash).toBeTruthy();
    expect(flash.classList.contains("flash-ring")).toBe(true);
  });

  it("一時停止中は行の位置が動かず、新着バッジで反映する", async () => {
    await mount();
    handlers?.onNotification?.(note("a", "one", 1));
    await expect.poll(() => rows().length).toBe(1);
    byId("pglisten-pause").click();
    const top = rows()[0].getBoundingClientRect().top;
    for (let i = 2; i <= 30; i++) handlers?.onNotification?.(note("a", `n${i}`, i));
    await expect.poll(() => byId("pglisten-pending")).toBeTruthy();
    expect(rows().length).toBe(1);
    expect(rows()[0].getBoundingClientRect().top).toBe(top);
    byId("pglisten-pending").click();
    await expect.poll(() => rows().length).toBe(30);
  });

  it("チャンネルのチップで絞り込める", async () => {
    await mount();
    handlers?.onNotification?.(note("a", "x", 1));
    handlers?.onNotification?.(note("b", "y", 2));
    await expect.poll(() => rows().length).toBe(2);
    byId("pglisten-filter-b").click();
    await expect.poll(() => rows().length).toBe(1);
    expect(rows()[0].textContent).toContain("y");
  });
});
