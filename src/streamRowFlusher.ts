import type { CellValue, StreamStatsSnapshot } from "./api/tauri";

/**
 * ストリーミング結果の行バッチを「貯めて、間引いて、まとめて反映する」純ロジック (#1317)。
 *
 * バックエンドは 75ms 間隔 (初回は即時) で行バッチを送る。これをバッチごとに
 * `setTabs` へ流すと App ルートが 1 本のストリームあたり毎秒十数回再レンダーされ、
 * しかも毎回 `rows.concat` で行配列全体をコピーしていた。ここでは:
 *
 * - バッチはチャンクのまま貯めるだけにして、反映は `intervalMs` に 1 回までに間引く
 *   (反映時に 1 回だけ `concat` するので、コピーの回数も減る)。
 * - 見えていないタブ (`isVisible() === false`) は貯めるだけで反映しない。表示された
 *   ときに `resume()` でまとめて反映する。
 * - 完了・キャンセル・エラーの直前は `flushNow()` で取りこぼしなく吐き出す。
 *
 * 時刻とタイマーは注入できるようにしてあり、App.tsx に依存せず単体でテストできる。
 */

/** 見えているタブの反映間隔。体感の進捗更新を保ちつつ再レンダーを毎秒 5 回程度に抑える。 */
export const STREAM_FLUSH_INTERVAL_MS = 200;

/** `apply` に渡す、貯まっていた行の塊。 */
export interface DrainedStreamRows {
  /** 到着順のチャンク。呼び出し側が `base.concat(...chunks)` で 1 回だけ結合する。 */
  chunks: CellValue[][][];
  /** 最後に届いたバッチに付いていた列統計 (累積値なので最新だけ使う)。 */
  stats: StreamStatsSnapshot | null;
  /** 今回反映する行数 (チャンクの合計)。 */
  rows: number;
  /**
   * `flushNow()` 由来 (完了・キャンセル・エラーの直前) なら真。直後の同期的な状態更新
   * より後ろに回ると行数の不整合が見えるので、呼び出し側は `startTransition` で包まない。
   */
  urgent: boolean;
}

export interface StreamRowFlusherOptions {
  /** そのタブが今ユーザの目に見えているか。`false` の間は反映を保留する。 */
  isVisible: () => boolean;
  /** 貯めた行を実際の状態へ反映する。 */
  apply: (drained: DrainedStreamRows) => void;
  intervalMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface StreamRowFlusher {
  /** バッチを貯める。反映の予約も行う (見えていないタブでは予約しない)。 */
  push: (rows: CellValue[][], stats: StreamStatsSnapshot | null | undefined) => void;
  /** 貯まっている行をすぐ反映する (完了・キャンセル・エラー直前)。 */
  flushNow: () => void;
  /** 表示状態が変わったときに呼ぶ。見えるようになっていれば保留分の反映を予約する。 */
  resume: () => void;
  /** 保留分を破棄してタイマーも止める (再実行で結果ごと入れ替えるとき)。 */
  discard: () => void;
  /** これまでに届いた累計行数 (反映済み + 保留)。 */
  receivedRows: () => number;
  /** 反映待ちの行数。 */
  pendingRows: () => number;
}

export function createStreamRowFlusher(opts: StreamRowFlusherOptions): StreamRowFlusher {
  const intervalMs = opts.intervalMs ?? STREAM_FLUSH_INTERVAL_MS;
  const now = opts.now ?? (() => Date.now());
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let chunks: CellValue[][][] = [];
  let stats: StreamStatsSnapshot | null = null;
  let pending = 0;
  let received = 0;
  let lastFlushAt = Number.NEGATIVE_INFINITY;
  let timer: unknown = null;

  const stopTimer = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  const drain = (urgent: boolean) => {
    if (pending === 0) return;
    const drained: DrainedStreamRows = { chunks, stats, rows: pending, urgent };
    chunks = [];
    stats = null;
    pending = 0;
    lastFlushAt = now();
    opts.apply(drained);
  };

  const schedule = () => {
    if (timer !== null || pending === 0 || !opts.isVisible()) return;
    const wait = Math.max(0, intervalMs - (now() - lastFlushAt));
    timer = setTimer(() => {
      timer = null;
      // 待っている間に見えなくなっていたら貯めたままにする (resume で再開)。
      if (!opts.isVisible()) return;
      drain(false);
    }, wait);
  };

  return {
    push(rows, nextStats) {
      if (rows.length === 0) return;
      chunks.push(rows);
      if (nextStats) stats = nextStats;
      pending += rows.length;
      received += rows.length;
      schedule();
    },
    flushNow() {
      stopTimer();
      drain(true);
    },
    resume() {
      schedule();
    },
    discard() {
      stopTimer();
      chunks = [];
      stats = null;
      received -= pending;
      pending = 0;
    },
    receivedRows: () => received,
    pendingRows: () => pending,
  };
}
