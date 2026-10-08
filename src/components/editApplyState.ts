/**
 * 一括適用 (Apply) が成功した後のタブ状態の遷移 (純関数)。
 *
 * App の `applyEditsForTab` から切り出した。2 通りある:
 * - 全体適用 (`scoped: false`): 送った保留編集・削除予定・新規行をすべて消費し、
 *   取り消し履歴も空にする (従来どおり)。
 * - 行スコープ適用 (`scoped: true`、行インスペクタ #1394): 送ったのはその行のセル編集
 *   だけ。ほかの保留編集・削除予定・新規行・取り消し/やり直し履歴は残す。削除予定の
 *   行はまだ削除されていないので、表示からも消さない。
 */
import type { CellValue, Column } from "../api/tauri";
import { applyEditsToRows, type PendingEdits, type PendingInsertRow } from "./cellEdit";

/** 適用後に表示用の結果行を持つ最小形 (`QueryResult` の該当部分)。 */
export interface ApplyResultLike {
  columns: Column[];
  rows: CellValue[][];
  rows_affected: number;
}

// Apply 完了後、実際に DB へ送信・コミットされたセル編集 (`applied`) だけを
// `current` の pendingEdits から取り除く。Apply の往復中に追加/上書きされた
// 編集 (= `applied` に無いか、値が食い違うもの) はまだ DB 未送信なので保持し、
// 「未送信の編集が黙ってコミット済み扱いになる」事故 (#F2) を防ぐ。
export function pendingEditsAfterApply(current: PendingEdits, applied: PendingEdits): PendingEdits {
  const next: PendingEdits = {};
  for (const rowKey of Object.keys(current)) {
    const currentRow = current[rowKey];
    const appliedRow = applied[rowKey];
    if (!appliedRow) {
      next[rowKey] = currentRow;
      continue;
    }
    const remainingRow: Record<number, string> = {};
    for (const colKey of Object.keys(currentRow)) {
      const colIdx = Number(colKey);
      // 送信した値のままなら反映済みなので削除。Apply 中にさらに書き換えられて
      // いれば (値が食い違う)、まだ未送信の新しい編集として残す。
      if (appliedRow[colIdx] !== undefined && currentRow[colIdx] === appliedRow[colIdx]) {
        continue;
      }
      remainingRow[colIdx] = currentRow[colIdx];
    }
    if (Object.keys(remainingRow).length > 0) next[rowKey] = remainingRow;
  }
  return next;
}

/** 適用に関わるタブ状態の最小形。 */
export interface ApplyTabState<R extends ApplyResultLike = ApplyResultLike> {
  result: R | null;
  pendingEdits: PendingEdits;
  pendingDeletes?: string[];
  pendingInserts?: PendingInsertRow[];
  editUndoStack?: PendingEdits[];
  editRedoStack?: PendingEdits[];
}

export interface ApplyTransition {
  /** 送った行 (rowEditKey) の pk 列インデックス。結果行の更新に使う。 */
  pkIndices: number[];
  /** 実際に送った保留編集 (適用時のスナップショット)。 */
  sent: PendingEdits;
  /** true なら行スコープ適用 (他の保留は残す)。 */
  scoped: boolean;
}

/**
 * 適用成功後のタブ状態を返す。`result` が無いタブ (プレビュー中など) では表示行は
 * 触らず、保留編集だけを更新する。戻り値は `preview` を含まない部分状態で、呼び出し側が
 * `preview: null` 等の UI 状態を足す。
 */
export function tabStateAfterApply<T extends ApplyTabState>(
  tt: T,
  transition: ApplyTransition,
): T & { pendingDeletes: string[]; pendingInserts: PendingInsertRow[] } {
  const { pkIndices, sent, scoped } = transition;
  // 行スコープ適用では削除予定・新規行・取り消し履歴は送っていないので保つ。
  const keepOps = scoped
    ? { pendingDeletes: tt.pendingDeletes ?? [], pendingInserts: tt.pendingInserts ?? [] }
    : { pendingDeletes: [], pendingInserts: [] };
  const keepUndo = scoped
    ? { editUndoStack: tt.editUndoStack ?? [], editRedoStack: tt.editRedoStack ?? [] }
    : { editUndoStack: [], editRedoStack: [] };
  const nextPending = pendingEditsAfterApply(tt.pendingEdits, sent);
  if (!tt.result) {
    return { ...tt, pendingEdits: nextPending, ...keepUndo, ...keepOps };
  }
  const nextRows = applyEditsToRows({
    columns: tt.result.columns,
    rows: tt.result.rows,
    pkIndices,
    edits: sent,
    deleteKeys: new Set(scoped ? [] : (tt.pendingDeletes ?? [])),
  });
  return {
    ...tt,
    result: { ...tt.result, rows: nextRows, rows_affected: nextRows.length },
    pendingEdits: nextPending,
    ...keepUndo,
    ...keepOps,
  };
}
