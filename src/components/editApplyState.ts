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
import type { BulkWriteOptions, BulkWriteOutcome, CellValue, Column } from "../api/tauri";
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
  /**
   * 実際に送った削除予定 (rowEditKey) と新規行。Apply の往復中に追加された分は未送信
   * なので残すために使う。省略時 (全体適用) は現在の保留をすべて消費する。
   */
  sentDeletes?: string[];
  sentInserts?: PendingInsertRow[];
}

/** `sent` に含まれるもの (参照一致) を `current` から除いた残りを返す。 */
export function remainingAfterSent<T>(current: T[], sent: T[] | undefined): T[] {
  if (sent === undefined) return [];
  const sentSet = new Set(sent);
  return current.filter((x) => !sentSet.has(x));
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
  const { pkIndices, sent, scoped, sentDeletes, sentInserts } = transition;
  // 行スコープ適用では削除予定・新規行・取り消し履歴は送っていないので保つ。
  // 全体適用でも、Apply の往復中に追加された削除予定・新規行は未送信なので残す。
  const keepOps = scoped
    ? { pendingDeletes: tt.pendingDeletes ?? [], pendingInserts: tt.pendingInserts ?? [] }
    : {
        pendingDeletes: remainingAfterSent(tt.pendingDeletes ?? [], sentDeletes),
        pendingInserts: remainingAfterSent(tt.pendingInserts ?? [], sentInserts),
      };
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
    deleteKeys: new Set(scoped ? [] : (sentDeletes ?? tt.pendingDeletes ?? [])),
  });
  return {
    ...tt,
    result: { ...tt.result, rows: nextRows, rows_affected: nextRows.length },
    pendingEdits: nextPending,
    ...keepUndo,
    ...keepOps,
  };
}

/**
 * Apply (`bulk_update_cells`) が期待した件数より少ない行しか書き換えなかった数。
 * 編集行・削除行・新規行はどれも「1 行 = 1 件」なので、`expected` は操作行の合計。
 * 3 ドライバとも `rows_affected` は一致した行数 (MySQL は FOUND_ROWS 相当) を返すため、
 * 値が変わらない更新でも不足とは数えない。0 以下なら不足なし (トリガ等で多い場合も含む)。
 * 正の値は、別クライアントによる削除・主キー変更などで行が見つからなかったことを示す。
 */
export function appliedRowShortfall(expected: number, affected: number): number {
  return Math.max(0, expected - affected);
}

/** 承認して再実行しても超過が続くとき、確認を繰り返す上限 (超えたら適用せず止める)。 */
export const MAX_OVERSHOOT_CONFIRMATIONS = 3;

/** `applyWithRowCountGuard` の結果。 */
export type GuardedApplyResult =
  /** コミットした。 */
  | { kind: "applied"; totalAffected: number }
  /** 適用していない (キャンセル / 承認後も超過が続いて確認の上限に達した)。DB は未変更。 */
  | { kind: "not_applied"; expected: number; actual: number; total: number }
  /** ロールバックが不完全 (MyISAM など)。書き込みの一部が残っている。再実行しない。 */
  | { kind: "rollback_incomplete"; expected: number; actual: number };

/**
 * `bulk_update_cells` を実行し、想定行数の超過 (`row_count_exceeded`、#1777) なら確認を取って
 * 承認した件数つきで再実行する。承認は文ごとの件数 (`statement_counts`) なので、確認の間に
 * さらに増えれば (別の文の減少で相殺されず) 再び超過になり、新しい件数で確認し直す (最大 `MAX_OVERSHOOT_CONFIRMATIONS` 回)。
 * `rollback_incomplete` は再実行せずそのまま返す。確認の前後に `onAwaitingConfirm` /
 * `onResume` を呼ぶ (状態バー表示と二重 Apply の防止用)。
 */
export async function applyWithRowCountGuard(input: {
  run: (options?: BulkWriteOptions) => Promise<BulkWriteOutcome>;
  confirmExceeded: (counts: { expected: number; actual: number; total: number }) => Promise<boolean>;
  onAwaitingConfirm?: () => void;
  onResume?: () => void;
}): Promise<GuardedApplyResult> {
  let options: BulkWriteOptions | undefined;
  for (let confirmations = 0; ; confirmations++) {
    const res = await input.run(options);
    if (res.status === "applied") {
      return { kind: "applied", totalAffected: Number(res.result.rows_affected ?? 0) };
    }
    if (res.status === "rollback_incomplete") {
      return { kind: "rollback_incomplete", expected: res.expected_rows, actual: res.actual_rows };
    }
    const counts = { expected: res.expected_rows, actual: res.actual_rows, total: res.batch_total_rows };
    if (confirmations >= MAX_OVERSHOOT_CONFIRMATIONS) return { kind: "not_applied", ...counts };
    input.onAwaitingConfirm?.();
    let ok = false;
    try {
      ok = await input.confirmExceeded(counts);
    } finally {
      input.onResume?.();
    }
    if (!ok) return { kind: "not_applied", ...counts };
    options = { approvedCounts: res.statement_counts };
  }
}
