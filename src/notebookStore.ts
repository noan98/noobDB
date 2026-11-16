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
  /** 文書そのものの世代。新規 / 読み込みで入れ替えるたびに進む (保存完了の突き合わせ用)。 */
  epoch: number;
  /** 編集のたびに進む版。保存開始時の版と完了時の版が違えば、保存中に編集された。 */
  revision: number;
}

let state: NotebookState = {
  doc: createEmptyNotebook(),
  filePath: null,
  dirty: false,
  epoch: 0,
  revision: 0,
};
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
  emit({ ...state, doc: fn(state.doc), dirty: true, revision: state.revision + 1 });
}

/** 新規 / 読み込みで文書ごと入れ替える。 */
export function replaceNotebook(doc: NotebookDoc, filePath: string | null): void {
  emit({ doc, filePath, dirty: false, epoch: state.epoch + 1, revision: state.revision + 1 });
}

/**
 * 保存が済んだ。`saved` は保存を始めた時点の `epoch` / `revision`。
 * - 文書が入れ替わっていた (新規 / 読み込み) なら何もしない (古いパスを新しい文書へ付けない)。
 * - 同じ文書でも保存中に編集されていたら、保存先だけ記録して dirty のままにする (未保存の変更を消さない)。
 */
export function markNotebookSaved(filePath: string, saved: { epoch: number; revision: number }): void {
  if (saved.epoch !== state.epoch) return;
  if (saved.revision !== state.revision) {
    emit({ ...state, filePath });
    return;
  }
  emit({ ...state, filePath, dirty: false });
}
