import type { SqliteAttachment } from "../api/tauri";

/** バックエンド (`is_valid_attach_alias`) と同じ規則: 英数字と `_`、先頭は数字不可、`main` / `temp` は不可。 */
export function isValidAttachAlias(alias: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) return false;
  const l = alias.toLowerCase();
  if (alias.length > 64) return false;
  return l !== "main" && l !== "temp";
}

/** ファイル名 (拡張子なし) から、既存の別名と重ならない別名の候補を作る (#2129)。 */
export function suggestAttachAlias(path: string, existing: readonly SqliteAttachment[]): string {
  const file = path.split(/[\\/]/).pop() ?? "";
  const stem = file.replace(/\.[^.]*$/, "");
  let base = stem.replace(/[^A-Za-z0-9_]/g, "_");
  if (base === "" || /^[0-9]/.test(base)) base = `db_${base}`;
  if (!isValidAttachAlias(base)) base = `${base}_db`;
  const used = new Set(existing.map((a) => a.alias.toLowerCase()));
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}_${n}`;
  return name;
}
