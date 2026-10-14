/**
 * タブごとの「今のバッチ実行」の streamId を持つ小さな台帳。停止・再実行のあとに届く
 * 古い実行の通知 (結果・終了) が、新しい実行の表示状態を上書きしないための判定に使う (#1594)。
 */
export type BatchRunRegistry = Map<string, string>;

export function beginBatchRun(reg: BatchRunRegistry, tabId: string, streamId: string): void {
  reg.set(tabId, streamId);
}

export function isCurrentBatchRun(reg: BatchRunRegistry, tabId: string, streamId: string): boolean {
  return reg.get(tabId) === streamId;
}

export function endBatchRun(reg: BatchRunRegistry, tabId: string): void {
  reg.delete(tabId);
}
