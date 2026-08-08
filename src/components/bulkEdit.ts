import type { CellValue, Column } from "../api/tauri";
import { editIsNoop, rowEditKey } from "./cellEdit";

/**
 * 結果グリッドの複数セル一括編集 (#596)。
 *
 * 矩形範囲 (または複数セル) を選択した状態で「選択セルに値を設定」したときに、
 * 入力した単一値 / NULL を選択セル全体へ展開する**純ロジック**。各セルを既存の
 * pending edit へ積み、Apply 時に `buildUpdateStatements` が 1 トランザクションで
 * 複数 UPDATE を発行する (`run_query_transaction` の all-or-nothing を再利用)。
 *
 * 本モジュールはどのセルを編集対象にするか (型不一致 / 編集不可列のスキップ判定) を
 * 決めるだけで、SQL 生成自体は `cellEdit.ts` の `buildUpdateStatements` が担う。
 * DOM 非依存・副作用なしなので Vitest で直接検証する (`__tests__/bulkEdit.test.ts`)。
 *
 * ## 保守的な方針
 *
 * - **PK 欠如テーブルは対象外。** `pkIndices` が空だと各行を WHERE で特定できず安全な
 *   UPDATE を組めないため、空の計画を返す (呼び出し側は UI を出さない / 無効化する)。
 * - 編集不可列 (`isColEditable` が false。BLOB 等) と、入力値が列型に対して不正なセルは
 *   個別にスキップし、その件数を返してユーザに提示できるようにする。
 */
export interface BulkEditTarget {
  /** 行の安定 ID (`rowEditKey`)。pending edit のキーになる。 */
  rowKey: string;
  /** `columns` 上の列添字。 */
  colIdx: number;
  /**
   * 適用する生の入力値 ("NULL" は SQL NULL)。選択セル全体で共通。
   * `null` は「値ではなく、このセルの保留編集を**解除**する」意味で、セルが
   * すでにその値を持っていた (= 編集が無変更になる) ときに使う。
   */
  value: string | null;
}

export interface BulkEditPlan {
  /** 実際に値が変わるセル (rowKey + colIdx + 値)。 */
  applied: BulkEditTarget[];
  /**
   * すでにその値を持っていたセル。`value: null` を積んであり、呼び出し側は
   * `applied` と一緒に渡すことで、そのセルに残っていた保留編集を解除できる
   * (単一セル編集の no-op 判定と挙動を揃えるため。`editIsNoop` を参照)。
   */
  unchanged: BulkEditTarget[];
  /** 値が適用される個別の行数 (重複 PK は 1 行に畳む)。 */
  rowCount: number;
  /** 編集不可列のためスキップしたセル数。 */
  skippedReadonly: number;
  /** 入力値が列型に対して不正なためスキップしたセル数。 */
  skippedInvalid: number;
}

export interface PlanBulkEditInput {
  /** 結果行 (元の行順)。 */
  rows: CellValue[][];
  /** 結果列メタ。 */
  columns: Column[];
  /** PK 列の添字 (空なら PK 解決不能 = 対象外)。 */
  pkIndices: number[];
  /** 選択範囲が覆う元の行添字。 */
  rowIndices: number[];
  /** 選択範囲が覆う列添字。 */
  colIndices: number[];
  /** 全セルに適用する単一値 / NULL (生入力)。 */
  value: string;
  /** 列が編集可能か (`columns` の添字で判定)。BLOB / 読み取り専用などは false。 */
  isColEditable: (colIdx: number) => boolean;
  /**
   * 値が列型に対して妥当か。妥当なら null、問題があれば任意のキー (truthy) を返す。
   * `cellEdit.ts` の `validateCellInput` をラップして渡す想定。
   */
  validate: (colIdx: number, value: string) => unknown;
}

/**
 * 選択範囲 × 単一値から、実際に適用する pending edit のリストとスキップ件数を算出する。
 * 行は PK で特定するため `pkIndices` が空なら空計画を返す。各 (行, 列) について編集
 * 可能性と型妥当性を確認し、通ったセルだけ `applied` に積む。
 *
 * すでに同じ値を持っているセルは `applied` ではなく `unchanged` へ回す。無変更の
 * `SET col = <同じ値>` を Apply で発行せず、保留編集の件数表示も実際に変わるセル
 * だけを数えるためで、単一セル編集の no-op 判定 (`editIsNoop`) と挙動が揃う。
 */
export function planBulkCellEdit(input: PlanBulkEditInput): BulkEditPlan {
  const applied: BulkEditTarget[] = [];
  const unchanged: BulkEditTarget[] = [];
  let skippedReadonly = 0;
  let skippedInvalid = 0;
  // PK 欠如テーブルは安全のため一括編集の対象外。
  if (input.pkIndices.length === 0) {
    return { applied, unchanged, rowCount: 0, skippedReadonly: 0, skippedInvalid: 0 };
  }
  const touchedRows = new Set<string>();
  // 列の編集可否は行に依らないので先に一度だけ判定し、不可列は選択セル数ぶん
  // まとめてスキップ計上する。
  const editableCols = input.colIndices.filter((c) => input.columns[c] !== undefined);
  for (const rowIdx of input.rowIndices) {
    const row = input.rows[rowIdx];
    if (!row) continue;
    const rowKey = rowEditKey(row, input.pkIndices, rowIdx);
    for (const colIdx of editableCols) {
      if (!input.isColEditable(colIdx)) {
        skippedReadonly++;
        continue;
      }
      if (input.validate(colIdx, input.value)) {
        skippedInvalid++;
        continue;
      }
      // すでにその値のセルは編集を積まず、逆に残っている保留編集を解除する。
      if (editIsNoop(input.value, input.columns[colIdx], row[colIdx])) {
        unchanged.push({ rowKey, colIdx, value: null });
        continue;
      }
      applied.push({ rowKey, colIdx, value: input.value });
      touchedRows.add(rowKey);
    }
  }
  return { applied, unchanged, rowCount: touchedRows.size, skippedReadonly, skippedInvalid };
}
