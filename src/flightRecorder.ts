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
 */
export function isSingleCapturableStatement(sql: string): boolean {
  const statements = splitSqlStatements(sql).filter((s) => s.trim().length > 0);
  if (statements.length !== 1) return false;
  const masked = maskLiterals(statements[0]).trim().toLowerCase();
  return /^(insert|update|delete)\b/.test(masked);
}
