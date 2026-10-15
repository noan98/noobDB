import { maskLiterals } from "./dangerousSql";
import { splitSqlStatements } from "./sqlScript";

/**
 * Best-effort, frontend-side heuristic for "should we ask the backend to
 * attempt DML flight-recorder capture for this run?" (#735). Intentionally
 * loose — the backend's `classify_write_kind` is the authoritative gate and
 * silently declines capture for anything it can't actually resolve a target
 * table/primary key for, so a false positive here only costs one harmless
 * extra dry-run round trip inside `capture_write`, never a correctness or
 * safety issue. A false negative just means a write that could have been
 * captured runs uncaptured, which is no worse than the feature being off.
 *
 * Scoped to a single INSERT/UPDATE/DELETE statement — a multi-statement
 * script or anything else (SELECT, DDL, ...) returns `false`.
 *
 * `driver` selects the string-escaping rules used by the statement splitter
 * and mask (#852, #1004). Omit it only where the driver is genuinely unknown;
 * the fallback is the stricter non-MySQL reading.
 */
export function isSingleCapturableStatement(sql: string, driver?: string): boolean {
  const statements = splitSqlStatements(sql, driver).filter((s) => s.trim().length > 0);
  if (statements.length !== 1) return false;
  const masked = maskLiterals(statements[0], driver).trim().toLowerCase();
  return /^(insert|update|delete)\b/.test(masked);
}

/**
 * 複数文のスクリプトに含まれる、記録の対象になりうる文 (INSERT / UPDATE / DELETE) の数 (#1626)。
 * エディタのバッチ実行は、1 文でもあれば `capture` を有効にして実行する — 記録できるかの最終判定は
 * 文ごとにバックエンド (`classify_write_kind`) が行い、対象外の文は記録なしで実行される。
 */
export function countCapturableStatements(sql: string, driver?: string): number {
  return splitSqlStatements(sql, driver).filter((s) => {
    if (s.trim().length === 0) return false;
    return /^(insert|update|delete)\b/.test(maskLiterals(s, driver).trim().toLowerCase());
  }).length;
}

/**
 * 複数文スクリプトの実行で、記録できた文と記録できなかった文の数 (#1626)。バッチの取り消し確認で
 * 「スクリプト実行前には完全に戻らない」ことを注記するために、実行完了時にバッチ id ごとに
 * 控える。メモリ上だけの控えなので、アプリを再起動した後は分からない (注記が出ないだけ)。
 */
const batchCaptureStats = new Map<string, { captured: number; skipped: number }>();
const MAX_BATCH_STATS = 200;

export function noteBatchCaptureStats(
  batchId: string | null | undefined,
  captured: number,
  skipped: number,
): void {
  if (!batchId) return;
  batchCaptureStats.delete(batchId);
  batchCaptureStats.set(batchId, { captured, skipped });
  while (batchCaptureStats.size > MAX_BATCH_STATS) {
    const oldest = batchCaptureStats.keys().next().value;
    if (oldest === undefined) break;
    batchCaptureStats.delete(oldest);
  }
}

/**
 * バッチの取り消しで元に戻せない部分があるか。記録できなかった文がある、または記録の一部が
 * 保持上限などで消えている (記録できた数より、いま取り消せる記録が少ない) とき真。
 */
export function batchUndoIsPartial(batchId: string, recordCount: number): boolean {
  const stats = batchCaptureStats.get(batchId);
  if (!stats) return false;
  return stats.skipped > 0 || recordCount < stats.captured;
}
