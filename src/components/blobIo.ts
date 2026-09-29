import type { CellValue, Column } from "../api/tauri";

/**
 * BLOB / バイナリセルのファイル入出力とプレビューの純ロジック (#1148)。
 * 生バイトは 16 進文字列 (`Value::Bytes` の wire 形式) で扱う。
 */

/** 読み込める BLOB の上限。Rust 側 `MAX_CELL_BLOB_BYTES` と揃える (16 MiB)。 */
export const MAX_BLOB_BYTES = 16 * 1024 * 1024;

/** インライン画像プレビューを出す上限 (デコード・描画コストを抑える)。 */
export const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

export interface BlobKind {
  mime: string;
  /** 保存ダイアログの既定拡張子 (ドット無し)。 */
  ext: string;
  /** `<img>` でそのまま描画できる画像か。 */
  image: boolean;
}

/** 16 進文字列 → バイト列。奇数長・非 16 進文字は null。 */
export function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  return sig.every((b, i) => bytes[offset + i] === b);
}

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

/** マジックバイトから MIME を推定する。判別できなければ null。 */
export function detectBlobKind(bytes: Uint8Array): BlobKind | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { mime: "image/png", ext: "png", image: true };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", ext: "jpg", image: true };
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a")))
    return { mime: "image/gif", ext: "gif", image: true };
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8))
    return { mime: "image/webp", ext: "webp", image: true };
  if (startsWith(bytes, ascii("BM")) && bytes.length >= 14)
    return { mime: "image/bmp", ext: "bmp", image: true };
  if (startsWith(bytes, ascii("%PDF-"))) return { mime: "application/pdf", ext: "pdf", image: false };
  if (startsWith(bytes, [0x1f, 0x8b])) return { mime: "application/gzip", ext: "gz", image: false };
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]))
    return { mime: "application/zip", ext: "zip", image: false };
  return null;
}

/** 先頭の数バイトだけをデコードして MIME を推定する (巨大な 16 進文字列を全復号しない)。 */
export function detectBlobKindFromHex(hex: string): BlobKind | null {
  const head = hex.slice(0, 64);
  const bytes = hexToBytes(head.length % 2 === 0 ? head : head.slice(0, -1));
  return bytes ? detectBlobKind(bytes) : null;
}

/** 保存ダイアログの既定ファイル名。列名からパス区切り等を除き、推定拡張子 (無ければ bin) を付ける。 */
export function blobFileName(columnName: string, kind: BlobKind | null): string {
  const base = columnName.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "blob";
  return `${base}.${kind?.ext ?? "bin"}`;
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
