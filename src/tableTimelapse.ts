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
import { sqlLiteral } from "./components/exportPreview";
import { qualifiedTableName, quoteIdentFor } from "./components/sqlDialect";

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
  /** 主キー値の並び (`timelapseRowHistory` へそのまま渡す, #1621)。 */
  rawKey: CellValue[];
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
    return { kind, key: n === 0 ? base : `${base}#${n}`, rawKey: r.key, cells };
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

// ── 差分の書き出し (#1539) ──────────────────────────────────────────────

/** 書き出し用の 1 行。値は表示用文字列ではなく生の値 (NULL は null のまま)。 */
export interface TimelapseExportRow {
  kind: TimelapseRowKind;
  /** 主キー列名 → 値。 */
  key: Record<string, CellValue>;
  /** 変更前 (古い世代) の列名 → 値。追加行は null。 */
  before: Record<string, CellValue> | null;
  /** 変更後 (新しい世代) の列名 → 値。削除行は null。 */
  after: Record<string, CellValue> | null;
  /** 変更行で値が変わった列。 */
  changedColumns: string[];
}

/**
 * `DataDiff` を書き出し用の行モデルにする。向きと種別の判定は `buildTimelapseRows` と同じ
 * (source = 新 / target = 古)。`masked` が真の列は**値を伏せ字**にする (主キー列も同様。
 * 画面表示と同じく、変化したこと = `changedColumns` は残す)。
 */
export function buildTimelapseExportRows(
  diff: DataDiff,
  masked: readonly boolean[] | null,
): TimelapseExportRow[] {
  const toRecord = (values: CellValue[] | null): Record<string, CellValue> | null => {
    if (values === null) return null;
    const out: Record<string, CellValue> = {};
    diff.columns.forEach((column, i) => {
      out[column] = masked?.[i] ? MASK_PLACEHOLDER : (values[i] ?? null);
    });
    return out;
  };
  return diff.rows.map((r) => {
    const kind: TimelapseRowKind =
      r.status === "source_only" ? "added" : r.status === "target_only" ? "removed" : "changed";
    const before = kind === "added" ? null : toRecord(r.target ?? []);
    const after = kind === "removed" ? null : toRecord(r.source ?? []);
    const base = after ?? before ?? {};
    const key: Record<string, CellValue> = {};
    for (const pk of diff.primary_key) key[pk] = base[pk] ?? null;
    return { kind, key, before, after, changedColumns: kind === "changed" ? [...r.changed_columns] : [] };
  });
}

/** 主キーを `id=1, tenant=a` 形式の 1 文字列にする。 */
function formatKey(key: Record<string, CellValue>): string {
  return Object.entries(key)
    .map(([k, v]) => `${k}=${v === null ? "NULL" : String(v)}`)
    .join(", ");
}

/**
 * CSV 用の縦持ち表 (1 行 = 1 セルの変化)。列は `kind, key, column, before, after`。
 * 追加・削除行は全列、変更行は値が変わった列だけを出す (監査で見たいのは変わった所)。
 * NULL は空セル (kind で追加 / 削除が分かるので before / after の空は「その側に行が無い」か NULL)。
 */
export function timelapseRowsToTable(
  rows: readonly TimelapseExportRow[],
  header: readonly [string, string, string, string, string],
  /** 種別列の表示文言 (画面の kindLabel と同じ翻訳済み文言)。省略時は kind の識別子そのまま。 */
  kindLabels?: Partial<Record<TimelapseRowKind, string>>,
): { header: string[]; rows: CellValue[][] } {
  const out: CellValue[][] = [];
  for (const r of rows) {
    const key = formatKey(r.key);
    const columns = r.kind === "changed" ? r.changedColumns : Object.keys(r.after ?? r.before ?? {});
    for (const column of columns) {
      out.push([
        kindLabels?.[r.kind] ?? r.kind,
        key,
        column,
        r.before?.[column] ?? null,
        r.after?.[column] ?? null,
      ]);
    }
  }
  return { header: [...header], rows: out };
}

export interface TimelapseExportMeta {
  table: string;
  fromCapturedAt: string;
  toCapturedAt: string;
}

/** JSON (2 スペース字下げ)。行モデルをそのまま入れ、世代の取得時刻とテーブル名を添える。 */
export function timelapseRowsToJson(rows: readonly TimelapseExportRow[], meta: TimelapseExportMeta): string {
  return JSON.stringify(
    {
      table: meta.table,
      from_captured_at: meta.fromCapturedAt,
      to_captured_at: meta.toCapturedAt,
      rows: rows.map((r) => ({
        kind: r.kind,
        key: r.key,
        before: r.before,
        after: r.after,
        changed_columns: r.changedColumns,
      })),
    },
    null,
    2,
  );
}

