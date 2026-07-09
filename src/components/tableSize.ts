// テーブル/DB サイズ・構造統計の整形・集計・フィルタ (純ロジック)。#562 / #660。
//
// #562 でバックエンドの table_sizes が返すバイト数・概算行数をダッシュボード表示向けに
// 整形する層として生まれ、#660 でスキーマ把握のための構造メタ (列数・インデックス数・
// PK 有無・FK 数) を既存コマンド (schema_overview / foreign_keys / list_indexes) の
// 再利用で合成する層を足した。集計・ソート・フィルタはすべて副作用なしで、Vitest で
// ユニットテストする。表示専用でありデータは一切変更しない。

import type { ForeignKey, IndexInfo, TableSchema, TableSizeInfo } from "../api/tauri";

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

/**
 * 列数・インデックス数・FK 数など小さな整数カウントの表示。取得できていない
 * (`null`) 場合は「不明」を `—` で表す (インデックス取得に失敗したテーブルなど)。
 * 0 は 0 として表示する (「無い」ことに意味があり、クイックフィルタの対象になる)。
 */
export function formatCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return "—";
  return intFmt.format(Math.round(n));
}

/** データバーの幅 (0–100%)。`max <= 0` や不明値は 0% を返す。 */
export function sizeBarPercent(value: number | null | undefined, max: number): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return 0;
  if (!Number.isFinite(max) || max <= 0) return 0;
  return Math.min(100, (value / max) * 100);
}

/**
 * 1 テーブルのサイズ + 構造統計。サイズ/行数は table_sizes (#562)、構造メタは
 * schema_overview (列数)・list_indexes (インデックス数・PK 有無)・foreign_keys
 * (FK 数) を合成した値 (#660)。取得できない項目は `null` にして「不明」と「0」を
 * 区別する (SQLite の縮退や、あるテーブルだけインデックス取得に失敗した場合など)。
 */
export interface TableStatRow extends TableSizeInfo {
  /** 列数。schema_overview が返すカラム名配列の長さ。取得不能時は `null`。 */
  columnCount: number | null;
  /** インデックス数 (PRIMARY 含む)。list_indexes の件数。取得失敗時は `null`。 */
  indexCount: number | null;
  /** PRIMARY KEY を持つか。list_indexes に primary=true が 1 件でもあれば true。取得失敗時は `null`。 */
  hasPrimaryKey: boolean | null;
  /** 外部キー (制約単位) の数。foreign_keys を制約名でまとめた件数。 */
  foreignKeyCount: number | null;
}

/**
 * foreign_keys の行 (参照カラム 1 件につき 1 行、複合キーは constraint_name を共有)
 * を、テーブルごとの**制約単位**の件数に畳み込む。constraint_name が無いドライバ
 * (一部の SQLite など) では参照カラム→参照先の組を一意キーにして数える。
 */
export function foreignKeyCounts(fks: readonly ForeignKey[]): Map<string, number> {
  const perTable = new Map<string, Set<string>>();
  for (const fk of fks) {
    let set = perTable.get(fk.table);
    if (!set) {
      set = new Set();
      perTable.set(fk.table, set);
    }
    const key = fk.constraint_name ?? `${fk.column}->${fk.referenced_table}.${fk.referenced_column ?? ""}`;
    set.add(key);
  }
  const out = new Map<string, number>();
  for (const [table, set] of perTable) out.set(table, set.size);
  return out;
}

/**
 * サイズ一覧を基準に、列数・インデックス・FK の構造メタを名前で突き合わせて
 * `TableStatRow[]` を合成する。テーブル集合は `sizes` (サイズダッシュボードの対象)
 * を基準にし、他ソースは名前で引く (見つからなければ `null` = 不明)。
 *
 * `indexesByTable` はテーブル名 → そのインデックス一覧 (取得失敗時は `null`) の
 * マップ。未登録キー (未取得) も `null` 扱いにして「不明」を表す。foreignKeyCount は
 * FK が 1 件も無いテーブルでは 0 になる (foreign_keys は全テーブルを走査するため
 * 「不明」ではなく「0」)。
 */
