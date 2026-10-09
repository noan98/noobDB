/**
 * タブの一括クローズ (#1354) が対象にするタブ集合の純ロジック。副作用なし。
 *
 * 複数ペインがあるとき、「他 / 右側 / すべて」は**そのタブが属するペイン内**のタブだけを
 * 対象にする (別ペインのタブは作業コンテキストが違うため巻き込まない)。呼び出し側は
 * 返ってきた id を既存の `handleCloseTab` へ 1 件ずつ渡す。
 */

/** 一括クローズの種別。 */
export type BulkCloseMode = "others" | "right" | "all";

/**
 * `paneTabIds` (ペイン内の並び順) から、`targetId` を基点に閉じるべきタブ id を返す。
 * `targetId` がペインに無いときは安全側で空配列を返す。入力は破壊しない。
 */
export function tabsToClose(
  paneTabIds: readonly string[],
  targetId: string,
  mode: BulkCloseMode,
): string[] {
  const idx = paneTabIds.indexOf(targetId);
  if (idx < 0) return [];
  switch (mode) {
    case "others":
      return paneTabIds.filter((id) => id !== targetId);
    case "right":
      return paneTabIds.slice(idx + 1);
    case "all":
      return paneTabIds.slice();
  }
}
