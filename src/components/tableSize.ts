// テーブル/DB サイズ統計の整形・集計 (純ロジック)。#562。
//
// バックエンドの table_sizes が返すバイト数・概算行数を、ダッシュボード表示向けに
// 人間可読へ整形し、データバー (条件付き書式) 用の割合計算と合計集計を提供する。
// 副作用は無く、Vitest でユニットテストする。

import type { TableSizeInfo } from "../api/tauri";

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

/**
 * バイト数を 1 KB = 1024 B の 2 進接頭辞で人間可読にする (例: `1.5 MB`)。
 *
 * - `null` / `undefined` / 非有限値 / 負値は「不明」を表すダッシュ `—` を返す
 *   (エンジンがサイズを報告しない SQLite の dbstat 非搭載ビルドなど)。
 * - 端数は単位が上がるほど桁を増やしすぎないよう、B は整数、それ以外は最大 1 桁。
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${SIZE_UNITS[unit]}`;
}

/**
 * 概算行数の表示。`null` は「不明」(SQLite は概算行数を持たない) を `—` で表す。
 * `~` 付きの概算であることを示す表記は rowEstimate.ts と方針を揃え、ここでは
 * ロケール区切りの整数表記にする (一覧では桁が揃っていた方が読みやすいため)。
 */
const intFmt = new Intl.NumberFormat("en");
export function formatRowCount(rows: number | null | undefined): string {
  if (rows == null || !Number.isFinite(rows) || rows < 0) return "—";
  return intFmt.format(Math.round(rows));
}

/** データバーの幅 (0–100%)。`max <= 0` や不明値は 0% を返す。 */
export function sizeBarPercent(value: number | null | undefined, max: number): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return 0;
  if (!Number.isFinite(max) || max <= 0) return 0;
  return Math.min(100, (value / max) * 100);
}

/** ソート可能な列キー。 */
export type TableSizeSortKey = "name" | "row_estimate" | "data_bytes" | "index_bytes" | "total_bytes";
export type SortDirection = "asc" | "desc";

/**
 * テーブルサイズ行をキー・方向でソートした新しい配列を返す (入力は不変)。
 * 数値列では `null` (不明) を常に末尾へ寄せ、`name` は大小無視の自然な比較にする。
 */
export function sortTableSizes(
  rows: readonly TableSizeInfo[],
  key: TableSizeSortKey,
  dir: SortDirection,
): TableSizeInfo[] {
  const sign = dir === "asc" ? 1 : -1;
  const copy = [...rows];
  copy.sort((a, b) => {
    if (key === "name") {
      return sign * a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    }
    const av = a[key];
    const bv = b[key];
    // null は方向によらず常に末尾。
    if (av == null && bv == null) return a.name.localeCompare(b.name);
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av === bv) return a.name.localeCompare(b.name);
    return sign * (av < bv ? -1 : 1);
  });
  return copy;
}

/** 一覧全体の合計 (不明値は 0 として加算)。表示の「合計」フッタに使う。 */
export interface TableSizeTotals {
  tableCount: number;
  rowEstimate: number;
  dataBytes: number;
  indexBytes: number;
  totalBytes: number;
}

export function computeTableSizeTotals(rows: readonly TableSizeInfo[]): TableSizeTotals {
  const add = (acc: number, v: number | null) => acc + (v != null && Number.isFinite(v) && v > 0 ? v : 0);
  return {
    tableCount: rows.length,
    rowEstimate: rows.reduce((acc, r) => add(acc, r.row_estimate), 0),
    dataBytes: rows.reduce((acc, r) => add(acc, r.data_bytes), 0),
    indexBytes: rows.reduce((acc, r) => add(acc, r.index_bytes), 0),
    totalBytes: rows.reduce((acc, r) => add(acc, r.total_bytes), 0),
  };
}
