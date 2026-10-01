/**
 * 節ナビゲーション + 検索の純ロジック。設定画面 (#680) とヘルプ画面 (#1273) が
 * 同じ「左に節リスト + 検索欄、スクロール追従でアクティブ節をハイライト」の
 * 構造を持つため、判定部分をここへ集約する (描画・DOM は各コンポーネント側)。
 */

/** 検索語が空 (空白のみ含む) なら true。 */
export function isEmptyQuery(query: string): boolean {
  return query.trim() === "";
}

/**
 * 大小無視の部分一致。空クエリは常に一致。`texts` のどれか 1 つに含まれれば真。
 */
export function matchesQuery(query: string, ...texts: (string | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return texts.some((s) => s !== undefined && s.toLowerCase().includes(q));
}

/** 見出し (解決済みタイトル) に対する節の絞り込み。空クエリでは全件を返す。 */
export function filterSectionsByTitle<S>(
  sections: readonly S[],
  query: string,
  titleOf: (section: S) => string,
): S[] {
  if (isEmptyQuery(query)) return [...sections];
  return sections.filter((sec) => matchesQuery(query, titleOf(sec)));
}

/** スクロール追従で「表示中」とみなす、コンテナ上端からの許容距離 (px 相当の論理値)。 */
export const ACTIVE_SECTION_TOLERANCE = 24;

/**
 * スクロールスパイ: アクティブな節 id を決める。
 * - `ids` は DOM 出現順。`tops[i]` は節先頭のコンテナ上端からの相対位置
 *   (要素が無ければ null)。
 * - 一番下までスクロールしたら (`atBottom`) 最後の節を強制的にアクティブにする。
 * - それ以外は、先頭が上端 + 許容距離以内に来た最後の節。どれも来ていなければ先頭。
 * `ids` が空なら null。
 */
export function pickActiveSection(
  ids: readonly string[],
  tops: readonly (number | null)[],
  atBottom: boolean,
): string | null {
  if (ids.length === 0) return null;
  if (atBottom) return ids[ids.length - 1];
  let current = ids[0];
  for (let i = 0; i < ids.length; i++) {
    const top = tops[i];
    if (top === null || top === undefined) continue;
    if (top <= ACTIVE_SECTION_TOLERANCE) current = ids[i];
    else break;
  }
  return current;
}
