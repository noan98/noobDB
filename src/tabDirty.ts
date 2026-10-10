// タブの dirty (未確定の変更あり) 判定の純ロジック (#1391)。
//
// dirty には 2 種類ある。
//  - SQL 乖離: query タブで、エディタ本文が最後に実行した SQL と違う (従来からの ●)。
//  - 未確定の編集: インラインセル編集 (pendingEdits / pendingDeletes / pendingInserts) が
//    Apply されずメモリに残っている。永続化されず、閉じたタブ復元でも戻らないので、
//    閉じる・接続切替で無警告に消えると回復できない。TabBar の ● とクローズ確認で使う。

import type { PendingEdits } from "./components/cellEdit";

/** 判定に必要な最小のタブ形 (App.tsx の `Tab` と循環 import しないため構造的に受ける)。 */
export interface DirtyTabLike {
  kind: string;
  lastExecutedSql?: string | null;
  pendingEdits: PendingEdits;
  pendingDeletes?: readonly string[];
  pendingInserts?: readonly unknown[];
}

/** Apply 前のセル編集 / 削除予定 / 追加予定のいずれかが残っているか。 */
export function hasPendingChanges(
  tab: Pick<DirtyTabLike, "pendingEdits" | "pendingDeletes" | "pendingInserts">,
): boolean {
  if ((tab.pendingDeletes?.length ?? 0) > 0) return true;
  if ((tab.pendingInserts?.length ?? 0) > 0) return true;
  for (const row of Object.values(tab.pendingEdits ?? {})) {
    if (Object.keys(row).length > 0) return true;
  }
  return false;
}

/**
 * TabBar の ● を出すか。`currentSql` はエディタの最新本文 (`TabSqlStore.resolve`)。
 * query タブは SQL 乖離でも、どの種類のタブでも未確定の編集があれば dirty。
 */
export function isTabDirty(tab: DirtyTabLike, currentSql: string): boolean {
  if (tab.kind === "query" && currentSql !== tab.lastExecutedSql) return true;
  return hasPendingChanges(tab);
}

/** 未確定の編集 (SQL 乖離は含めない) を持つタブだけを返す。クローズ・切断の確認対象。 */
export function tabsWithPendingChanges<T extends DirtyTabLike>(tabs: readonly T[]): T[] {
  return tabs.filter((tt) => hasPendingChanges(tt));
}

/** タブを閉じる前に必要な手続き。 */
export type CloseGuard<T> =
  | { kind: "ok" }
  /** Apply 実行中のタブが含まれる。トランザクション中なので閉じるのを保留する。 */
  | { kind: "applying" }
  /** 未確定の編集を持つタブがある。確認が必要。 */
  | { kind: "confirm"; pending: T[] };

/** `ids` のタブを閉じてよいか / 確認が要るか / 保留すべきかを返す (存在しない ID は無視)。 */
export function closeGuard<T extends DirtyTabLike & { id: string; applyingEdits?: boolean }>(
  tabs: readonly T[],
  ids: readonly string[],
): CloseGuard<T> {
  const targets = tabs.filter((tt) => ids.includes(tt.id));
  if (targets.some((tt) => tt.applyingEdits)) return { kind: "applying" };
  const pending = tabsWithPendingChanges(targets);
  return pending.length > 0 ? { kind: "confirm", pending } : { kind: "ok" };
}
