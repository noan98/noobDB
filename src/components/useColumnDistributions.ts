import { useEffect, useRef, useState } from "react";
import type { CellValue } from "../api/tauri";
import type { CellKind } from "./cellTypeMeta";
import {
  advanceDistribution,
  type ColumnDistribution,
  createDistributionAccumulator,
  finishDistribution,
} from "./gridColumnDistribution";

/** 1 回のアイドル枠で計算に使う時間 (ms)。これを超えたら残りは次の枠へ回す。 */
const SLICE_BUDGET_MS = 6;
/** 時間を確認する間隔 (行数)。 */
export const DIST_ROWS_PER_STEP = 5000;

type Cancel = () => void;

/** ブラウザのアイドル時間に処理を回す (`requestIdleCallback` が無ければ `setTimeout`)。 */
function scheduleIdle(cb: () => void): Cancel {
  const w = window as Window & {
    requestIdleCallback?: (fn: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  if (typeof w.requestIdleCallback === "function") {
    const id = w.requestIdleCallback(cb, { timeout: 2000 });
    return () => w.cancelIdleCallback?.(id);
  }
  const id = setTimeout(cb, 0);
  return () => clearTimeout(id);
}

/**
 * 列ヘッダのミニ分布 (#2383) を、取得済みの行から列ごとにアイドル時間で計算する。
 * 集計状態を保持して行方向に `DIST_ROWS_PER_STEP` 行ずつ進め、`SLICE_BUDGET_MS` で打ち切る
 * (10 万行でも 1 タスクが長くならない)。結果は全列が済んだときに 1 回だけ反映する。
 * ストリーミング中は計算せず前回の結果を保持し、完了したときに 1 度だけ計算する。
 * 行が差し替わっても列の並びが同じなら前の結果を残したまま上書きし、ビンの高さが補間で遷移する。
 */
export function useColumnDistributions(
  enabled: boolean,
  streaming: boolean,
  rows: CellValue[][],
  columnNames: readonly string[],
  kinds: readonly CellKind[],
): (ColumnDistribution | null)[] | null {
  const [state, setState] = useState<{ key: string; list: (ColumnDistribution | null)[] }>({
    key: "",
    list: [],
  });
  const columnKey = columnNames.join("\u0000");
  const kindsRef = useRef(kinds);
  kindsRef.current = kinds;

  // biome-ignore lint/correctness/useExhaustiveDependencies: kinds は ref で最新を読む。列名の並びが変わったときだけ結果を作り直す
  useEffect(() => {
    if (!enabled || streaming || rows.length === 0 || columnNames.length === 0) return;
    let cancelled = false;
    let cancel: Cancel = () => {};
    const count = columnNames.length;
    // 集計状態は今の列の分だけ持ち、済んだら結果だけ残して捨てる (全列ぶんを同時に抱えない)
    const list: (ColumnDistribution | null)[] = [];
    const makeAcc = (i: number) =>
      createDistributionAccumulator(rows.length, i, kindsRef.current[i] ?? "string");
    let col = 0;
    let acc = makeAcc(0);
    const step = () => {
      if (cancelled) return;
      const start = performance.now();
      while (col < count) {
        let done: boolean;
        let result: ColumnDistribution | null = null;
        try {
          done = advanceDistribution(acc, rows, DIST_ROWS_PER_STEP);
          if (done) result = finishDistribution(acc);
        } catch {
          // 1 列の計算が失敗しても他の列へ波及させない (その列だけ分布なし)。
          // アイドルコールバックが例外で止まると全列の更新が止まるため。
          done = true;
          result = null;
        }
        if (done) {
          list.push(result);
          col++;
          if (col < count) acc = makeAcc(col);
        }
        if (performance.now() - start >= SLICE_BUDGET_MS) break;
      }
      if (col < count) {
        cancel = scheduleIdle(step);
        return;
      }
      setState({ key: columnKey, list });
    };
    cancel = scheduleIdle(step);
    return () => {
      cancelled = true;
      cancel();
    };
  }, [enabled, streaming, rows, columnKey]);

  if (!enabled || rows.length === 0 || state.key !== columnKey) return null;
  return state.list;
}
