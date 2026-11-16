/**
 * SQL ノートブック (#2380) の現在の文書を持つ小さなストア。
 *
 * 画面 (`NotebookView`) は keep-alive の上限で捨てられることがあるので、未保存の編集が画面と一緒に
 * 消えないよう、文書そのものはモジュール側に置く (`tabDragStore.ts` などと同じ形)。
 */
import { useSyncExternalStore } from "react";
import { createEmptyNotebook, type NotebookDoc } from "./notebook";

export interface NotebookState {
  doc: NotebookDoc;
  /** 保存先 (`.noobnb`)。未保存なら null。 */
  filePath: string | null;
  /** 最後の保存 / 読み込み以降に編集した。 */
  dirty: boolean;
}

let state: NotebookState = { doc: createEmptyNotebook(), filePath: null, dirty: false };
const listeners = new Set<() => void>();

function emit(next: NotebookState): void {
  state = next;
  for (const l of listeners) l();
}

export function getNotebookState(): NotebookState {
  return state;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useNotebookState(): NotebookState {
  return useSyncExternalStore(subscribe, getNotebookState, getNotebookState);
}

/** 編集として文書を更新する (未保存になる)。 */
export function updateNotebook(fn: (doc: NotebookDoc) => NotebookDoc): void {
  emit({ ...state, doc: fn(state.doc), dirty: true });
}

/** 新規 / 読み込みで文書ごと入れ替える。 */
export function replaceNotebook(doc: NotebookDoc, filePath: string | null): void {
  emit({ doc, filePath, dirty: false });
}

/** 保存が済んだ。 */
export function markNotebookSaved(filePath: string): void {
  emit({ ...state, filePath, dirty: false });
}
