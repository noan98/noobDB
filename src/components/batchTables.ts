// スキーマツリーで複数選択したテーブルの一括操作 (#1399) の純ロジック。
//
// DDL の連結・エクスポートのファイル名・確認ダイアログに並べるテーブル名の整形。
// 実行 (IPC) は呼び出し側が既存コマンドを束ねる。副作用が無いので Vitest で固定する。

import type { ExportFormat } from "../api/tauri";

/** 各テーブルの DDL を、末尾 `;` と空行で区切った 1 本のスクリプトに連結する。 */
export function joinTableDdls(entries: readonly { table: string; ddl: string }[]): string {
  return entries
    .map(({ ddl }) => {
      const body = ddl.trim();
      return body.endsWith(";") ? body : `${body};`;
    })
    .filter((s) => s !== ";")
    .join("\n\n");
}

/** 出力形式 → ファイル拡張子 (ドット付き)。`ExportModal` の保存名と同じ対応。 */
export function exportFileExtension(format: ExportFormat): string {
  switch (format) {
    case "csv":
      return ".csv";
    case "ndjson":
      return ".ndjson";
    case "markdown":
      return ".md";
    case "sql":
      return ".sql";
    case "xlsx":
      return ".xlsx";
    default:
      return ".json";
  }
}

/** ファイル名に使えない文字 (Windows の予約文字・制御文字・パス区切り) を `_` にする。 */
function sanitizeFileStem(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/[ .]+$/, "");
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "table" : cleaned;
}

/**
 * テーブルごとの出力ファイル名。名前が (大文字小文字を無視して) 衝突したら `_2`, `_3` を付けて
 * 上書きし合わないようにする (macOS / Windows は大文字小文字を区別しないファイルシステムが既定)。
 * `used` は呼び出し側が全テーブルで共有する小文字化済みの名前の集合で、この関数が追記する。
 */
export function batchExportFileName(table: string, format: ExportFormat, used: Set<string>): string {
  const ext = exportFileExtension(format);
  const stem = sanitizeFileStem(table);
  let candidate = stem;
  for (let n = 2; used.has(`${candidate}${ext}`.toLowerCase()); n++) candidate = `${stem}_${n}`;
  const file = `${candidate}${ext}`;
  used.add(file.toLowerCase());
  return file;
}

/** 確認ダイアログ用にテーブル名を並べる。多いときは先頭 `max` 件と「ほか N 件」に畳む。 */
export function summarizeTableNames(
  tables: readonly string[],
  max: number,
  moreLabel: (count: number) => string,
): string {
  if (tables.length <= max) return tables.join(", ");
  return `${tables.slice(0, max).join(", ")}, ${moreLabel(tables.length - max)}`;
}
