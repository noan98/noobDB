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
  return chron.map((g, index) => ({
    id: g.id,
    index,
    capturedAt: g.captured_at,
    rowCount: g.row_count,
    truncated: g.truncated,
    x: usable ? (times[index] - minT) / (maxT - minT) : n === 1 ? 0.5 : index / (n - 1),
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
