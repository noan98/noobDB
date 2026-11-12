// サブセット抽出 (#2241) の判定・整形の純ロジック。`SubsetExtractModal` (副作用・描画) と対にする。
// 抽出計画そのもの (どの行を辿るか) はバックエンド (`db/subset.rs`) が持ち、ここは入力の検証と
// 表示用の整形だけを担う。

import type {
  CellValue,
  Column,
  SubsetColumnMask,
  SubsetPreview,
  SubsetRequest,
  SubsetWarning,
} from "../api/tauri";
import type { I18nKey } from "../i18n";
import { buildRowWhere, rowPkEqualityLiterals } from "./cellEdit";
import { quoteIdentFor } from "./sqlDialect";
import { effectiveMaskRule, type ExportMaskOverrides } from "./exportMasking";

/** バックエンド (`db::subset`) の上限・既定値と揃える。 */
export const SUBSET_DEFAULT_ROOT_LIMIT = 1000;
export const SUBSET_MAX_ROOT_LIMIT = 100_000;
/** サンドボックスの差分表示が 1 表で扱える行数 (`commands::diff::MAX_DATA_ROWS`)。 */
export const SUBSET_MAX_SANDBOX_ROOT_LIMIT = 5000;
export const SUBSET_DEFAULT_CHILD_LIMIT = 1000;
export const SUBSET_MAX_CHILD_LIMIT = 100_000;
export const SUBSET_DEFAULT_CHILD_DEPTH = 1;
export const SUBSET_MAX_CHILD_DEPTH = 5;

let subsetStreamSeq = 0;
export function makeSubsetStreamId(): string {
  subsetStreamSeq += 1;
  return `subset_${Date.now().toString(36)}_${subsetStreamSeq.toString(36)}`;
}

/** `[min, max]` の整数だけを受け付ける。空白・小数・範囲外は `null`。 */
export function parseBoundedInt(text: string, min: number, max: number): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

export interface SubsetInputs {
  sessionId: string;
  database: string | null;
  table: string;
  whereClause: string;
  rootLimit: string;
  childrenEnabled: boolean;
  childDepth: string;
  childLimit: string;
  /** サンドボックスへ出すときは起点行数の上限が下がる。 */
  sandbox?: boolean;
}

/** 出力先に応じた起点行数の上限。 */
export function subsetRootMax(sandbox: boolean): number {
  return sandbox ? SUBSET_MAX_SANDBOX_ROOT_LIMIT : SUBSET_MAX_ROOT_LIMIT;
}

/** 入力から抽出の指定を作る。数値が不正なら `null`。子を辿らないときは段数 0。 */
export function buildSubsetRequest(i: SubsetInputs): SubsetRequest | null {
  const rootRowLimit = parseBoundedInt(i.rootLimit, 1, subsetRootMax(i.sandbox === true));
  if (rootRowLimit === null) return null;
  let childDepth = 0;
  let childRowLimit: number | null = null;
  if (i.childrenEnabled) {
    const d = parseBoundedInt(i.childDepth, 1, SUBSET_MAX_CHILD_DEPTH);
    const l = parseBoundedInt(i.childLimit, 1, SUBSET_MAX_CHILD_LIMIT);
    if (d === null || l === null) return null;
    childDepth = d;
    childRowLimit = l;
  }
  const where = i.whereClause.trim();
  return {
    sourceSessionId: i.sessionId,
    sourceDatabase: i.database,
    table: i.table,
    whereClause: where === "" ? null : where,
    rootRowLimit,
    childDepth,
    childRowLimit,
  };
}

/** プレビューが現在の指定のものか (条件を変えたら実行前に取り直させる)。 */
export function previewMatches(previewKey: string | null, request: SubsetRequest | null): boolean {
  return previewKey !== null && request !== null && previewKey === JSON.stringify(request);
}

/** マスクの対象にできる列 (キーの列を除く)。表示名 `表.列` から (表, 列) を引ける。 */
export function maskableColumns(preview: SubsetPreview): { label: string; table: string; column: string }[] {
  const out: { label: string; table: string; column: string }[] = [];
  const seen = new Set<string>();
  for (const t of preview.tables) {
    for (const c of t.columns) {
      if (c.key) continue;
      const label = `${t.table}.${c.name}`;
      if (seen.has(label)) continue;
      seen.add(label);
      out.push({ label, table: t.table, column: c.name });
    }
  }
  return out;
}

/** 列ごとの指定 (表示名キー) を IPC 用のマスク指定へ解決する。無効なら空。 */
export function resolveSubsetMasks(
  preview: SubsetPreview | null,
  enabled: boolean,
  overrides: ExportMaskOverrides,
): SubsetColumnMask[] {
  if (!enabled || !preview) return [];
  const out: SubsetColumnMask[] = [];
  for (const c of maskableColumns(preview)) {
    const rule = effectiveMaskRule(c.label, [], overrides);
    if (rule) out.push({ table: c.table, column: c.column, rule });
  }
  return out;
}

