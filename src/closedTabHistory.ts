/**
 * 「最近閉じたタブ」履歴 (#1353) の純ロジック。副作用なし。
 *
 * 閉じたタブのスナップショットを直近 N 件だけメモリに保持し、Cmd/Ctrl+Shift+T や
 * コマンドパレットから戻せるようにする。スナップショットの中身 (`Tab` 丸ごと) には
 * 関知せず、ジェネリクス `T` として運ぶだけにする — `Tab` に項目が増えても
 * (例: タブ名の手動変更フラグ) この層を触らずに引き継がれる。
 *
 * 「他を閉じる / 右側を閉じる / すべて閉じる」の一括クローズは 1 つのグループとして
 * 積み、1 回の復元でまとめて元の並びに戻す。単独クローズは 1 件のグループ。
 */

/** 履歴に保持するタブ数の上限 (グループ内の件数を合算して数える)。 */
export const CLOSED_TAB_HISTORY_LIMIT = 20;

/** 閉じたタブ 1 枚分。`paneId` / `index` は閉じる直前の位置 (復元先の手がかり)。 */
export interface ClosedTabEntry<T> {
  snapshot: T;
  paneId: string;
  /** 閉じる前のペイン内での位置 (0 始まり)。 */
  index: number;
}

/** 1 回の「閉じる」操作で閉じたタブの束 (一括クローズなら複数)。 */
export interface ClosedTabGroup<T> {
  id: string;
  entries: ClosedTabEntry<T>[];
}

/** 新しいグループが先頭 (index 0) の履歴。 */
export type ClosedTabHistory<T> = readonly ClosedTabGroup<T>[];

/** 履歴全体のタブ数。 */
export function closedTabCount<T>(history: ClosedTabHistory<T>): number {
  return history.reduce((n, g) => n + g.entries.length, 0);
}

/**
 * `group` を履歴の先頭へ積み、合計が `limit` 枚を超える分は古いグループから捨てる。
 * 空グループは積まない。最新グループ単体が `limit` を超えるときは先頭 `limit` 枚
 * (タブバー上の左側) だけ残す。
 */
export function pushClosedGroup<T>(
  history: ClosedTabHistory<T>,
  group: ClosedTabGroup<T>,
  limit: number = CLOSED_TAB_HISTORY_LIMIT,
): ClosedTabHistory<T> {
  if (group.entries.length === 0 || limit <= 0) return history;
  const head: ClosedTabGroup<T> =
    group.entries.length > limit ? { ...group, entries: group.entries.slice(0, limit) } : group;
  const out: ClosedTabGroup<T>[] = [head];
  let total = head.entries.length;
  for (const g of history) {
    if (total + g.entries.length > limit) break;
    out.push(g);
    total += g.entries.length;
  }
  return out;
}

/**
 * グループを 1 つ取り出す。`groupId` を省略すると最新。見つからなければ `group` は null
 * で履歴は変わらない。
 */
export function popClosedGroup<T>(
  history: ClosedTabHistory<T>,
  groupId?: string,
): { group: ClosedTabGroup<T> | null; history: ClosedTabHistory<T> } {
  const idx = groupId === undefined ? 0 : history.findIndex((g) => g.id === groupId);
  if (idx < 0 || idx >= history.length) return { group: null, history };
  return { group: history[idx], history: history.filter((_, i) => i !== idx) };
}

/**
 * 復元の順序。ペインごとに元の位置 (小さい順) で挿入すると、一括クローズの並びが
 * そのまま戻る。同じ位置同士は閉じた順を保つ (安定ソート)。
 */
export function orderForRestore<T>(entries: readonly ClosedTabEntry<T>[]): ClosedTabEntry<T>[] {
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.index - b.e.index || a.i - b.i)
    .map((x) => x.e);
}

