import type { CellValue, Column } from "../api/tauri";

/**
 * BLOB / バイナリセルのファイル入出力とプレビューの純ロジック (#1148)。
 * グリッド上の値は 16 進文字列 (`Value::Bytes` の wire 形式) だが、ファイル保存・
 * 画像プレビューは生バイトのまま IPC を通る (#1258)。種別判定 (マジックバイト) は
 * バックエンドの `probe_cell_blob` に集約した。
 */

/** 読み込める BLOB の上限。Rust 側 `MAX_CELL_BLOB_BYTES` と揃える (16 MiB)。 */
export const MAX_BLOB_BYTES = 16 * 1024 * 1024;

/** インライン画像プレビューを出す上限 (デコード・描画コストを抑える)。 */
export const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

/** バイト列 → 16 進文字列 (小文字)。ファイルから読んだ内容で UPDATE 文を組むために使う。 */
export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * 保存ダイアログの既定ファイル名。列名からパス区切り等を除き、推定拡張子 (無ければ
 * bin) を付ける。拡張子はバックエンドの probe (`probe_cell_blob`) が判定して返す。
 */
export function blobFileName(columnName: string, ext: string | null): string {
  const base = columnName.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "blob";
  return `${base}.${ext ?? "bin"}`;
}

/** バイト数の短い表記 (1024 進)。 */
export function formatBlobSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export interface BlobKeyPart {
  column: string;
  value: CellValue;
}

/**
 * 行を一意に指す主キー (列名と値) を作る。キーが空・NULL を含む・バイナリ列を
 * 含む場合は null — 誤った行を引いて書き戻すことを避けるため保守的に無効化する。
 */
export function blobKeyParts(
  columns: Column[],
  row: CellValue[],
  pkIndices: number[],
  isBinaryColumn: (colIdx: number) => boolean,
): BlobKeyPart[] | null {
  if (pkIndices.length === 0) return null;
  const parts: BlobKeyPart[] = [];
  for (const i of pkIndices) {
    const col = columns[i];
    const v = row[i];
    if (!col || v === null || v === undefined || isBinaryColumn(i)) return null;
    parts.push({ column: col.name, value: v });
  }
  return parts;
}
