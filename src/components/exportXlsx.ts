import type { ExportFormat, ExportTruncation } from "../api/tauri";
import type { I18nKey } from "../i18n";

// Excel (xlsx) エクスポート (#711) のフロント側の純ロジック。
//
// xlsx の書き出し自体 (値 → セル型の対応・Excel の上限の扱い) はすべてバックエンド
// (`src-tauri/src/commands/export_xlsx.rs`) が持つ。フロントはバイナリを組み立てない
// ので、ここにあるのは「プレビュー可否」と「上限に当たったときの警告文の組み立て」だけ。

/**
 * プレビュー欄・全文コピーに出せるテキスト形式か。xlsx はバイナリ (ZIP) なので
 * 対象外にし、プレビュー欄には「Excel 形式はプレビューできません」を出す。
 */
export function exportFormatHasTextPreview(format: ExportFormat | "bundle"): boolean {
  return format !== "xlsx";
}

export interface ExportNotice {
  key: I18nKey;
  params: Record<string, number>;
}

/**
 * バックエンドが返した上限超過の内訳を、表示する警告文 (i18n キー + パラメータ) へ
 * 変換する。行の打ち切りは「全 N 行中 M 行を書いた (K 行は出ていない)」の形で、
 * 何行で切れたかが分かるようにする。欠けが無ければ空配列。
 */
export function xlsxTruncationNotices(
  truncation: ExportTruncation | null | undefined,
): ExportNotice[] {
  if (!truncation) return [];
  const notices: ExportNotice[] = [];
  if (truncation.droppedRows > 0) {
    notices.push({
      key: "exportXlsxRowsDropped",
      params: {
        written: truncation.writtenRows,
        dropped: truncation.droppedRows,
        total: truncation.writtenRows + truncation.droppedRows,
      },
    });
  }
  if (truncation.truncatedCells > 0) {
    notices.push({
      key: "exportXlsxCellsTruncated",
      params: { cells: truncation.truncatedCells },
    });
  }
  return notices;
}
