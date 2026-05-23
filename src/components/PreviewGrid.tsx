import { useEffect, useMemo, useRef, useState } from "react";
import { CellValue, PreviewResult } from "../api/tauri";
import { useT } from "../i18n";
import { DataGrid } from "./ResultGrid";
import { Splitter } from "./Splitter";

const SYNC_SCROLL_STORAGE_KEY = "noobdb.preview.syncScroll";

function readSyncScrollPref(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const v = window.localStorage.getItem(SYNC_SCROLL_STORAGE_KEY);
    if (v === null) return true;
    return v === "1";
  } catch {
    return true;
  }
}

function writeSyncScrollPref(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SYNC_SCROLL_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // ignore (private mode, quota, etc.)
  }
}

interface Props {
  result: PreviewResult;
  rowLimit: number;
  /** True while preview snapshot rows are still arriving via the stream. */
  streaming?: boolean;
  /**
   * When set, the preview pane surfaces an "Apply / Discard" pill so the
   * user can commit the inline cell edits that triggered the preview
   * without having to find their way back to the result grid. Provided by
   * App for table tabs whose `pendingEdits` map is non-empty.
   */
  pendingEditsSummary?: { cells: number; rows: number };
  onApplyEdits?: () => void;
  onDiscardEdits?: () => void;
}

interface Diff {
  // changedCells[i][j] is true when before_rows[i] and the paired after row
  // differ on column j. Indexed by the original BEFORE row position.
  beforeChanges: boolean[][];
  // Same shape, indexed by original AFTER row position.
  afterChanges: boolean[][];
  // True for column j if any paired row differs on that column.
  changedColumns: boolean[];
  // BEFORE row indices that are "affected": changed vs. their AFTER pair, or
  // unpaired (i.e. about to be deleted by the statement).
  affectedBefore: number[];
  // AFTER row indices that are "affected": changed vs. their BEFORE pair, or
  // unpaired (i.e. newly inserted by the statement).
  affectedAfter: number[];
}

function valuesEqual(a: CellValue, b: CellValue): boolean {
  if (a === b) return true;
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  // Cross-type compare (e.g. boolean `true` vs string "1") is rare in
  // practice — backend decodes both snapshots with the same column types.
  // Fall back to string comparison so numeric/decimal precision swings or
  // an Int(1) vs Bool(true) round-trip don't show up as spurious diffs.
  return String(a) === String(b);
}

function pkKey(row: CellValue[], pkIndices: number[]): string {
  // JSON gives us a stable, unambiguous join even for composite keys.
  return JSON.stringify(pkIndices.map((i) => row[i] ?? null));
}

function computeDiff(
  columns: number,
  beforeRows: CellValue[][],
  afterRows: CellValue[][],
  pkIndices: number[],
): Diff {
  const beforeChanges = beforeRows.map(() => new Array(columns).fill(false));
  const afterChanges = afterRows.map(() => new Array(columns).fill(false));
  const changedColumns = new Array<boolean>(columns).fill(false);

  // Pair by PK when available; otherwise fall back to positional pairing,
  // which still produces sensible diffs for UPDATEs on tables without a PK
  // because both snapshots use the same `LIMIT` and scan order.
  const pairs: Array<[number, number]> = [];
  const pairedBefore = new Set<number>();
  const pairedAfter = new Set<number>();
  if (pkIndices.length > 0) {
    const afterByPk = new Map<string, number>();
    afterRows.forEach((row, i) => {
      afterByPk.set(pkKey(row, pkIndices), i);
    });
    beforeRows.forEach((row, i) => {
      const k = pkKey(row, pkIndices);
      const j = afterByPk.get(k);
      if (j !== undefined) {
        pairs.push([i, j]);
        pairedBefore.add(i);
        pairedAfter.add(j);
      }
    });
  } else {
    const n = Math.min(beforeRows.length, afterRows.length);
    for (let i = 0; i < n; i++) {
      pairs.push([i, i]);
      pairedBefore.add(i);
      pairedAfter.add(i);
    }
  }

  for (const [bi, ai] of pairs) {
    const bRow = beforeRows[bi];
    const aRow = afterRows[ai];
    for (let c = 0; c < columns; c++) {
      if (!valuesEqual(bRow[c], aRow[c])) {
        beforeChanges[bi][c] = true;
        afterChanges[ai][c] = true;
        changedColumns[c] = true;
      }
    }
  }

  // A BEFORE row is "affected" if it has any changed cell vs. its pair, or
  // if it has no AFTER pair at all — the latter only happens with a PK
  // (positional pairing always pairs same-index rows), and means the row was
  // deleted. Likewise for AFTER (changed or newly inserted).
  const affectedBefore: number[] = [];
  beforeRows.forEach((_, i) => {
    if (!pairedBefore.has(i) || beforeChanges[i].some((c) => c)) {
      affectedBefore.push(i);
    }
  });
  const affectedAfter: number[] = [];
  afterRows.forEach((_, i) => {
    if (!pairedAfter.has(i) || afterChanges[i].some((c) => c)) {
      affectedAfter.push(i);
    }
  });

  return { beforeChanges, afterChanges, changedColumns, affectedBefore, affectedAfter };
}

