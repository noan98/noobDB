/**
 * Pure logic behind the history panel's status/period filters (#822).
 *
 * Kept separate from `HistoryList.tsx` so the date-math and status mapping
 * (the only parts worth unit testing) don't require mounting the component.
 * The panel calls these to turn the two segmented-control selections into the
 * `status`/`from`/`to` params `api.listHistory` forwards to the backend.
 */

export type HistoryStatusFilter = "all" | "ok" | "error";
export type HistoryPeriodFilter = "all" | "today" | "7d";

export const HISTORY_STATUS_FILTERS: HistoryStatusFilter[] = ["all", "ok", "error"];
export const HISTORY_PERIOD_FILTERS: HistoryPeriodFilter[] = ["all", "today", "7d"];

/** Maps the status filter to the `status` param, or `null` for "all". */
export function historyStatusParam(filter: HistoryStatusFilter): string | null {
  return filter === "all" ? null : filter;
}

/**
 * Maps the period filter to inclusive `from`/`to` RFC3339 bounds, or
 * `{ from: null, to: null }` for "all" (no bound). `now` is injectable for
 * tests; defaults to the current time.
 *
 * "today" starts at local midnight (matches how a user thinks about "today"
 * even though `executed_at` is stored in UTC — the comparison still works
 * because both sides are RFC3339 instants). "7d" is a rolling 7*24h window,
 * not calendar-aligned.
 */
export function historyPeriodRange(
  filter: HistoryPeriodFilter,
  now: Date = new Date(),
): { from: string | null; to: string | null } {
  if (filter === "all") return { from: null, to: null };
  if (filter === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { from: start.toISOString(), to: null };
  }
  const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { from: start.toISOString(), to: null };
}
