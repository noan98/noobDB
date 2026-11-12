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
import { buildRowWhere, isSinglePrecisionFloat, rowPkEqualityLiterals } from "./cellEdit";
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
  | { ok: false; reason: "noPk" | "noRows" | "tooLong" | "inexactKey" };

/**
 * 結果グリッドで選んだ行を起点にするための、主キー条件 (`pk IN (...)`) を作る。
 *
 * - 単一キー: `"id" IN (1, 2, 3)`。
 * - 複合キー: `("a", "b") IN ((1, 'x'), (2, 'y'))`。SQLite は行値比較を使わず
 *   `("a" = 1 AND "b" = 'x') OR (...)` の連結にする。
 * - NULL・真偽値を含むキーは `IN` で一致しないので、「UPDATE / DELETE としてコピー」と同じ
 *   述語 (`buildRowWhere`) を OR で足す。
 * - 単精度 float (FLOAT4 / REAL / FLOAT) を含むキーは `inexactKey` で失敗する。編集用の述語は
 *   許容誤差つきで、近い値の別の行 (1.0 と 1.0000001 など) まで拾い、起点の件数上限と合わせると
 *   選んでいない行に入れ替わり得るため。
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
  if (pkIndices.some((i) => isSinglePrecisionFloat(driver, columns[i] as Column))) {
    return { ok: false, reason: "inexactKey" };
  }

  const simple = new Set<string>();
  const simpleList: string[] = [];
  const fallbackTerms: string[] = [];
  const composite = pkIndices.length > 1;
  const useRowValues = composite && driver !== "sqlite";
  const seen = new Set<string>();
  // 各項の長さの合計が上限を超えた時点で打ち切る (全体の長さは合計以上になる)。
  let approxLen = 0;
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
        approxLen += tuple.length + 2;
      }
    } else {
      const term = composite ? `(${where})` : where;
      fallbackTerms.push(term);
      approxLen += term.length + 4;
    }
    if (approxLen > SUBSET_MAX_WHERE_LEN) return { ok: false, reason: "tooLong" };
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

/**
 * 「選択した行を起点にサブセット抽出」メニューを無効にする理由の文言キー。出せるなら null。
 * 行の識別キーは unique_key / rowid / ctid / all_columns へフォールバックし得るので、
 * `pkIndices` が空でなくても、strategy が primary_key / unique_key でなければ「主キーなし」
 * として扱う (主キーで IN 条件を作れる表だけを対象にする)。
 */
export function subsetMenuDisabledReason(input: {
  hasTable: boolean;
  identityStrategy: string | undefined;
  pkMasked: boolean;
  built: SubsetPkConditionResult;
}): I18nKey | null {
  const { hasTable, identityStrategy, pkMasked, built } = input;
  if (!hasTable) return "gridExtractSubsetNoTable";
  if (identityStrategy !== "primary_key" && identityStrategy !== "unique_key") return "gridExtractSubsetNoPk";
  if (!built.ok && built.reason === "noPk") return "gridExtractSubsetNoPk";
  if (pkMasked) return "gridExtractSubsetMasked";
  if (!built.ok) {
    if (built.reason === "noRows") return "gridExtractSubsetNoRows";
    if (built.reason === "inexactKey") return "gridExtractSubsetInexactKey";
    return "gridExtractSubsetTooMany";
  }
  return null;
}
