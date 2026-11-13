import type { CellValue, Column, RowMergeBlocker, RowMergePreview, RowMergeUndoDecline } from "../api/tauri";
import type { I18nKey } from "../i18n";

/**
 * 重複レコードのマージ (#2303) の純ロジック。入口の判定 (メニューの無効理由)・対象の組み立て・
 * 実行できない理由 / Undo を残せない理由の文言キーへの対応を持つ。DB へは触れない。
 */

/** マージに選べる行数の上限 (`db/row_merge.rs::MAX_MERGE_ROWS` と同じ)。 */
export const ROW_MERGE_MAX_ROWS = 50;

/** マージ画面へ渡す対象 (グリッドの選択行、または重複グループ)。 */
export interface RowMergeTarget {
  database: string | null;
  table: string;
  keyColumns: string[];
  /** 各行のキー値 (`keyColumns` と同順)。 */
  keys: CellValue[][];
}

export type RowMergeTargetResult =
  | { ok: true; target: Omit<RowMergeTarget, "database" | "table"> }
  | { ok: false; reason: "noPk" | "tooFew" | "tooMany" };

/** 選んだ行 (`rowIndices`) から、主キー列の値を取り出して対象を組む。同じキーの行は 1 つにまとめる。 */
export function buildRowMergeTarget(input: {
  columns: Column[];
  rows: CellValue[][];
  rowIndices: number[];
  pkIndices: number[];
}): RowMergeTargetResult {
  const { columns, rows, rowIndices, pkIndices } = input;
  if (pkIndices.length === 0 || pkIndices.some((i) => !columns[i])) return { ok: false, reason: "noPk" };
  const seen = new Set<string>();
  const keys: CellValue[][] = [];
  for (const ri of rowIndices) {
    const row = rows[ri];
    if (!row) continue;
    const key = pkIndices.map((i) => row[i] ?? null);
    const sig = JSON.stringify(key.map((v) => (v === null ? null : String(v))));
    if (seen.has(sig)) continue;
    seen.add(sig);
    keys.push(key);
  }
  if (keys.length < 2) return { ok: false, reason: "tooFew" };
  if (keys.length > ROW_MERGE_MAX_ROWS) return { ok: false, reason: "tooMany" };
  return { ok: true, target: { keyColumns: pkIndices.map((i) => columns[i]?.name ?? ""), keys } };
}

/** 「行をマージ…」メニューを無効にする理由の文言キー。出せるなら null。 */
export function rowMergeMenuDisabledReason(input: {
  hasTable: boolean;
  identityStrategy: string | undefined;
  pkMasked: boolean;
  built: RowMergeTargetResult;
}): I18nKey | null {
  const { hasTable, identityStrategy, pkMasked, built } = input;
  if (!hasTable) return "gridMergeRowsNoTable";
  if (identityStrategy !== "primary_key" && identityStrategy !== "unique_key") return "gridMergeRowsNoPk";
  if (!built.ok && built.reason === "noPk") return "gridMergeRowsNoPk";
  if (pkMasked) return "gridMergeRowsMasked";
  if (!built.ok) return built.reason === "tooFew" ? "gridMergeRowsTooFew" : "gridMergeRowsTooMany";
  return null;
}

/** 重複グループ (キー列の値が同じ行) に属する行のインデックス。`firstRow` の行と同じ値の行を集める。 */
export function duplicateGroupRowIndices(
  rows: readonly CellValue[][],
  cols: readonly number[],
  firstRow: number,
): number[] {
  const keyOf = (row: CellValue[] | undefined): string | null => {
    if (!row) return null;
    let key = "";
    for (const c of cols) {
      const v = row[c];
      if (v === null || v === undefined) return null;
      const s = String(v);
      key += `${s.length}:${s}`;
    }
    return key;
  };
  const want = keyOf(rows[firstRow] as CellValue[] | undefined);
  if (want === null) return [];
  const out: number[] = [];
  rows.forEach((r, i) => {
    if (keyOf(r as CellValue[]) === want) out.push(i);
  });
  return out;
}

/** 実行できない理由の文言キーと埋め込み値。 */
export function blockerMessage(b: RowMergeBlocker): {
  key: I18nKey;
  params: Record<string, string | number>;
} {
  switch (b.kind) {
    case "noKey":
      return { key: "rowMergeBlockNoKey", params: {} };
    case "tooManyRows":
      return { key: "rowMergeBlockTooManyRows", params: { max: b.max } };
    case "duplicateSelection":
      return { key: "rowMergeBlockDuplicate", params: {} };
    case "rowNotFound":
      return { key: "rowMergeBlockRowNotFound", params: { n: b.index + 1 } };
    case "unsupportedEngine":
      return { key: "rowMergeBlockEngine", params: { engine: b.engine } };
    case "nullReference":
      return { key: "rowMergeBlockNullRef", params: { table: b.table, column: b.column } };
    case "selfReference":
      return { key: "rowMergeBlockSelfRef", params: { table: b.table, column: b.column } };
    case "uniqueConflict":
      return {
        key: "rowMergeBlockConflict",
        params: { table: b.table, index: b.index, groups: b.groups },
      };
    case "tooManyConflicts":
      return { key: "rowMergeBlockTooManyConflicts", params: { table: b.table, index: b.index } };
    case "skipUnsafe":
      return { key: "rowMergeBlockSkipUnsafe", params: { table: b.table } };
    case "lockedPick":
    case "invalidPick":
      return { key: "rowMergeBlockPick", params: { column: b.column } };
    case "unresolvedForeignKey":
      return { key: "rowMergeBlockUnresolvedFk", params: { table: b.table, constraint: b.constraint } };
    case "childUnreadable":
      return { key: "rowMergeBlockChildUnreadable", params: { table: b.table } };
    case "crossDatabaseCascade":
      return { key: "rowMergeBlockCrossDb", params: { table: `${b.schema}.${b.table}` } };
    case "deletedChildReferenced":
      return {
        key: "rowMergeBlockGrandchild",
        params: { table: b.table, referencing: b.referencing === "*" ? "?" : b.referencing },
      };
    case "skipWithoutForeignKeys":
      return { key: "rowMergeBlockSkipNoFk", params: { table: b.table } };
  }
}

/** Undo を残せない理由の文言キーと埋め込み値。 */
export function undoDeclineMessage(d: RowMergeUndoDecline): {
  key: I18nKey;
  params: Record<string, string | number>;
} {
  switch (d.kind) {
    case "childWithoutKey":
      return { key: "rowMergeUndoChildNoKey", params: { table: d.table } };
    case "tooManyRows":
      return { key: "rowMergeUndoTooMany", params: { limit: d.limit } };
    case "crossSchemaChild":
      return { key: "rowMergeUndoCrossSchema", params: { table: d.table } };
  }
}

/** プレビューの列ごとの採用元を `picks` (リクエスト用) にする。残す行 (0) の列は省く。 */
export function picksToRequest(
  preview: Pick<RowMergePreview, "columns" | "picks">,
): { column: string; fromRow: number }[] {
  return preview.columns.flatMap((c, i) => {
    const from = preview.picks[i] ?? 0;
    return from === 0 ? [] : [{ column: c.name, fromRow: from }];
  });
}
