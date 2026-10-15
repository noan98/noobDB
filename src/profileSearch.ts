// 接続プロファイルカード一覧の絞り込み (#1630)。名前・ホスト・DB 名・ファイル名・グループの
// 部分一致 (大小無視) と、グループのチップによる絞り込みを組み合わせる純関数。

import type { ConnectionProfile } from "./api/tauri";

/** 「未分類」のチップを表す値。実在のグループ名と衝突しないよう空文字にする。 */
export const UNGROUPED_FILTER = "";

/** 絞り込みの対象にする文字列 (小文字化済み)。 */
function haystack(p: ConnectionProfile): string {
  return [p.name, p.host, p.database ?? "", p.file_path ?? "", p.group ?? "", p.user]
    .join("\n")
    .toLowerCase();
}

/**
 * 検索語 `query` (空白区切りの AND) とグループ `group` で絞り込む。`group` が `null` なら
 * グループは問わず、`UNGROUPED_FILTER` なら未分類のみ。元の並びは保つ。
 */
export function filterProfileCards(
  profiles: readonly ConnectionProfile[],
  query: string,
  group: string | null,
): ConnectionProfile[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return profiles.filter((p) => {
    if (group !== null && (p.group ?? UNGROUPED_FILTER) !== group) return false;
    if (terms.length === 0) return true;
    const hay = haystack(p);
    return terms.every((term) => hay.includes(term));
  });
}

/** グループのチップに出す名前の一覧 (名前順、未分類は含めない)。 */
export function profileGroupNames(profiles: readonly ConnectionProfile[]): string[] {
  const names = new Set<string>();
  for (const p of profiles) if (p.group) names.add(p.group);
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** 検索欄とチップを出すしきい値 (これ未満の件数なら絞り込み UI は不要)。 */
export const PROFILE_SEARCH_MIN = 6;
