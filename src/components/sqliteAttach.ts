import type { SqliteAttachment } from "../api/tauri";

/** 同時にアタッチできるファイル数の上限 (バックエンドの `SQLITE_MAX_ATTACHED`, #2153)。 */
export const MAX_ATTACHED = 10;

/** 別名の最大長 (バックエンドの `is_valid_attach_alias`)。 */
const MAX_ATTACH_ALIAS_LENGTH = 64;

/** バックエンド (`is_valid_attach_alias`) と同じ規則: 英数字と `_`、先頭は数字不可、`main` / `temp` は不可。 */
export function isValidAttachAlias(alias: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) return false;
  const l = alias.toLowerCase();
  if (alias.length > MAX_ATTACH_ALIAS_LENGTH) return false;
  return l !== "main" && l !== "temp";
}

/**
 * ファイル名 (拡張子なし) から、既存の別名と重ならない別名の候補を作る (#2129)。
 * 接頭辞 `db_` / 接尾辞 `_db` / 連番 `_2` を付けても最大長 (64) を超えないよう、語幹の側を切り詰める (#2153)。
 */
export function suggestAttachAlias(path: string, existing: readonly SqliteAttachment[]): string {
  const file = path.split(/[\\/]/).pop() ?? "";
  const stem = file.replace(/\.[^.]*$/, "");
  // `db_` / `_db` の 3 文字分を空けてから、接頭辞・接尾辞を付ける。
  let base = stem.replace(/[^A-Za-z0-9_]/g, "_").slice(0, MAX_ATTACH_ALIAS_LENGTH - 3);
  if (base === "" || /^[0-9]/.test(base)) base = `db_${base}`;
  if (!isValidAttachAlias(base)) base = `${base}_db`;
  const used = new Set(existing.map((a) => a.alias.trim().toLowerCase()));
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n++) {
    const suffix = `_${n}`;
    name = `${base.slice(0, MAX_ATTACH_ALIAS_LENGTH - suffix.length)}${suffix}`;
  }
  return name;
}

/**
 * `index` 番目の行の別名の問題 (空は未入力なので問題にしない)。`invalid` は形式の誤り、`duplicate` は
 * 先に出てきた行と大文字小文字を除いて同じ別名 (バックエンド `validate_attachments` と同じ規則)。
 */
export function attachAliasProblem(
  attachments: readonly SqliteAttachment[],
  index: number,
): "invalid" | "duplicate" | null {
  const alias = (attachments[index]?.alias ?? "").trim();
  if (alias === "") return null;
  if (!isValidAttachAlias(alias)) return "invalid";
  const lower = alias.toLowerCase();
  const dup = attachments.slice(0, index).some((a) => a.alias.trim().toLowerCase() === lower);
  return dup ? "duplicate" : null;
}

/** 保存・接続テスト前の検証で見つかる問題 (バックエンド `AttachProblem` と同じ名前, #2153)。 */
type AttachmentsProblem = "tooMany" | "invalidAlias" | "duplicateAlias" | "pathRequired";

/** 前後の空白を除き、パスも別名も空の行を捨てる (保存・接続テストに送る行。バックエンドの `save_profile` と同じ)。 */
export function cleanAttachments(attachments: readonly SqliteAttachment[]): SqliteAttachment[] {
  return attachments
    .map((a) => ({ path: a.path.trim(), alias: a.alias.trim() }))
    .filter((a) => a.path !== "" || a.alias !== "");
}

/**
 * ATTACH 設定の最初の問題 (バックエンド `attachment_settings_problem` の写し。共有ゴールデン
 * `sqliteAttachVectors.json` で一致を固定)。判定の順序は 件数 → 行ごとに (別名の形式 → 重複 → パスの有無)。
 * `attachments` は `cleanAttachments` 済みのものを渡す。ファイルの存在は接続時にだけ見る。
 */
export function attachmentsProblem(attachments: readonly SqliteAttachment[]): AttachmentsProblem | null {
  if (attachments.length > MAX_ATTACHED) return "tooMany";
  const seen = new Set<string>();
  for (const a of attachments) {
    if (!isValidAttachAlias(a.alias)) return "invalidAlias";
    const lower = a.alias.toLowerCase();
    if (seen.has(lower)) return "duplicateAlias";
    seen.add(lower);
    if (a.path.trim() === "" || a.path.includes("\0")) return "pathRequired";
  }
  return null;
}

/**
 * `index` 番目の行に出す問題。入力途中を責めないよう、空の別名・空のパスは `showIncomplete` (保存や
 * 接続テストを試みた後) のときだけ返す。形式の誤りと重複は常に返す。
 */
export function attachRowProblem(
  attachments: readonly SqliteAttachment[],
  index: number,
  showIncomplete: boolean,
): "invalid" | "duplicate" | "aliasRequired" | "pathRequired" | null {
  const row = attachments[index];
  if (!row) return null;
  const live = attachAliasProblem(attachments, index);
  if (live) return live;
  if (!showIncomplete) return null;
  const alias = row.alias.trim();
  const path = row.path.trim();
  if (alias === "" && path !== "") return "aliasRequired";
  if (alias !== "" && (path === "" || path.includes("\0"))) return "pathRequired";
  return null;
}
