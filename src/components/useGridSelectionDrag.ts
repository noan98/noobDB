import { useCallback, useEffect, useRef } from "react";
import { beginPointerDrag } from "./treeDragStore";
import type { GridInsertPlan } from "./gridDragInsert";

/**
 * 結果グリッドの選択セルを SQL エディタへドラッグ挿入する入口 (#2406)。
 *
 * セルの `mousedown` (React) には `pointerId` が無いので、直前の `pointerdown` を window で
 * 控えておき、`startGridSelectionDrag` で `treeDragStore` のポインタ・ドラッグへ引き渡す。
 * `pointerdown` が無い環境 (古いテスト等) では何もせず false を返し、従来のマーキー選択に任せる。
 */
export function useGridSelectionDrag() {
  const lastDownRef = useRef<PointerEvent | null>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      lastDownRef.current = e;
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, []);
  return useCallback(
    (
      cell: HTMLElement,
      plan: GridInsertPlan,
      mouse: { clientX: number; clientY: number },
      onTap?: () => void,
    ) => {
      const down = lastDownRef.current;
      if (!plan.ok || !down || down.clientX !== mouse.clientX || down.clientY !== mouse.clientY) return false;
      return beginPointerDrag(cell, down, { kind: "text", text: plan.text, label: plan.label }, onTap);
    },
    [],
  );
}
