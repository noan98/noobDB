import { useCallback, useRef, useSyncExternalStore, type RefCallback } from "react";
import {
  attachTreeDragSource,
  getTreeDragSnapshot,
  subscribeTreeDrag,
  type TreeDragSnapshot,
} from "./treeDragStore";
import type { TreeDragItem } from "./treeDragInsert";

/**
 * ツリー行 (テーブル / 列) をエディタへのドラッグ元にする ref コールバック (#1414)。
 * 行要素の `ref` に渡す。`item` は毎レンダー最新を参照する (ref 経由なので再アタッチ不要)。
 */
export function useTreeDragSource(item: TreeDragItem): RefCallback<HTMLElement> {
  const itemRef = useRef(item);
  itemRef.current = item;
  return useCallback((el: HTMLElement | null) => {
    if (!el) return;
    return attachTreeDragSource(el, () => itemRef.current);
  }, []);
}

/** ゴースト描画用にドラッグ状態を購読する。 */
export function useTreeDragSnapshot(): TreeDragSnapshot {
  return useSyncExternalStore(subscribeTreeDrag, getTreeDragSnapshot, getTreeDragSnapshot);
}
