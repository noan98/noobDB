// 環境横断ブロードキャスト実行 (#738) のフロント側ロジック。
//
// 同じ読み取りクエリを複数の接続 (環境) へ一斉実行し、そのうち 1 つを「基準環境」
// (現在のフォアグラウンド接続) として、他の各環境の結果を基準とペアワイズ比較する。
// **比較そのもの (PK ペアリング / 行ハッシュの多重集合比較 / 5,000 行打ち切り) は
// バックエンドの `broadcast_compare` (`db/broadcast_diff.rs`, #1257) が行う。**
// ここには DOM・Tauri 非依存の小さな純関数だけを置き、`__tests__/broadcastCompare.test.ts`
// で境界を固定する:
//
// - `resolveKeyIndicesByName`: ユーザが選んだキー列名 → 列位置 (グリッドの PK ハイライト用)。
// - `diffToRowDiff`: バックエンドの疎な差分サマリ → `ResultGrid` の `ResultRowDiff`。
//
// ## PK 特定の方針
//
// PK が実テーブルのメタデータ (`TableColumnInfo[]`, `key === "PRI"`) から分かる場合は
// その列名をバックエンドへ渡す。クエリエディタの任意 SQL には実テーブルのメタデータが
// 無いことが多いため、`PinnedComparisonView.tsx` (#622) と同じ発想で「ユーザが結果列から
// キー列を指定する」経路も用意し、[`resolveKeyIndicesByName`] がその名前解決を担う。
// どちらの経路も「1 列でも解決できなければ全体を無効 (空配列) として扱う」保守的な
// 方針を共有する — 曖昧なキーで誤ペアリングするより、行ハッシュ比較への降格を優先する。

import type { BroadcastDiff, Column } from "./api/tauri";
import type { ResultRowDiff } from "./resultDiff";

/** バックエンド (`MAX_BROADCAST_COMPARE_ROWS`) と同じ、表示・比較の行数上限。 */
export const MAX_BROADCAST_COMPARE_ROWS = 5000;

/** ブロードキャスト対象 1 接続ぶんの実行状態 (UI のカード表示に対応)。 */
export type BroadcastRunStatus = "running" | "done" | "error" | "cancelled";

/**
 * `columns` からユーザ指定のキー列名を列位置へ解決する。`resolvePkIndices`
 * (`components/cellEdit.ts`) と同じ失敗モード — 名前解決できない列が 1 つでもあれば
 * 全体を無効 (空配列) として返す。空の `keyColumnNames` は「キー未指定」として
 * そのまま空配列を返す (呼び出し側はこれを「PK 不明」として扱い降格させる)。
 */
export function resolveKeyIndicesByName(
  columns: Column[],
  keyColumnNames: string[],
): number[] {
  if (keyColumnNames.length === 0) return [];
  const indices: number[] = [];
  for (const name of keyColumnNames) {
    const i = columns.findIndex((c) => c.name === name);
    if (i < 0) return [];
    // 同名の列が複数ある (JOIN の `a.id, b.id` など) 曖昧なキーは誤ペアリングの
    // 元なので解決失敗として扱う。
    if (columns.some((c, j) => j !== i && c.name === name)) return [];
    indices.push(i);
  }
  return indices;
}

/**
 * バックエンドの差分 (変化セルは疎表現) を `ResultGrid` が読む `ResultRowDiff` に変換する。
 * 変化の無い行は全セル false の共有配列を指すので、行数ぶんの配列は作らない。
 * `rowCount` は対象の表示行数、`colCount` は列数。
 */
export function diffToRowDiff(
  diff: BroadcastDiff,
  rowCount: number,
  colCount: number,
): ResultRowDiff {
  const noChange = new Array<boolean>(colCount).fill(false);
  const changedCells = new Array<boolean[]>(rowCount).fill(noChange);
  for (const { row, cols } of diff.changedCells) {
    if (row < 0 || row >= rowCount) continue;
    const flags = new Array<boolean>(colCount).fill(false);
    for (const c of cols) if (c >= 0 && c < colCount) flags[c] = true;
    changedCells[row] = flags;
  }
  return {
    changedCells,
    addedRows: new Set(diff.addedRowIndices.filter((i) => i >= 0 && i < rowCount)),
    removedCount: diff.removedCount,
    hasChanges: diff.hasDiff,
  };
}