function pickRows<T>(rows: T[], indices: number[]): T[] {
  return indices.map((i) => rows[i]);
}

export function PreviewGrid({
  result,
  rowLimit,
  streaming,
  pendingEditsSummary,
  onApplyEdits,
  onDiscardEdits,
}: Props) {
  const t = useT();
  const hasSnapshots = result.columns.length > 0;

  const beforeBodyRef = useRef<HTMLDivElement | null>(null);
  const afterBodyRef = useRef<HTMLDivElement | null>(null);
  const [syncScroll, setSyncScroll] = useState<boolean>(() => readSyncScrollPref());

  useEffect(() => {
    if (!syncScroll) return;
    const before = beforeBodyRef.current;
    const after = afterBodyRef.current;
    if (!before || !after) return;

    // Re-entrancy guard: programmatic scrollTop/Left writes fire 'scroll'
    // again on the target. Without this both panes ping-pong forever.
    let syncing = false;
    const mirror = (src: HTMLDivElement, dst: HTMLDivElement) => {
      if (syncing) return;
      syncing = true;
      dst.scrollTop = src.scrollTop;
      dst.scrollLeft = src.scrollLeft;
      // The scroll event from the assignment above is queued, not synchronous,
      // so release the guard after it has a chance to fire.
      requestAnimationFrame(() => {
        syncing = false;
      });
    };
    const onBefore = () => mirror(before, after);
    const onAfter = () => mirror(after, before);
    before.addEventListener("scroll", onBefore, { passive: true });
    after.addEventListener("scroll", onAfter, { passive: true });

    // Align once on enable so the two panes start in sync.
    after.scrollTop = before.scrollTop;
    after.scrollLeft = before.scrollLeft;

    return () => {
      before.removeEventListener("scroll", onBefore);
      after.removeEventListener("scroll", onAfter);
    };
  }, [syncScroll, hasSnapshots]);

  const diff = useMemo<Diff>(() => {
    const pkIndices = result.primary_key
      .map((name) => result.columns.findIndex((c) => c.name === name))
      .filter((i) => i >= 0);
    return computeDiff(
      result.columns.length,
      result.before_rows,
      result.after_rows,
      pkIndices,
    );
  }, [result.columns, result.before_rows, result.after_rows, result.primary_key]);

  // The backend captures a `LIMIT` window of the target table for context;
  // we trim that down here so only the rows the statement actually touches
  // appear in the panes (updated/deleted in BEFORE, updated/inserted in
  // AFTER). When the affected rows fall outside the snapshot window, both
  // panes end up empty and we surface a hint below the meta line.
  const filteredBeforeRows = useMemo(
    () => pickRows(result.before_rows, diff.affectedBefore),
    [result.before_rows, diff.affectedBefore],
  );
  const filteredAfterRows = useMemo(
    () => pickRows(result.after_rows, diff.affectedAfter),
    [result.after_rows, diff.affectedAfter],
  );
  const filteredBeforeChanges = useMemo(
    () => pickRows(diff.beforeChanges, diff.affectedBefore),
    [diff.beforeChanges, diff.affectedBefore],
  );
  const filteredAfterChanges = useMemo(
    () => pickRows(diff.afterChanges, diff.affectedAfter),
    [diff.afterChanges, diff.affectedAfter],
  );

  const noAffectedInSnapshot =
    hasSnapshots &&
    result.rows_affected > 0 &&
    filteredBeforeRows.length === 0 &&
    filteredAfterRows.length === 0;

  return (
    <div className={`preview ${streaming ? "is-streaming" : ""}`}>
      <div className="preview-banner">
        <span className="preview-banner-dot" aria-hidden />
        <span className="preview-banner-text">{t("previewBanner")}</span>
        {pendingEditsSummary && (onApplyEdits || onDiscardEdits) && (
          <div className="preview-edit-actions" role="group">
            <span className="preview-edit-summary">
              {t("editPendingCount", {
                cells: pendingEditsSummary.cells,
                rows: pendingEditsSummary.rows,
              })}
            </span>
            {onApplyEdits && (
              <button
                type="button"
                className="success preview-edit-btn"
                onClick={onApplyEdits}
                disabled={streaming}
                title={t("editApplyButtonTitle")}
              >
                {t("editApplyButton")}
              </button>
            )}
            {onDiscardEdits && (
              <button
                type="button"
                className="preview-edit-btn"
                onClick={onDiscardEdits}
                title={t("editCancelButtonTitle")}
              >
                {t("editCancelButton")}
              </button>
            )}
          </div>
        )}
        {streaming && (
          <span className="preview-banner-streaming">
            {t("statusPreviewStreaming", { ms: result.elapsed_ms })}
          </span>
        )}
      </div>
      <div className="preview-meta">
        {result.target_table ? (
          <span className="preview-target">
            {t("previewTargetTable", { table: result.target_table })}
          </span>
        ) : (
          <span className="preview-target preview-target-missing">
            {t("previewNoTarget")}
          </span>
        )}
        <span className="preview-affected">
          {t("previewRowsAffected", { rows: result.rows_affected, ms: result.elapsed_ms })}
        </span>
        {noAffectedInSnapshot && (
          <span className="preview-truncated">
            {t("previewAffectedOutsideSnapshot", { limit: rowLimit })}
          </span>
        )}
        {hasSnapshots && (
          <label className="preview-sync-scroll" title={t("previewSyncScrollTitle")}>
            <input
              type="checkbox"
              checked={syncScroll}
              onChange={(e) => {
                const v = e.target.checked;
                setSyncScroll(v);
                writeSyncScrollPref(v);
              }}
            />
            <span>{t("previewSyncScroll")}</span>
          </label>
        )}
      </div>

      {hasSnapshots && (
        <Splitter
          direction="row"
          className="preview-grids"
          storageKey="noobdb.split.preview"
          defaultFraction={0.5}
          minSize={140}
          ariaLabel={t("splitterPreviewAria")}
          first={
            <section className="preview-pane preview-before">
              <header className="preview-pane-header">{t("previewBefore")}</header>
              <div className="preview-pane-body" ref={beforeBodyRef}>
                {filteredBeforeRows.length === 0 ? (
                  <div className="preview-empty">
                    {result.before_rows.length === 0
                      ? t("previewEmptyBefore")
                      : t("previewNoAffectedBefore")}
                  </div>
                ) : (
                  <DataGrid
                    columns={result.columns}
                    rows={filteredBeforeRows}
                    changedCells={filteredBeforeChanges}
                    changedColumns={diff.changedColumns}
                  />
                )}
              </div>
            </section>
          }
          second={
            <section className="preview-pane preview-after">
              <header className="preview-pane-header">{t("previewAfter")}</header>
              <div className="preview-pane-body" ref={afterBodyRef}>
                {filteredAfterRows.length === 0 ? (
                  <div className="preview-empty">
                    {result.after_rows.length === 0
                      ? t("previewEmptyAfter")
                      : t("previewNoAffectedAfter")}
                  </div>
                ) : (
                  <DataGrid
                    columns={result.columns}
                    rows={filteredAfterRows}
                    changedCells={filteredAfterChanges}
                    changedColumns={diff.changedColumns}
                  />
                )}
              </div>
            </section>
          }
        />
      )}
    </div>
  );
}
