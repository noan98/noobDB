/**
 * ログ系パネル (アクティビティ / 出力 / ベルのポップオーバー) の文言検索 (#1627)。
 * 大文字小文字を区別せず、空白で区切った語をすべて含む行だけ残す (AND の部分一致)。
 * 絞り込みは表示だけに効き、ログ自体は消さない。
 */

/** 検索語を小文字の語に分ける。空白だけなら空配列 (= 絞り込まない)。 */
export function searchTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** `fields` のどこかに `terms` のすべてが (連結した文字列の中に) 含まれるか。terms が空なら常に true。 */
export function matchesSearchTerms(
  terms: readonly string[],
  fields: readonly (string | null | undefined)[],
): boolean {
  if (terms.length === 0) return true;
  const hay = fields
    .filter((f): f is string => typeof f === "string" && f.length > 0)
    .join("\n")
    .toLowerCase();
  return terms.every((t) => hay.includes(t));
}
