// デッドロック解析 (#2328) の純ロジック。副作用なし。
//
// エラーの判別・待機の循環の並べ方・理由コードの文言キーを描画から切り離し、Vitest で固定する。
// サーバから返る報告そのものの解析 (InnoDB STATUS / 40P01 の DETAIL) は Rust 側の純関数が担う。

import type { InnodbLock, InnodbTransaction, SqliteBusyView } from "../api/tauri";
import type { I18nKey } from "../i18n";

/** エラーが指す競合の種類。`deadlock` は循環で巻き戻された、`busy` は SQLite のロック待ち。 */
export type LockErrorKind = "deadlock" | "busy";

/**
 * エラー文からデッドロック / SQLite のロック競合を見分ける。
 * - MySQL: エラー 1213 (`Deadlock found when trying to get lock`)
 * - PostgreSQL: SQLSTATE 40P01 (`deadlock detected`)
 * - SQLite: `SQLITE_BUSY` / `database is locked` (SQLITE_LOCKED の `database table is locked` も含む)
 * ドライバが違う文言には反応しない (SQLite に `deadlock` は出ない)。
 */
export function classifyLockError(driver: string, message: string): LockErrorKind | null {
  if (!message) return null;
  if (driver === "mysql") {
    return /\b1213 \(40001\)|ERROR 1213\b|Deadlock found when trying to get lock/i.test(message)
      ? "deadlock"
      : null;
  }
  if (driver === "postgres") {
    return /\b40P01\b|deadlock detected/i.test(message) ? "deadlock" : null;
  }
  if (driver === "sqlite") {
    return /database (?:table )?is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(message) ? "busy" : null;
  }
  return null;
}

/**
 * `next` (ノード → 待っている相手) をたどり、`start` から出発して同じノードへ戻るまでの並びを返す
 * (`[1, 2, 1]` のように先頭のノードを末尾にも置く)。循環に戻らない (相手が無い / 行き止まり) ときは
 * たどれた範囲を返す。相手が複数あるときは最初の相手を採る。
 */
export function followWaitCycle<T>(start: T, next: ReadonlyMap<T, readonly T[]>): T[] {
  const path: T[] = [start];
  const seen = new Set<T>([start]);
  let cur = start;
  for (;;) {
    const n = next.get(cur)?.[0];
    if (n === undefined) return path;
    path.push(n);
    if (seen.has(n)) return path;
    seen.add(n);
    cur = n;
  }
}

/** InnoDB の報告から、トランザクションの待機の循環 (label の並び) を作る。 */
export function innodbCycle(txns: readonly InnodbTransaction[]): number[] {
  const first = txns[0];
  if (!first) return [];
  const next = new Map(txns.map((t) => [t.label, t.waits_on] as const));
  return followWaitCycle(first.label, next);
}

/** PostgreSQL の待機の辺から、エラーを受けた側 (先頭の待機側) を起点にした pid の循環を作る。 */
export function pgCycle(edges: readonly { waiter_pid: number; blocker_pid: number }[]): number[] {
  const first = edges[0];
  if (!first) return [];
  const next = new Map<number, number[]>();
  for (const e of edges) next.set(e.waiter_pid, [...(next.get(e.waiter_pid) ?? []), e.blocker_pid]);
  return followWaitCycle(first.waiter_pid, next);
}

/** ロック 1 件の 1 行表示 (`X locks rec but not gap on bank.accounts (PRIMARY), heap no 3`)。 */
export function lockSummary(lock: InnodbLock): { mode: string; target: string } {
  const table = lock.table ?? "?";
  const target = lock.index ? `${table} (${lock.index})` : table;
  return { mode: lock.mode ?? lock.kind, target: lock.record ? `${target}, ${lock.record}` : target };
}

/** 最新の報告と今回のエラーの関係 (Rust の `relation`) → 注記の文言キー。 */
export function relationNoticeKey(relation: string | null): I18nKey {
  switch (relation) {
    case "related":
      return "deadlockRelationRelated";
    case "older":
      return "deadlockRelationOlder";
    case "newer":
      return "deadlockRelationNewer";
    default:
      // 時刻が読めない / エラーの経過が不明なときは判定できない旨を出す。
      return "deadlockRelationUnknown";
  }
}

/** 別件の可能性がある関係か (注記を警告にする)。 */
export function relationIsMismatch(relation: string | null): boolean {
  return relation === "older" || relation === "newer";
}

/** 解析できなかった理由コード → 文言キー。未知のコードは汎用の文言にする。 */
export function unavailableKey(code: string): I18nKey {
  switch (code) {
    case "needs_process_privilege":
      return "deadlockUnavailableNeedsProcess";
    case "no_report":
      return "deadlockUnavailableNoReport";
    case "no_detail":
      return "deadlockUnavailableNoDetail";
    default:
      return "deadlockUnavailableUnknown";
  }
}

/** SQLite の切り分けで、利用者に出す所見のキー (順序は優先度順)。 */
export type SqliteBusyHint = "journalNotWal" | "noBusyTimeout" | "holders" | "noHolders";

export function sqliteBusyHints(view: SqliteBusyView): SqliteBusyHint[] {
  const out: SqliteBusyHint[] = [];
  if (view.journal_mode != null && view.journal_mode !== "wal") out.push("journalNotWal");
  if (view.busy_timeout_ms === 0) out.push("noBusyTimeout");
  out.push(view.holders.length > 0 ? "holders" : "noHolders");
  return out;
}

/** エラーが返ってからの経過秒 (整数、負は 0)。 */
export function errorAgeSecs(errorAtMs: number | null, nowMs: number): number | null {
  if (errorAtMs == null) return null;
  return Math.max(0, Math.round((nowMs - errorAtMs) / 1000));
}
