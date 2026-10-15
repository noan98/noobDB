import { useState } from "react";
import { EXPORT_BACKGROUNDS, EXPORT_SCALES, type ExportBackground, type ExportScale } from "./imageExport";

/**
 * 画像書き出しの倍率と背景色の既定 (#1628)。チャート・ER 図・実行計画のどの書き出しでも
 * 同じ選択を使う。ブラウザの localStorage に覚えるだけの per-viewer の設定で、読めない・
 * 壊れているときは既定 (2x・テーマの背景) に倒す。
 */
export interface ImageExportPrefs {
  scale: ExportScale;
  background: ExportBackground;
}

export const DEFAULT_IMAGE_EXPORT_PREFS: ImageExportPrefs = { scale: 2, background: "theme" };

const STORAGE_KEY = "noobdb.imageExport.v1";

/** 保存値を検証して `ImageExportPrefs` にする。未知の値は既定に倒す。 */
export function sanitizeImageExportPrefs(raw: unknown): ImageExportPrefs {
  if (!raw || typeof raw !== "object") return DEFAULT_IMAGE_EXPORT_PREFS;
  const o = raw as Record<string, unknown>;
  const scale = EXPORT_SCALES.find((s) => s === o.scale) ?? DEFAULT_IMAGE_EXPORT_PREFS.scale;
  const background =
    EXPORT_BACKGROUNDS.find((b) => b === o.background) ?? DEFAULT_IMAGE_EXPORT_PREFS.background;
  return { scale, background };
}

export function readImageExportPrefs(): ImageExportPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null ? DEFAULT_IMAGE_EXPORT_PREFS : sanitizeImageExportPrefs(JSON.parse(raw));
  } catch {
    return DEFAULT_IMAGE_EXPORT_PREFS;
  }
}

export function writeImageExportPrefs(prefs: ImageExportPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // ignore (private mode, quota)
  }
}

export function usePersistedImageExportPrefs(): [ImageExportPrefs, (next: ImageExportPrefs) => void] {
  const [prefs, setState] = useState<ImageExportPrefs>(readImageExportPrefs);
  const setPrefs = (next: ImageExportPrefs) => {
    setState(next);
    writeImageExportPrefs(next);
  };
  return [prefs, setPrefs];
}
