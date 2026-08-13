import type { CellValue, Column } from "../api/tauri";
import { editIsNoop, rowEditKey } from "./cellEdit";
import type { BulkEditTarget } from "./bulkEdit";

/**
 * 結果グリッドへのクリップボード貼り付けによる複数セル一括編集 (#793)。
 *
 * `ResultGrid` の矩形選択 TSV コピー (`copySelection`) と対称の取り込み経路。
 * Excel/Google スプレッドシートで整えた表をクリップボード経由でグリッドへ流し込み、
 * アンカーセル (選択の左上、または単一のアクティブセル) を起点に貼り付け範囲を展開
 * して既存の `PendingEdits` バッファへ積む。1x1 の単一値貼り付けを既存の矩形選択へ
 * 展開するケースは `planBulkCellEdit` (#596) をそのまま再利用するため対象外 — 呼び
 * 出し側 (`ResultGrid`) がその分岐を先に処理してからここへは 2 セル以上の矩形貼り
 * 付けのみが渡る想定。
 *
 * `planBulkCellEdit` と同じく編集不可列・型不正値は個別にスキップし (validate/
 * isColEditable を共有インターフェースとして受け取る)、DOM 非依存の純ロジックとして
 * `__tests__/pasteEdit.test.ts` で検証する。
 */
export interface PastePlan {
  /** 実際に値が変わるセル。 */
  applied: BulkEditTarget[];
  /** すでに同じ値を持っていたセル (`value: null` = 保留編集の解除)。 */
  unchanged: BulkEditTarget[];
  /** 値が適用される個別の行数。 */
  rowCount: number;
  /** 編集不可列のためスキップしたセル数。 */
  skippedReadonly: number;
  /** 貼り付け値が列型に対して不正なためスキップしたセル数。 */
  skippedInvalid: number;
  /**
   * 貼り付け範囲が現在表示中の行/列数を超えたためスキップしたセル数。
   * 行の自動追加 (INSERT 化) はスコープ外 — 足りない行/列はここに計上して
   * トーストで件数を提示する (「何もしないより保守的に伝える」方針)。
   */
  skippedOutOfBounds: number;
}

export interface PlanPasteEditInput {
  /** クリップボードを `parseClipboardGrid` で解析した行×列の生テキスト。 */
  grid: string[][];
  /** 結果行 (元の行順)。 */
  rows: CellValue[][];
  /** 結果列メタ。 */
  columns: Column[];
  /** PK 列の添字 (空なら PK 解決不能 = 対象外)。 */
  pkIndices: number[];
  /**
   * 貼り付け先の行の元添字 (表示順)。`grid` の行番号に対応し、`grid.length` より
   * 短ければ超過分は `skippedOutOfBounds` へ計上する。
   */
  targetRowIndices: number[];
  /**
   * 貼り付け先の列の元添字 (表示順)。`grid` の各行の列番号に対応し、行ごとの
   * 列数がこの配列長を超える場合は超過分を `skippedOutOfBounds` へ計上する。
   */
  targetColIndices: number[];
  /** 列が編集可能か。BLOB / 読み取り専用などは false。 */
  isColEditable: (colIdx: number) => boolean;
  /** 値が列型に対して妥当か。妥当なら null、問題があれば任意のキー (truthy)。 */
  validate: (colIdx: number, value: string) => unknown;
}

/**
 * 解析済みクリップボードグリッドと貼り付け先座標から、実際に適用する pending edit
 * のリストとスキップ件数を算出する。行は PK で特定するため `pkIndices` が空なら
 * 空計画を返す (`planBulkCellEdit` と同じ安全方針)。
 */
export function planPasteEdit(input: PlanPasteEditInput): PastePlan {
  const applied: BulkEditTarget[] = [];
  const unchanged: BulkEditTarget[] = [];
  let skippedReadonly = 0;
  let skippedInvalid = 0;
  let skippedOutOfBounds = 0;
  if (input.pkIndices.length === 0) {
    return { applied, unchanged, rowCount: 0, skippedReadonly: 0, skippedInvalid: 0, skippedOutOfBounds: 0 };
  }
  const touchedRows = new Set<string>();
  for (let r = 0; r < input.grid.length; r++) {
    const gridRow = input.grid[r];
    const rowIdx = input.targetRowIndices[r];
    if (rowIdx === undefined) {
      // 対応する表示行がもう無い — この行以降はすべて範囲外。行ごとに列数が
      // 異なりうる (不揃いな TSV) ため、残り行それぞれの実セル数を合算する。
      for (let rr = r; rr < input.grid.length; rr++) {
        skippedOutOfBounds += input.grid[rr].length;
      }
      break;
    }
    const row = input.rows[rowIdx];
    if (!row) continue;
    const rowKey = rowEditKey(row, input.pkIndices, rowIdx);
    for (let c = 0; c < gridRow.length; c++) {
      const colIdx = input.targetColIndices[c];
      if (colIdx === undefined) {
        skippedOutOfBounds++;
        continue;
      }
      const col = input.columns[colIdx];
      if (!col) continue;
      if (!input.isColEditable(colIdx)) {
        skippedReadonly++;
        continue;
      }
      const value = gridRow[c];
      if (input.validate(colIdx, value)) {
        skippedInvalid++;
        continue;
      }
      if (editIsNoop(value, col, row[colIdx])) {
        unchanged.push({ rowKey, colIdx, value: null });
        continue;
      }
      applied.push({ rowKey, colIdx, value });
      touchedRows.add(rowKey);
    }
  }
  return {
    applied,
    unchanged,
    rowCount: touchedRows.size,
    skippedReadonly,
    skippedInvalid,
    skippedOutOfBounds,
  };
}

/**
 * TSV (タブ区切り) クリップボードテキストを行×列の生テキスト配列へ解析する。
 * Excel/Google スプレッドシートの範囲コピーが吐く形式 — セル区切りはタブ、行区切りは
 * 改行 (`\r\n` / `\n` を正規化)、タブ・改行・二重引用符を含むセルはダブルクオートで
 * 囲われ内部の `"` は `""` に二重化される (`ResultGrid.copySelection` が書き出す
 * プレーンな TSV とは非対称だが、貼り付け側は Excel 実物の出力を受け付ける必要がある)。
 *
 * 範囲コピー後の末尾には規則的に空行が 1 つ付く (Excel/Sheets とも) ため、末尾が
 * 単一の空フィールドだけの行ならその 1 行を落とす — そうしないと貼り付けのたびに
 * 余分な空行ぶん `skippedOutOfBounds` が計上されてしまう。
 */
export function parseClipboardGrid(text: string): string[][] {
  const src = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === "\t") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  row.push(field);
  rows.push(row);
  if (rows.length > 1) {
    const last = rows[rows.length - 1];
    if (last.length === 1 && last[0] === "") rows.pop();
  }
  return rows;
}
