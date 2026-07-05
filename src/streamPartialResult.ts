/**
 * Pure helpers for describing a *partial* streaming query result — one that
 * stopped before completing normally because the user cancelled it or the
 * execution timeout fired (#685). Without this, a partial result (fewer rows
 * than the query would actually produce) is indistinguishable in the UI from
 * a complete one, which risks misleading aggregation/export decisions.
 *
 * Kept separate from `App.tsx` so the row-count/reason bookkeeping is unit
 * testable without mounting the app.
 */

export type PartialResultReason = "cancelled" | "timeout";

export interface PartialResult {
  reason: PartialResultReason;
  rows: number;
}

/**
 * Resolves the row count to report for a user-driven cancel. `deliveredRows`
 * is the backend's authoritative count (from `cancelStream`'s return value);
 * it is `null` when the backend reports the stream was no longer running
 * (already finished, or never existed) — in that case fall back to however
 * many rows the grid had already accumulated from `:rows` batches, so the
 * status message always shows *some* count instead of guessing 0.
 */
export function resolveCancelledRows(
  deliveredRows: number | null,
  fallbackRows: number,
): number {
  return deliveredRows ?? fallbackRows;
}

/** Builds the `partialResult` tab field for a user-driven cancel (#685). */
export function cancelledPartialResult(
  deliveredRows: number | null,
  fallbackRows: number,
): PartialResult {
  return { reason: "cancelled", rows: resolveCancelledRows(deliveredRows, fallbackRows) };
}

/**
 * Builds the `partialResult` tab field for an execution-timeout (#685).
 * Unlike cancel, the backend always knows exactly how many rows it had
 * emitted when the timeout fired, so there is no fallback branch here.
 */
export function timeoutPartialResult(deliveredRows: number): PartialResult {
  return { reason: "timeout", rows: deliveredRows };
}
