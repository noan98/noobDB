import { toBlob, toSvg } from "html-to-image";
import { api } from "../api/tauri";

/**
 * チャート (`ChartView`) と ER 図 (`ERDiagramView`) の画像エクスポート共通ロジック
 * (#643)。`html-to-image` で DOM サブツリーを画像化する — 計算済みスタイルをクローンに
 * インライン化するため、CSS 変数 (`--bg` / `--text` / `--accent` ...) で着色している
 * テーマ色がライト/ダークどちらでも正しく焼き込まれる。
 *
 * 保存はバックエンドの `write_binary_file` 経由で行い (capabilities を増やさない方針)、
 * クリップボードコピーは `ClipboardItem` を使う。
 */

/** 画像化時の既定ピクセル比 (Retina 相当の解像度で書き出す)。 */
const DEFAULT_PIXEL_RATIO = 2;

/** 現在のテーマの背景色を CSS 変数から解決する。透過ではなく不透明背景で焼き込む。 */
export function themeBackground(): string {
  if (typeof getComputedStyle === "undefined") return "#ffffff";
  const v = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  return v || "#ffffff";
}

/** PNG の解像度倍率 (ピクセル比)。 */
export type ExportScale = 1 | 2 | 3;
export const EXPORT_SCALES: readonly ExportScale[] = [1, 2, 3];
/** PNG の背景: 現在のテーマの背景 / 白 / 透過。 */
export type ExportBackground = "theme" | "white" | "transparent";
export const EXPORT_BACKGROUNDS: readonly ExportBackground[] = ["theme", "white", "transparent"];

/** `makePng` へ渡す、倍率と背景色の解決済みオプション。 */
export interface PngExportOptions {
  pixelRatio: number;
  /** CSS の色指定 (`transparent` を含む)。 */
  background: string;
}

/**
 * 画像書き出しメニューで選んだ倍率と背景から、`elementToPngBlob` へ渡す値を作る (#1628)。
 * `theme` はその時点のテーマ背景 (ダークテーマの見た目をそのまま焼き込む)。
 */
export function resolvePngExportOptions(scale: ExportScale, background: ExportBackground): PngExportOptions {
  return {
    pixelRatio: scale,
    background:
      background === "white" ? "#ffffff" : background === "transparent" ? "transparent" : themeBackground(),
  };
}

/**
 * `data:` URL をバイト列へデコードする純関数。`base64` (`;base64,`) と
 * URI エンコード (SVG の `toSvg` が返す形式) の両方に対応する。テスト可能なように
 * DOM に依存しない形 (atob / decodeURIComponent のみ) で実装する。
 */
export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || comma < 0) {
    throw new Error("invalid data URL");
  }
  const meta = dataUrl.slice(5, comma);
  const payload = dataUrl.slice(comma + 1);
  if (/;base64/i.test(meta)) {
    const bin = atob(payload);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  // URI エンコードされたテキスト (主に SVG)。UTF-8 へエンコードして返す。
  return new TextEncoder().encode(decodeURIComponent(payload));
}

async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** 要素を PNG の Blob 化する。背景色とピクセル比を指定する。 */
export async function elementToPngBlob(
  el: HTMLElement,
  opts?: {
    background?: string;
    pixelRatio?: number;
    width?: number;
    height?: number;
    style?: Partial<CSSStyleDeclaration>;
  },
): Promise<Blob> {
  const blob = await toBlob(el, {
    backgroundColor: opts?.background ?? themeBackground(),
    pixelRatio: opts?.pixelRatio ?? DEFAULT_PIXEL_RATIO,
    width: opts?.width,
    height: opts?.height,
    style: opts?.style as Record<string, string> | undefined,
    cacheBust: true,
  });
  if (!blob) throw new Error("failed to rasterize element to PNG");
  return blob;
}

/** 要素を SVG のバイト列にする (ベクタ保存用)。 */
export async function elementToSvgBytes(
  el: HTMLElement,
  opts?: { background?: string; width?: number; height?: number; style?: Partial<CSSStyleDeclaration> },
): Promise<Uint8Array> {
  const dataUrl = await toSvg(el, {
    backgroundColor: opts?.background ?? themeBackground(),
    width: opts?.width,
    height: opts?.height,
    style: opts?.style as Record<string, string> | undefined,
    cacheBust: true,
  });
  return dataUrlToBytes(dataUrl);
}

/** バイト列を保存ダイアログで選んだパスへ書き出す。 */
export async function saveImageBytes(path: string, bytes: Uint8Array): Promise<number> {
  return api.writeBinaryFile(path, bytes);
}

/**
 * PNG の Blob をクリップボードへ画像としてコピーする。`ClipboardItem` 非対応の
 * webview では false を返す (呼び出し側でトーストにフォールバック)。
 */
export async function copyPngToClipboard(blob: Blob): Promise<boolean> {
  try {
    if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return false;
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return true;
  } catch {
    return false;
  }
}

export { blobToBytes };

/** ER 図の全景エクスポート時に内容の周囲へ取る余白 (px)。 */
const ER_EXPORT_PADDING = 40;
/** 出力画像の 1 辺の上限 (px)。巨大スキーマで過大なキャンバスを避ける。 */
const ER_EXPORT_MAX_DIM = 8000;

/**
 * 全景エクスポートの出力サイズと変換を求める。内容が `ER_EXPORT_MAX_DIM` を超えるときは
 * 切り捨てずに縮小 (scale < 1) して全体を収める。
 */
export function erExportGeometry(bounds: { x: number; y: number; width: number; height: number }): {
  width: number;
  height: number;
  tx: number;
  ty: number;
  scale: number;
} {
  const pad = ER_EXPORT_PADDING;
  const fullW = Math.max(1, bounds.width + pad * 2);
  const fullH = Math.max(1, bounds.height + pad * 2);
  const scale = Math.min(1, ER_EXPORT_MAX_DIM / fullW, ER_EXPORT_MAX_DIM / fullH);
  return {
    width: Math.min(ER_EXPORT_MAX_DIM, Math.max(1, Math.ceil(fullW * scale))),
    height: Math.min(ER_EXPORT_MAX_DIM, Math.max(1, Math.ceil(fullH * scale))),
    tx: (-bounds.x + pad) * scale,
    ty: (-bounds.y + pad) * scale,
    scale,
  };
}
