import { describe, it, expect } from "vitest";
import type { TimelapseGenerationMeta } from "../api/tauri";
import {
  chronologicalGenerations,
  clampStep,
  initialPlayback,
  pairAtStep,
  playbackMaxStep,
  playbackReducer,
  stepOfPair,
} from "../timelapsePlayback";

// 新しい順 (id 13 が最新)。
const gens: TimelapseGenerationMeta[] = [13, 12, 11, 10].map((id) => ({
  id,
  captured_at: `2026-01-0${id - 9}T00:00:00Z`,
  row_count: 1,
  truncated: false,
  bytes: 1,
}));

describe("timelapsePlayback (#2015)", () => {
  it("世代数から最終段と隣接ペアを求める (古い方 → 新しい方)", () => {
    expect(playbackMaxStep(gens)).toBe(3);
    expect(playbackMaxStep([])).toBe(0);
    expect(pairAtStep(gens, 1)).toEqual({ fromId: 10, toId: 11 });
    expect(pairAtStep(gens, 3)).toEqual({ fromId: 12, toId: 13 });
    expect(pairAtStep(gens, 0)).toBeNull();
    expect(pairAtStep(gens, 4)).toBeNull();
    expect(chronologicalGenerations(gens).map((g) => g.id)).toEqual([10, 11, 12, 13]);
  });

  it("ペア → 段は新しい側の位置で決まる", () => {
    expect(stepOfPair(gens, { fromId: 12, toId: 13 })).toBe(3);
    expect(stepOfPair(gens, { fromId: 10, toId: 11 })).toBe(1);
    // 隣接でない任意ペアも新しい側の段。
    expect(stepOfPair(gens, { fromId: 10, toId: 13 })).toBe(3);
    expect(stepOfPair(gens, { fromId: 99, toId: 98 })).toBeNull();
    expect(stepOfPair(gens, null)).toBeNull();
  });

  it("clampStep は範囲に丸め、段が無ければ 0", () => {
    expect(clampStep(0, 3)).toBe(1);
    expect(clampStep(9, 3)).toBe(3);
    expect(clampStep(2.6, 3)).toBe(3);
    expect(clampStep(5, 0)).toBe(0);
    expect(clampStep(Number.NaN, 3)).toBe(1);
  });

  it("開始 → 段送り → 終端で自動停止する", () => {
    let s = initialPlayback(1, 3);
    s = playbackReducer(s, { type: "play", reducedMotion: false });
    expect(s).toMatchObject({ step: 1, playing: true });
    s = playbackReducer(s, { type: "advance" });
    expect(s).toMatchObject({ step: 2, playing: true });
    s = playbackReducer(s, { type: "advance" });
    expect(s).toMatchObject({ step: 3, playing: false });
    // 停止後の advance は何もしない。
    expect(playbackReducer(s, { type: "advance" })).toBe(s);
  });

  it("終端で再生を押すと最初の段からやり直す", () => {
    const s = playbackReducer(initialPlayback(3, 3), { type: "play", reducedMotion: false });
    expect(s).toMatchObject({ step: 1, playing: true });
  });

  it("停止とシークと手動段送りは再生を止める", () => {
    const playing = playbackReducer(initialPlayback(1, 4), { type: "play", reducedMotion: false });
    expect(playbackReducer(playing, { type: "pause" })).toMatchObject({ step: 1, playing: false });
    expect(playbackReducer(playing, { type: "seek", step: 3 })).toMatchObject({ step: 3, playing: false });
    expect(playbackReducer(playing, { type: "stepBy", delta: 1 })).toMatchObject({ step: 2, playing: false });
    expect(playbackReducer(initialPlayback(1, 4), { type: "stepBy", delta: -1 })).toMatchObject({ step: 1 });
    expect(playbackReducer(initialPlayback(4, 4), { type: "stepBy", delta: 1 })).toMatchObject({ step: 4 });
  });

  it("reduced-motion では再生できない (ステップ送りだけ)", () => {
    const s = playbackReducer(initialPlayback(1, 3), { type: "play", reducedMotion: true });
    expect(s.playing).toBe(false);
    expect(playbackReducer(s, { type: "stepBy", delta: 1 }).step).toBe(2);
  });

  it("段が 0 / 1 つだけなら再生しない", () => {
    expect(playbackReducer(initialPlayback(0, 0), { type: "play", reducedMotion: false }).playing).toBe(
      false,
    );
    expect(playbackReducer(initialPlayback(1, 1), { type: "play", reducedMotion: false }).playing).toBe(
      false,
    );
  });
});
