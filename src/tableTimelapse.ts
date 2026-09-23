// テーブル・タイムラプス (#739) の純ロジック。
//
// 世代スナップショットの保存・ローテーション・差分計算そのものは Rust 側
// (`src-tauri/src/timelapse/`、差分は `db::data_diff::compute_data_diff` を流用)
// が担う。ここは `TableTimelapsePanel` が描画に使う整形 (差分行の表示モデル・
// 件数サマリ・世代ペアの既定値) と、接続時の自動取得結果の要約だけを持つ —
// DOM / IPC に触れないので Vitest で直接検証する (`__tests__/tableTimelapse.test.ts`)。
//
// 差分の向き: バックエンドの `TimelapseGenerationDiff.diff` は **source = 新しい
// 世代 / target = 古い世代**。したがって `source_only` = 追加、`target_only` =
// 削除、`different` = 変更。

import type {
  CellValue,
  DataDiff,
  TableWatch,
  TimelapseCaptureOutcome,
  TimelapseGenerationMeta,
} from "./api/tauri";
import { MASK_PLACEHOLDER } from "./components/columnMask";

export type TimelapseRowKind = "added" | "removed" | "changed";

/** 差分表の 1 セル。 */
export interface TimelapseCell {
  column: string;
  /** 表示する値 (変更行・追加行は新しい値、削除行は古い値)。マスク中は伏せ字。 */
  text: string;
  /** 変更行で値が変わったセルのときだけ、変更前の値 (マスク中は伏せ字)。 */
  before: string | null;
  changed: boolean;
  masked: boolean;
  primaryKey: boolean;
}

/** 差分表の 1 行。 */
export interface TimelapseRow {
  kind: TimelapseRowKind;
  /** React の key 用に一意化した PK 表現。 */
  key: string;
  cells: TimelapseCell[];
}

export interface TimelapseCounts {
  added: number;
  removed: number;
  changed: number;
}

/** セル値の表示文字列。NULL は "NULL"。 */
export function formatTimelapseValue(v: CellValue | undefined): string {
  if (v === null || v === undefined) return "NULL";
  return String(v);
}

export function countTimelapseDiff(diff: DataDiff): TimelapseCounts {
  const out: TimelapseCounts = { added: 0, removed: 0, changed: 0 };
  for (const r of diff.rows) {
    if (r.status === "source_only") out.added += 1;
    else if (r.status === "target_only") out.removed += 1;
    else out.changed += 1;
  }
  return out;
}

/**
 * `DataDiff` (source = 新 / target = 古) を差分表の行モデルへ変換する。
 * `masked` は `diff.columns` と同じ並びのマスク判定 (`resolveMaskedColumns` の戻り値。
 * マスク無しなら null)。マスクは**表示専用** — 変化したこと (ハイライト) は見せるが
 * 値そのものは伏せ字にする (結果グリッドの #1069 と同じ扱い)。
 */
export function buildTimelapseRows(diff: DataDiff, masked: readonly boolean[] | null): TimelapseRow[] {
  const pk = new Set(diff.primary_key);
  const seen = new Map<string, number>();
  return diff.rows.map((r) => {
    const kind: TimelapseRowKind =
      r.status === "source_only" ? "added" : r.status === "target_only" ? "removed" : "changed";
    const shown = (kind === "removed" ? r.target : r.source) ?? [];
    const old = kind === "changed" ? (r.target ?? []) : null;
    const changedSet = new Set(r.changed_columns);
    const cells = diff.columns.map((column, i): TimelapseCell => {
      const isMasked = masked?.[i] ?? false;
      const changed = kind === "changed" && changedSet.has(column);
      const render = (v: CellValue | undefined) => (isMasked ? MASK_PLACEHOLDER : formatTimelapseValue(v));
      return {
        column,
        text: render(shown[i]),
        before: changed && old ? render(old[i]) : null,
        changed,
        masked: isMasked,
        primaryKey: pk.has(column),
      };
    });
    const base = `${kind}:${JSON.stringify(r.key)}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { kind, key: n === 0 ? base : `${base}#${n}`, cells };
  });
}

/**
 * 世代一覧 (新しい順) から既定の比較ペアを返す: 「1 つ前 → 最新」。
 * 世代が 2 つ未満なら null。
 */
export function defaultGenerationPair(
  generations: readonly TimelapseGenerationMeta[],
): { fromId: number; toId: number } | null {
  if (generations.length < 2) return null;
  return { fromId: generations[1].id, toId: generations[0].id };
}

/**
 * 選択中のペアがまだ有効 (両方がこのウォッチの世代に存在し、別世代) かを確認し、
 * 無効なら既定ペアへ戻す。ローテーションで古い世代が消えたときの取り残し対策。
 */
export function resolveGenerationPair(
  generations: readonly TimelapseGenerationMeta[],
  pair: { fromId: number; toId: number } | null,
): { fromId: number; toId: number } | null {
  if (
    pair &&
    pair.fromId !== pair.toId &&
    generations.some((g) => g.id === pair.fromId) &&
    generations.some((g) => g.id === pair.toId)
  ) {
    return pair;
  }
  return defaultGenerationPair(generations);
}

/** プロファイルの全ウォッチの保存量合計 (バイト)。 */
export function totalTimelapseBytes(watches: readonly TableWatch[]): number {
  let total = 0;
  for (const w of watches) for (const g of w.generations) total += g.bytes;
  return total;
}

/** 接続時 / 手動更新の取得結果の要約 (トースト用)。 */
export interface CaptureSummary {
  /** 内容が変わって世代が増えたテーブル (`db.table`)。 */
  changed: string[];
  /** 取得に失敗したテーブルとエラー。 */
  failed: { table: string; error: string }[];
}

export function summarizeCapture(outcomes: readonly TimelapseCaptureOutcome[]): CaptureSummary {
  const changed: string[] = [];
  const failed: { table: string; error: string }[] = [];
  for (const o of outcomes) {
    const name = `${o.database}.${o.table}`;
    if (o.error) failed.push({ table: name, error: o.error });
    else if (o.added) changed.push(name);
  }
  return { changed, failed };
}
