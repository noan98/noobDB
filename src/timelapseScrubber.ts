import type { TimelapseGenerationMeta } from "./api/tauri";

/**
 * タイムラプスのスクラバー (#2095) の配置計算。UI から切り離した純関数。
 *
 * 世代一覧は新しい順で届くので、時系列 (古い順) に並べ直し、取得時刻に比例した
 * 横位置 (0〜1) と、行数に応じた縦位置 (0 = 最小, 1 = 最大) を求める。
 * 段 (step) は `timelapsePlayback.ts` と同じで、時系列 k 番目の世代 = 段 k (k >= 1)。
 */
export interface ScrubberTick {
  id: number;
  /** 時系列の添字 (0 = 最古)。1 以上の添字はそのまま段に対応する。 */
  index: number;
  capturedAt: string;
  rowCount: number;
  truncated: boolean;
  /** 取得時刻に比例した横位置 (0〜1)。 */
  x: number;
  /** 行数の相対位置 (0〜1)。全世代が同じ行数なら 0.5。 */
  y: number;
}

/** 隣り合う目盛りの最小間隔 (トラック幅に対する比率)。連続取得した世代が重ならないようにする。 */
export const MIN_TICK_GAP = 0.02;

/**
 * 時系列順の位置 (0〜1) を単調非減少にしたうえで、最小間隔を確保する。時刻が id 順と逆転していても
 * 位置は戻らない。最小間隔を取れない数 (世代が多すぎる) なら等間隔にする。
 */
export function spreadPositions(raw: readonly number[], gap: number = MIN_TICK_GAP): number[] {
  const n = raw.length;
  if (n <= 1) return [...raw];
  if (gap * (n - 1) >= 1) return raw.map((_, i) => i / (n - 1));
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(i === 0 ? raw[0] : Math.max(raw[i], out[i - 1] + gap));
  const first = out[0];
  const last = out[n - 1];
  // 右端を超えた分は全体を [first, 1] に収めて再スケールする (間隔比は保たれ、最小間隔は gap 以上のまま)。
  if (last > 1) {
    const room = 1 - first;
    return out.map((v) => first + ((v - first) * room) / (last - first));
  }
  return out;
}

export function scrubberTicks(generations: readonly TimelapseGenerationMeta[]): ScrubberTick[] {
  const chron = [...generations].reverse();
  const n = chron.length;
  if (n === 0) return [];
  const times = chron.map((g) => new Date(g.captured_at).getTime());
  const finite = times.filter((v) => Number.isFinite(v));
  const minT = Math.min(...finite);
  const maxT = Math.max(...finite);
  // 時刻が読めない・全世代が同時刻なら、等間隔に退避する (目盛りが重ならないように)。
  const usable = finite.length === n && maxT > minT;
  const counts = chron.map((g) => g.row_count);
  const minC = Math.min(...counts);
  const maxC = Math.max(...counts);
  const raw = chron.map((_, index) =>
    usable ? (times[index] - minT) / (maxT - minT) : n === 1 ? 0.5 : index / (n - 1),
  );
  const xs = spreadPositions(raw);
  return chron.map((g, index) => ({
    id: g.id,
    index,
    capturedAt: g.captured_at,
    rowCount: g.row_count,
    truncated: g.truncated,
    x: xs[index],
    y: maxC > minC ? (g.row_count - minC) / (maxC - minC) : 0.5,
  }));
}

/** 横位置 (0〜1) に最も近い、選択可能な目盛り (段 1 以上) の段を返す。無ければ null。 */
export function nearestStep(ticks: readonly ScrubberTick[], x: number): number | null {
  let best: number | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const tk of ticks) {
    if (tk.index < 1) continue;
    const d = Math.abs(tk.x - x);
    if (d < bestD) {
      bestD = d;
      best = tk.index;
    }
  }
  return best;
}

/** 取得時刻を UI ロケールで整形する。読めない値はそのまま返す。 */
export function formatCaptured(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(locale === "ja" ? "ja-JP" : "en-US");
}
