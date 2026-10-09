/**
 * タブのコンテキストメニュー (#1354) が使う純ロジック。副作用なし。
 *
 * 一括クローズの対象は「右クリックしたタブと同じペイン内のタブ」に限る。ペインごとに
 * タブバーが独立しており、「右側」はそのタブバー上の並びでしか意味を持たないため、
 * 「他を閉じる」「すべて閉じる」も同じ単位に揃える (別ペインの作業を巻き込まない)。
 */

export type TabBulkCloseMode = "others" | "right" | "all";

/**
 * `paneTabIds` (同じペインのタブ ID を表示順に並べたもの) から、`mode` に応じた
 * 閉じる対象の ID 列を返す。`targetId` がペインに無いときは何も閉じない。
 * - others: `targetId` 以外すべて
 * - right: `targetId` より右 (後ろ) のタブ
 * - all: ペイン内のすべて (`targetId` を含む)
 */
export function tabsToClose(
  paneTabIds: readonly string[],
  targetId: string,
  mode: TabBulkCloseMode,
): string[] {
  const idx = paneTabIds.indexOf(targetId);
  if (idx < 0) return [];
  switch (mode) {
    case "others":
      return paneTabIds.filter((id) => id !== targetId);
    case "right":
      return paneTabIds.slice(idx + 1);
    case "all":
      return [...paneTabIds];
  }
}

/** 複製元として必要なタブの最小情報。 */
export interface DuplicateSource {
  kind: "table" | "query" | "explain";
  title: string;
  /** エディタの最新テキスト (未反映の編集を含む)。 */
  sql: string;
}

/** 複製で作るタブの内容。 */
export interface DuplicateSpec {
  /**
   * table は `handleOpenTable` が同じテーブルの既存タブを前面化するだけで新規タブを
   * 作らないため、現在の SQL を土台にした独立クエリタブとして複製する。
   */
  kind: "query" | "explain";
  title: string;
  sql: string;
}

/**
 * タブを複製するときの新規タブ内容。query / explain は種別・タイトル・SQL をそのまま
 * 引き継ぎ、table は SQL を持つ query タブ (タイトルはテーブル名) にする。
 */
export function duplicateSpec(source: DuplicateSource): DuplicateSpec {
  return {
    kind: source.kind === "explain" ? "explain" : "query",
    title: source.title,
    sql: source.sql,
  };
}