/** 警告の翻訳キーと差し込み値。 */
export function subsetWarningMessage(w: SubsetWarning): {
  key: I18nKey;
  params: Record<string, string | number>;
} {
  switch (w.kind) {
    case "cycle":
      return { key: "subsetWarnCycle", params: { tables: w.tables.join(", ") } };
    case "unresolvedForeignKey":
      return { key: "subsetWarnUnresolved", params: { table: w.table, constraint: w.constraint } };
    case "childTruncated":
      return { key: "subsetWarnChildTruncated", params: { table: w.table, limit: w.limit } };
    case "rootTruncated":
      return { key: "subsetWarnRootTruncated", params: { table: w.table, limit: w.limit } };
  }
}

/** 保存先の初期ファイル名。 */
export function defaultSubsetScriptName(table: string): string {
  const safe = table.replace(/[^\w.-]+/g, "_") || "subset";
  return `${safe}_subset.sql`;
}

/** 転送先への書き込み前に確認が要るか (本番・書き込み確認ありの接続)。 */
export function needsWriteConfirm(target: { is_production: boolean; confirm_writes: boolean }): boolean {
  return target.is_production || target.confirm_writes;
}

/** バックエンド `db::sandbox::MAX_ROW_FILTER_LEN` (表ごとの抽出条件の最大文字数) と揃える。 */
export const SUBSET_MAX_WHERE_LEN = 2000;

export type SubsetPkConditionResult =
  | { ok: true; condition: string; rootLimit: number }
  | { ok: false; reason: "noPk" | "noRows" | "tooLong" };

/**
 * 結果グリッドで選んだ行を起点にするための、主キー条件 (`pk IN (...)`) を作る。
 *
 * - 単一キー: `"id" IN (1, 2, 3)`。
 * - 複合キー: `("a", "b") IN ((1, 'x'), (2, 'y'))`。SQLite は行値比較を使わず
 *   `("a" = 1 AND "b" = 'x') OR (...)` の連結にする。
 * - NULL・真偽値・単精度 float を含むキーは `IN` で一致しない / 取り違えるので、「UPDATE / DELETE
 *   としてコピー」と同じ述語 (`buildRowWhere`) を OR で足す。
 * - リテラルは `rowValueLiteral` 経由なので、2^53 を超える整数は文字列のまま欠けずに入る。
 *
 * 結果は `checked_row_filter` (読み取り専用条件の検査) を通る形 (`;` やコメントを含まない)。
 * 長さが上限を超えるとき (`tooLong`) はメニューを無効にする。
 * `rootLimit` は重複を除いた選択件数 (起点の最大行数の既定をそれに合わせる)。
 */
export function buildSubsetPkCondition(input: {
  driver: string;
  columns: Column[];
  rows: CellValue[][];
  pkIndices: number[];
}): SubsetPkConditionResult {
  const { driver, columns, rows, pkIndices } = input;
  if (pkIndices.length === 0 || pkIndices.some((i) => !columns[i])) return { ok: false, reason: "noPk" };
  if (rows.length === 0) return { ok: false, reason: "noRows" };

  const simple = new Set<string>();
  const simpleList: string[] = [];
  const fallbackTerms: string[] = [];
  const composite = pkIndices.length > 1;
  const useRowValues = composite && driver !== "sqlite";
  const seen = new Set<string>();
  for (const row of rows) {
    const where = buildRowWhere(driver, columns, row, pkIndices);
    if (where === null || seen.has(where)) continue;
    seen.add(where);
    const lits = rowPkEqualityLiterals(driver, columns, row, pkIndices);
    if (lits && (!composite || useRowValues)) {
      const tuple = composite ? `(${lits.join(", ")})` : (lits[0] ?? "");
      if (!simple.has(tuple)) {
        simple.add(tuple);
        simpleList.push(tuple);
      }
    } else {
      fallbackTerms.push(composite ? `(${where})` : where);
    }
  }
  if (seen.size === 0) return { ok: false, reason: "noRows" };

  const terms: string[] = [];
  if (simpleList.length > 0) {
    const cols = pkIndices.map((i) => quoteIdentFor(driver, columns[i]?.name ?? "")).join(", ");
    const lhs = composite ? `(${cols})` : cols;
    terms.push(`${lhs} IN (${simpleList.join(", ")})`);
  }
  terms.push(...fallbackTerms);
  const condition = terms.join(" OR ");
  if (condition.length > SUBSET_MAX_WHERE_LEN) return { ok: false, reason: "tooLong" };
  return { ok: true, condition, rootLimit: seen.size };
}
