import type { CellValue, Column } from "../api/tauri";
import { rowMatchClause, rowValueLiteral } from "./cellEdit";
import { quoteIdentFor } from "./sqlDialect";

/**
 * 結果グリッドの選択範囲をエディタへ挿入する文字列の決定 (#2406)。副作用のない純モジュールで、
 * ポインタ・ドラッグ (`treeDragStore.ts` の `text` アイテム)・右クリックの「エディタへ挿入」・
 * コピーの「条件としてコピー」「IN リストとしてコピー」が同じ整形を共有する。
 *
 * 値のリテラル化は行編集と同じ `rowValueLiteral` (64bit 整数を丸めず、3 ドライバの引用符規則に従う)、
 * NULL の扱いは `fkNavigation.ts` の `matchPredicate` と同じ規約 (`IS NULL`)。
 */

/**
 * - `auto`: 選択の形で決める (1 セル → リテラル / 1 列 → IN / 1 行 → AND 条件)
 * - `where`: 条件式にする (1 セル → `col = v`、1 列 → IN、1 行 → AND)
 * - `in`: 1 列の値を IN リストにする (1 セルでも可)
 */
export type GridInsertKind = "auto" | "where" | "in";

export interface GridInsertSelection {
  driver: string;
  /** 選択範囲に含まれる列 (表示順)。 */
  columns: readonly Column[];
  /** 選択範囲の値。行 × `columns` の行列 (表示順)。 */
  rows: readonly (readonly CellValue[])[];
  /** マスク中のセルを 1 つでも含むか。含むなら値は一切出さない。 */
  masked: boolean;
}

export type GridInsertBlock = "masked" | "empty" | "shape" | "driver";

export type GridInsertPlan =
  | { ok: true; text: string; label: string }
  | { ok: false; reason: GridInsertBlock };

/** ゴースト / ツールチップに出すラベルの最大文字数。 */
const LABEL_MAX = 40;

function labelOf(text: string): string {
  const one = text.replace(/\s+/g, " ");
  return one.length > LABEL_MAX ? `${one.slice(0, LABEL_MAX - 1)}…` : one;
}

function isNull(v: CellValue): boolean {
  return v === null || v === undefined;
}

/**
 * `col IN (v1, v2, ...)`。重複は除き、NULL は `IN` に入れず `IS NULL` を足す (NULL は IN に一致しない)。
 * `=` で厳密に比べられる値だけを IN に入れ、真偽値・単精度 float・MySQL の空間型のように
 * `rowMatchClause` が別の比較式にする値は、その式を OR でつなぐ (IN だと当たらない行が出るため)。
 */
function inPredicate(driver: string, col: Column, values: readonly CellValue[]): string {
  const ident = quoteIdentFor(driver, col.name);
  const seen = new Set<string>();
  const literals: string[] = [];
  const extras: string[] = [];
  const addExtra = (clause: string) => {
    if (!extras.includes(clause)) extras.push(clause);
  };
  for (const v of values) {
    if (isNull(v)) {
      addExtra(`${ident} IS NULL`);
      continue;
    }
    const lit = rowValueLiteral(driver, v, col);
    const clause = rowMatchClause(driver, col, v);
    if (clause !== `${ident} = ${lit}`) {
      addExtra(clause);
      continue;
    }
    if (seen.has(lit)) continue;
    seen.add(lit);
    literals.push(lit);
  }
  // NULL の IS NULL は常に末尾にする。
  const nullIdx = extras.indexOf(`${ident} IS NULL`);
  if (nullIdx >= 0) extras.push(...extras.splice(nullIdx, 1));
  const parts = [...(literals.length > 0 ? [`${ident} IN (${literals.join(", ")})`] : []), ...extras];
  return parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`;
}

function eqPredicate(driver: string, col: Column, v: CellValue): string {
  return rowMatchClause(driver, col, v);
}

/**
 * 行数・列数だけで決まる拒否理由。巨大な選択 (10 万行 × 20 列) でも、値を集める前にこれで弾く。
 * 1 セル / 1 列 / 1 行 (`in` は 1 列) 以外は "shape"。
 */
export function gridInsertShapeBlock(
  kind: GridInsertKind,
  nRows: number,
  nCols: number,
): GridInsertBlock | null {
  if (nRows === 0 || nCols === 0) return "empty";
  if (nCols === 1) return null;
  return nRows === 1 && kind !== "in" ? null : "shape";
}

/** 選択の形と種別から挿入文字列を決める。出せないときは理由を返す。 */
export function planGridInsert(kind: GridInsertKind, sel: GridInsertSelection): GridInsertPlan {
  const nRows = sel.rows.length;
  const nCols = sel.columns.length;
  if (sel.masked) return { ok: false, reason: "masked" };
  if (nRows === 0 || nCols === 0) return { ok: false, reason: "empty" };
  const done = (text: string): GridInsertPlan => ({ ok: true, text, label: labelOf(text) });
  const first = sel.rows[0];

  if (nRows === 1 && nCols === 1) {
    if (kind === "auto") return done(rowValueLiteral(sel.driver, first[0], sel.columns[0]));
    if (kind === "in") return done(inPredicate(sel.driver, sel.columns[0], [first[0]]));
    return done(eqPredicate(sel.driver, sel.columns[0], first[0]));
  }
  if (nCols === 1) {
    return done(
      inPredicate(
        sel.driver,
        sel.columns[0],
        sel.rows.map((r) => r[0]),
      ),
    );
  }
  // 1 行の複数列。IN リストは 1 列のときだけ。
  if (nRows === 1 && kind !== "in") {
    return done(sel.columns.map((c, i) => eqPredicate(sel.driver, c, first[i])).join(" AND "));
  }
  return { ok: false, reason: "shape" };
}

export interface GridInsertSelectionInput {
  driver: string;
  /** 結果の全列 (元の列順)。 */
  columns: readonly Column[];
  /** 結果の全行 (元の行順)。 */
  rows: readonly (readonly CellValue[])[];
  /** 選択範囲の行 (元の行 index、表示順)。 */
  rowIndices: readonly number[];
  /** 選択範囲の列 (元の列 index、表示順)。 */
  colIndices: readonly number[];
  /** マスク中 (#1069) か。 */
  isMasked: (rowIdx: number, colIdx: number) => boolean;
}

/** グリッドの選択範囲 (元の行・列 index) を `planGridInsert` の入力へ変換する。 */
export function buildGridInsertSelection(input: GridInsertSelectionInput): GridInsertSelection {
  const { rowIndices, colIndices } = input;
  const masked = rowIndices.some((ri) => colIndices.some((ci) => input.isMasked(ri, ci)));
  return {
    driver: input.driver,
    columns: colIndices.flatMap((ci) => (input.columns[ci] ? [input.columns[ci]] : [])),
    // マスク中は値を持ち出さない (計画側でも拒否するが、念のため行列に載せない)。
    rows: masked ? [] : rowIndices.map((ri) => colIndices.map((ci) => input.rows[ri]?.[ci] ?? null)),
    masked,
  };
}
