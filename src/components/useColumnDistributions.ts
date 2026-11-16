import { useEffect, useRef, useState } from "react";
import type { CellValue } from "../api/tauri";
import type { CellKind } from "./cellTypeMeta";
import { type ColumnDistribution, computeColumnDistribution } from "./gridColumnDistribution";

/** 1 回のアイドル枠で計算に使う時間 (ms)。これを超えたら残りは次の枠へ回す。 */
const SLICE_BUDGET_MS = 8;

type Cancel = () => void;

/** ブラウザのアイドル時間に処理を回す (`requestIdleCallback` が無ければ `setTimeout`)。 */
function scheduleIdle(cb: () => void): Cancel {
  const w = window as Window & {
    requestIdleCallback?: (fn: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  if (typeof w.requestIdleCallback === "function") {
    const id = w.requestIdleCallback(cb, { timeout: 500 });
    return () => w.cancelIdleCallback?.(id);
  }
  const id = setTimeout(cb, 0);
  return () => clearTimeout(id);
}

/**
 * 列ヘッダのミニ分布 (#2383) を、取得済みの行から列ごとにアイドル時間で計算する。
 * 計算は 1 列ずつ `SLICE_BUDGET_MS` の枠に収まる分だけ進め、10 万行でも初回描画とスクロールを
 * 塞がない (Worker へ全行を structured clone で送るより安い)。行が差し替わっても、列の並びが
 * 同じなら前の結果を残したまま上書きし、ビンの高さが補間で遷移する。
 */
export function useColumnDistributions(
  enabled: boolean,
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
    if (!enabled || rows.length === 0 || columnNames.length === 0) return;
    let cancelled = false;
    let cancel: Cancel = () => {};
    let next = 0;
    const count = columnNames.length;
    const done: (ColumnDistribution | null)[] = new Array(count).fill(null);
    const step = () => {
      if (cancelled) return;
      const start = performance.now();
      do {
        done[next] = computeColumnDistribution(rows, next, kindsRef.current[next] ?? "string");
        next++;
      } while (next < count && performance.now() - start < SLICE_BUDGET_MS);
      const snapshot = done.slice();
      setState((prev) => ({
        key: columnKey,
        // 列の並びが同じなら、まだ計算していない列は前の結果を残す。
        list: snapshot.map((d, i) => d ?? (prev.key === columnKey ? (prev.list[i] ?? null) : null)),
      }));
      if (next < count) cancel = scheduleIdle(step);
    };
    cancel = scheduleIdle(step);
    return () => {
      cancelled = true;
      cancel();
    };
  }, [enabled, rows, columnKey]);

  if (!enabled || rows.length === 0 || state.key !== columnKey) return null;
  return state.list;
}