export function buildTableStatRows(
  sizes: readonly TableSizeInfo[],
  overview: readonly TableSchema[],
  foreignKeys: readonly ForeignKey[],
  indexesByTable: ReadonlyMap<string, IndexInfo[] | null>,
): TableStatRow[] {
  const colByName = new Map<string, number>();
  for (const t of overview) colByName.set(t.name, t.columns.length);
  const fkByName = foreignKeyCounts(foreignKeys);
  return sizes.map((s) => {
    const idx = indexesByTable.has(s.name) ? indexesByTable.get(s.name) : null;
    return {
      ...s,
      columnCount: colByName.has(s.name) ? (colByName.get(s.name) as number) : null,
      indexCount: idx == null ? null : idx.length,
      hasPrimaryKey: idx == null ? null : idx.some((i) => i.primary),
      foreignKeyCount: fkByName.get(s.name) ?? 0,
    };
  });
}

/** ソート可能な列キー (サイズ + 構造)。 */
export type TableStatSortKey =
  | "name"
  | "row_estimate"
  | "data_bytes"
  | "index_bytes"
  | "total_bytes"
  | "column_count"
  | "index_count"
  | "foreign_key_count";
export type SortDirection = "asc" | "desc";

/** 数値ソートキーから行の値 (不明は `null`) を取り出す。 */
function statValue(row: TableStatRow, key: Exclude<TableStatSortKey, "name">): number | null {
  switch (key) {
    case "row_estimate":
      return row.row_estimate;
    case "data_bytes":
      return row.data_bytes;
    case "index_bytes":
      return row.index_bytes;
    case "total_bytes":
      return row.total_bytes;
    case "column_count":
      return row.columnCount;
    case "index_count":
      return row.indexCount;
    case "foreign_key_count":
      return row.foreignKeyCount;
  }
}

/**
 * 統計行をキー・方向でソートした新しい配列を返す (入力は不変)。
 * 数値列では `null` (不明) を常に末尾へ寄せ、`name` は大小無視の自然な比較にする。
 * 同値は名前の昇順で安定させる。
 */
export function sortTableStats(
  rows: readonly TableStatRow[],
  key: TableStatSortKey,
  dir: SortDirection,
): TableStatRow[] {
  const sign = dir === "asc" ? 1 : -1;
  const copy = [...rows];
  copy.sort((a, b) => {
    if (key === "name") {
      return sign * a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    }
    const av = statValue(a, key);
    const bv = statValue(b, key);
    // null は方向によらず常に末尾。
    if (av == null && bv == null) return a.name.localeCompare(b.name);
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av === bv) return a.name.localeCompare(b.name);
    return sign * (av < bv ? -1 : 1);
  });
  return copy;
}

/** クイックフィルタの条件。すべて任意で、指定が無ければ通過させる。 */
export interface TableStatFilter {
  /** テーブル名の大小無視部分一致。空/空白のみは無視。 */
  nameQuery?: string;
  /** インデックスが 1 つも無いテーブルだけに絞る (indexCount === 0)。 */
  onlyNoIndex?: boolean;
  /** PRIMARY KEY を持たないテーブルだけに絞る (hasPrimaryKey === false)。 */
  onlyNoPrimaryKey?: boolean;
}

/**
 * 統計行をクイックフィルタで絞り込んだ新しい配列を返す (入力は不変)。
 *
 * 「インデックス無し」「PK 無し」は**判定できたテーブルのみ**を対象にする:
 * 取得に失敗して `null` (不明) の行は、誤って「無い」に含めないよう除外する
 * (不明を「無し」と断定すると誤検出になるため)。
 */
export function filterTableStats(
  rows: readonly TableStatRow[],
  filter: TableStatFilter,
): TableStatRow[] {
  const q = filter.nameQuery?.trim().toLowerCase() ?? "";
  return rows.filter((r) => {
    if (q && !r.name.toLowerCase().includes(q)) return false;
    if (filter.onlyNoIndex && r.indexCount !== 0) return false;
    if (filter.onlyNoPrimaryKey && r.hasPrimaryKey !== false) return false;
    return true;
  });
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
