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
export function resolveKeyIndicesByName(columns: Column[], keyColumnNames: string[]): number[] {
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
export function diffToRowDiff(diff: BroadcastDiff, rowCount: number, colCount: number): ResultRowDiff {
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

/** 「欠落行の例」に並べる行数の既定 (#1625)。 */
export const REMOVED_ROW_SAMPLE_LIMIT = 5;

const SAMPLE_CELL_MAX = 40;
const SAMPLE_LINE_MAX = 200;

function sampleCell(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  const text = typeof v === "string" ? v : JSON.stringify(v);
  return text.length > SAMPLE_CELL_MAX ? `${text.slice(0, SAMPLE_CELL_MAX)}…` : text;
}

/**
 * 基準にだけある行 (対象で欠けている行) の先頭 `limit` 件を `列名=値, …` の 1 行ずつに整形する
 * (#1625)。キーを指定しない行ハッシュ比較でも、どの行が欠けているかが読める。位置は
 * バックエンドの `removedRowIndices` (基準の表示行上の添字) で、範囲外は読み飛ばす。
 * `hiddenCount` は例に載せなかった欠落行の数 (`removedCount` との差も含む)。
 */
export function removedRowSamples(
  diff: Pick<BroadcastDiff, "removedRowIndices" | "removedCount">,
  baselineRows: CellValueRow[],
  columns: Pick<Column, "name">[],
  limit: number = REMOVED_ROW_SAMPLE_LIMIT,
): { samples: string[]; hiddenCount: number } {
  const samples: string[] = [];
  for (const idx of diff.removedRowIndices) {
    if (samples.length >= limit) break;
    const row = baselineRows[idx];
    if (!row) continue;
    const line = columns.map((c, i) => `${c.name}=${sampleCell(row[i])}`).join(", ");
    samples.push(line.length > SAMPLE_LINE_MAX ? `${line.slice(0, SAMPLE_LINE_MAX)}…` : line);
  }
  return { samples, hiddenCount: Math.max(0, diff.removedCount - samples.length) };
}

type CellValueRow = readonly unknown[];

/**
 * 同期 SQL を作れない理由 (#1625)。作れるなら null。テーブル名が分かり (テーブル閲覧タブ由来)、
 * 差分があり、比較できて、打ち切られていないことが条件。打ち切られた結果は窓のずれで存在する
 * 行を欠落や余剰と取り違えうるので、バックエンドも拒否する (代わりに全件比較を案内する)。
 */
export function syncSqlBlockReason(
  diff: BroadcastDiff | null,
  table: string | null | undefined,
): "no-table" | "truncated" | null {
  if (!diff || !diff.comparable) return null;
  // 打ち切られた比較は「差分なし」でも先頭だけの結果なので、全件比較の案内を出す。
  if (diff.truncated) return "truncated";
  if (!diff.hasDiff) return null;
  if (!table) return "no-table";
  return null;
}
