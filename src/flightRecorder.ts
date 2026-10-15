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