/** 復元先ペイン: 元のペインが残っていればそこ、無ければアクティブペイン、それも無ければ先頭。 */
export function resolveRestorePaneId(
  paneIds: readonly string[],
  originalPaneId: string,
  activePaneId: string | null,
): string | null {
  if (paneIds.includes(originalPaneId)) return originalPaneId;
  if (activePaneId !== null && paneIds.includes(activePaneId)) return activePaneId;
  return paneIds[0] ?? null;
}

/** `tabIds` の `index` 位置 (範囲外は端に丸める) へ `id` を挿入した新しい配列。 */
export function insertTabIdAt(tabIds: readonly string[], index: number, id: string): string[] {
  const at = Math.min(Math.max(0, Math.trunc(index) || 0), tabIds.length);
  return [...tabIds.slice(0, at), id, ...tabIds.slice(at)];
}

/**
 * 履歴に残す価値があるか。中身のない新規クエリ/EXPLAIN タブ (SQL が空白だけ) は
 * 閉じても失うものが無く、Cmd+T → Cmd+W の往復で履歴が空タブに埋まるのを避けるため
 * 積まない。テーブルタブは (再オープンで開き直せるので) 常に積む。
 */
export function shouldRememberClosedTab(tab: { kind: string; sql: string }): boolean {
  if (tab.kind === "table") return true;
  return tab.sql.trim().length > 0;
}

/** パレット等に出すグループの要約: 先頭タブのタイトルと、それ以外の枚数。 */
export function summarizeClosedGroup<T>(
  group: ClosedTabGroup<T>,
  titleOf: (snapshot: T) => string,
): { title: string; extra: number } {
  const first = orderForRestore(group.entries)[0];
  return { title: first ? titleOf(first.snapshot) : "", extra: Math.max(0, group.entries.length - 1) };
}

/** `sanitizeClosedTabSnapshot` が既定値へ戻すフィールドの形 (`Tab` の部分集合)。 */
export interface ClosedTabVolatileFields {
  result: unknown;
  preview: unknown;
  streaming: boolean;
  previewStreaming: boolean;
  loadingMore: boolean;
  canLoadMore: boolean;
  autoLimitApplied: number | null;
  autoLimitSql: string | null;
  queryError: string | null;
  pendingEdits: Record<string, unknown>;
  editUndoStack: unknown[];
  editRedoStack: unknown[];
}

/**
 * 閉じたタブのスナップショットから、実行中フラグ・結果・未確定編集・差分用の前回結果を
 * 取り除く。復元後に「実行中のまま止まる」(例: `batchRunning: true` が再実行ガードに
 * 掛かる) ことや、最大 20 タブ分の結果行がメモリに残ることを防ぐ。
 *
 * 除外リスト方式: 列挙したものだけを既定値に戻し、それ以外 (タイトル・手動命名フラグ・
 * SQL・DB・ビルダー状態など) は丸ごと引き継ぐ。`Tab` に項目が増えても、結果や実行状態
 * でない限りこの関数を触らずに復元対象になる。
 */
export function sanitizeClosedTabSnapshot<T extends ClosedTabVolatileFields>(tab: T): T {
  return {
    ...tab,
    result: null,
    preview: null,
    streaming: false,
    previewStreaming: false,
    loadingMore: false,
    canLoadMore: false,
    autoLimitApplied: null,
    autoLimitSql: null,
    queryError: null,
    pendingEdits: {},
    editUndoStack: [],
    editRedoStack: [],
    // 以下は省略可能な項目。undefined / 既定値に戻す (キー自体は残して上書きを保証する)。
    pendingDeletes: undefined,
    pendingInserts: undefined,
    previewPrevPaginatable: undefined,
    batchResults: undefined,
    batchScript: undefined,
    batchRunning: false,
    applyingEdits: false,
    lastEditAppliedAt: undefined,
    autoRefreshSecs: null,
    autoRefreshLastRunAt: null,
    prevResultRows: null,
    prevResultSql: null,
    diffHighlight: false,
    partialResult: null,
    explainSourceSql: undefined,
  };
}
