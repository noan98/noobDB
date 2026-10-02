import { describe, expect, it } from "vitest";
import type { CellValue, StreamStatsSnapshot } from "../api/tauri";
import { createStreamRowFlusher, type DrainedStreamRows } from "../streamRowFlusher";

// 時刻とタイマーを手動で進められる偽の環境。
function setup(opts: { visible?: boolean; intervalMs?: number } = {}) {
  let t = 1000;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const state = { visible: opts.visible ?? true };
  const applied: DrainedStreamRows[] = [];
  const flusher = createStreamRowFlusher({
    isVisible: () => state.visible,
    apply: (d) => applied.push(d),
    intervalMs: opts.intervalMs ?? 200,
    now: () => t,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimer: (h) => {
      timers.delete(h as number);
    },
  });
  const advance = (ms: number) => {
    t += ms;
    for (const [id, tm] of [...timers]) {
      if (tm.at <= t) {
        timers.delete(id);
        tm.fn();
      }
    }
  };
  return { flusher, state, applied, advance, timers };
}

const rows = (n: number, seed = 0): CellValue[][] =>
  Array.from({ length: n }, (_, i) => [seed + i] as CellValue[]);
const stats = (rowCount: number) => ({ rowCount }) as unknown as StreamStatsSnapshot;

describe("createStreamRowFlusher", () => {
  it("初回のバッチは待たずに (0ms タイマーで) 反映する", () => {
    const { flusher, applied, advance } = setup();
    flusher.push(rows(3), stats(3));
    expect(applied).toHaveLength(0);
    advance(0);
    expect(applied).toHaveLength(1);
    expect(applied[0].rows).toBe(3);
    expect(applied[0].urgent).toBe(false);
  });

  it("間隔内に届いた複数バッチは 1 回にまとめて反映し、統計は最新を使う", () => {
    const { flusher, applied, advance } = setup();
    flusher.push(rows(2), stats(2));
    advance(0); // 初回
    flusher.push(rows(2, 10), stats(4));
    flusher.push(rows(3, 20), stats(7));
    advance(100);
    expect(applied).toHaveLength(1); // まだ間隔内
    advance(100);
    expect(applied).toHaveLength(2);
    expect(applied[1].rows).toBe(5);
    expect(applied[1].chunks).toHaveLength(2);
    expect(applied[1].stats).toEqual(stats(7));
    expect(([] as CellValue[][]).concat(...applied[1].chunks).map((r) => r[0])).toEqual([10, 11, 20, 21, 22]);
  });

  it("見えていないタブは貯めるだけで、resume で反映する", () => {
    const { flusher, state, applied, advance, timers } = setup({ visible: false });
    flusher.push(rows(4), stats(4));
    flusher.push(rows(4, 4), stats(8));
    advance(5000);
    expect(applied).toHaveLength(0);
    expect(timers.size).toBe(0);
    expect(flusher.pendingRows()).toBe(8);
    expect(flusher.receivedRows()).toBe(8);

    state.visible = true;
    flusher.resume();
    advance(0);
    expect(applied).toHaveLength(1);
    expect(applied[0].rows).toBe(8);
    expect(flusher.pendingRows()).toBe(0);
  });

  it("待っている間に見えなくなったら反映せず、貯めたままにする", () => {
    const { flusher, state, applied, advance } = setup();
    flusher.push(rows(1), stats(1));
    advance(0);
    flusher.push(rows(2), stats(3));
    state.visible = false;
    advance(200);
    expect(applied).toHaveLength(1);
    expect(flusher.pendingRows()).toBe(2);
  });

  it("flushNow は見えていなくても即反映し urgent を立て、タイマーを止める", () => {
    const { flusher, applied, advance, timers } = setup({ visible: false });
    flusher.push(rows(5), stats(5));
    flusher.flushNow();
    expect(applied).toHaveLength(1);
    expect(applied[0].urgent).toBe(true);
    expect(timers.size).toBe(0);
    advance(1000);
    expect(applied).toHaveLength(1);
  });

  it("flushNow は貯まっていなければ何もしない", () => {
    const { flusher, applied } = setup();
    flusher.flushNow();
    expect(applied).toHaveLength(0);
  });

  it("discard は保留分とタイマーを捨て、累計から差し引く", () => {
    const { flusher, applied, advance, timers } = setup();
    flusher.push(rows(3), stats(3));
    expect(timers.size).toBe(1);
    flusher.discard();
    expect(timers.size).toBe(0);
    advance(1000);
    expect(applied).toHaveLength(0);
    expect(flusher.receivedRows()).toBe(0);
    expect(flusher.pendingRows()).toBe(0);
  });

  it("空のバッチは無視する", () => {
    const { flusher, timers } = setup();
    flusher.push([], stats(0));
    expect(timers.size).toBe(0);
    expect(flusher.receivedRows()).toBe(0);
  });

  it("反映後の累計は反映済み + 保留になる", () => {
    const { flusher, advance } = setup();
    flusher.push(rows(2), stats(2));
    advance(0);
    flusher.push(rows(3), stats(5));
    expect(flusher.receivedRows()).toBe(5);
    expect(flusher.pendingRows()).toBe(3);
  });
});