// ── 再現用 DML のプレビュー (#1624) ─────────────────────────────────────

/**
 * 生成する向き。`forward` = 古い世代 → 新しい世代の変更を再現する、`revert` = 新しい世代を
 * 古い世代の状態へ戻す (巻き戻し)。
 */
export type TimelapseDmlDirection = "forward" | "revert";

export interface TimelapseDmlOptions {
  driver: string;
  database: string;
  table: string;
  direction: TimelapseDmlDirection;
  /** 伏せ字にされている列名。値が必要な文はコメントに置き換え、伏せ字を SQL に書かない。 */
  maskedColumns?: ReadonlySet<string>;
  /** 見出しコメント (「プレビュー専用」などの注記。翻訳済み)。空なら出さない。 */
  header?: string;
  /** マスク列を含むため出せなかった文のコメント文言。`{key}` は主キー表記。 */
  skippedComment?: (key: string) => string;
}

export interface TimelapseDmlResult {
  sql: string;
  /** 出力した DML の文数。 */
  statements: number;
  /** マスク列・主キー無しのため出せなかった行数。 */
  skipped: number;
}

/**
 * タイムラプスの差分行から INSERT / UPDATE / DELETE を組む。**プレビューとコピー専用**で、
 * 実行する経路は無い。識別子は `quoteIdentFor`、値は `sqlLiteral` (共有ゴールデンで固定された
 * ドライバ別リテラル) を通す。
 *
 * - forward: 追加 → INSERT(after) / 削除 → DELETE / 変更 → UPDATE(変わった列 = after)
 * - revert : 追加 → DELETE / 削除 → INSERT(before) / 変更 → UPDATE(変わった列 = before)
 * - 主キーが無い (WHERE を作れない)・主キー値が伏せ字・INSERT/UPDATE に必要な値が伏せ字、の
 *   いずれかは文を出さずコメントにする (伏せ字を実データとして書かない)。
 * - `rows` は `buildTimelapseExportRows(diff, null)` のようにマスク前の値で渡すこと。
 */
export function buildTimelapseDml(
  rows: readonly TimelapseExportRow[],
  o: TimelapseDmlOptions,
): TimelapseDmlResult {
  const q = (n: string) => quoteIdentFor(o.driver, n);
  const target = qualifiedTableName(o.driver, o.database, o.table);
  const masked = o.maskedColumns ?? new Set<string>();
  const lines: string[] = [];
  if (o.header) for (const h of o.header.split("\n")) lines.push(`-- ${h}`);
  let statements = 0;
  let skipped = 0;

  const skip = (key: string) => {
    skipped += 1;
    lines.push(`-- ${(o.skippedComment ?? ((k) => `skipped (masked / no key): ${k}`))(key)}`);
  };
  const keyText = (r: TimelapseExportRow) => formatKey(r.key);

  for (const r of rows) {
    const forward = o.direction === "forward";
    const keyCols = Object.keys(r.key);
    // 追加行は forward で INSERT・revert で DELETE。削除行はその逆。変更行は常に UPDATE。
    const op: "insert" | "delete" | "update" =
      r.kind === "changed" ? "update" : (r.kind === "added") === forward ? "insert" : "delete";
    const values = op === "insert" ? (forward ? r.after : r.before) : null;

    if (op === "insert") {
      if (!values) continue;
      const cols = Object.keys(values);
      if (cols.some((c) => masked.has(c))) {
        skip(keyText(r));
        continue;
      }
      lines.push(
        `INSERT INTO ${target} (${cols.map(q).join(", ")}) VALUES (${cols.map((c) => sqlLiteral(o.driver, values[c] ?? null)).join(", ")});`,
      );
      statements += 1;
      continue;
    }

    if (keyCols.length === 0 || keyCols.some((c) => masked.has(c))) {
      skip(keyText(r));
      continue;
    }
    const where = keyCols
      .map((c) => `${q(c)} ${r.key[c] === null ? "IS NULL" : `= ${sqlLiteral(o.driver, r.key[c] ?? null)}`}`)
      .join(" AND ");
    if (op === "delete") {
      lines.push(`DELETE FROM ${target} WHERE ${where};`);
      statements += 1;
      continue;
    }
    const src = forward ? r.after : r.before;
    const cols = r.changedColumns;
    if (!src || cols.length === 0 || cols.some((c) => masked.has(c))) {
      skip(keyText(r));
      continue;
    }
    lines.push(
      `UPDATE ${target} SET ${cols.map((c) => `${q(c)} = ${sqlLiteral(o.driver, src[c] ?? null)}`).join(", ")} WHERE ${where};`,
    );
    statements += 1;
  }
  return { sql: lines.join("\n") + (lines.length ? "\n" : ""), statements, skipped };
}
