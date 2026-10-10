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
  /** 手動リネーム済みか。複製にも引き継ぐ (複製直後の実行で名前が消えないように)。 */
  titleManual?: boolean;
  /** エディタの最新テキスト (未反映の編集を含む)。 */
  sql: string;
  /** 元タブの最終実行 SQL。dirty 判定 (sql との差) を複製にも引き継ぐために使う。 */
  lastExecutedSql: string;
}

/** 複製で作るタブの内容。 */
export interface DuplicateSpec {
  /**
   * table は `handleOpenTable` が同じテーブルの既存タブを前面化するだけで新規タブを
   * 作らないため、現在の SQL を土台にした独立クエリタブとして複製する。
   */
  kind: "query";
  /** explain の元タイトルは計画用 (`EXPLAIN: …`) なので引き継がず null (= 無題クエリ)。 */
  title: string | null;
  titleManual: boolean;
  sql: string;
  lastExecutedSql: string;
}

/**
 * タブを複製するときの新規タブ内容。結果を引き継がないため、table / explain も含め複製は
 * 常に query タブ (SQL のコピー) にする。query / table はタイトルを引き継ぎ (table は
 * テーブル名)、explain はタイトルを引き継がない。
 */
export function duplicateSpec(source: DuplicateSource): DuplicateSpec {
  const isExplain = source.kind === "explain";
  return {
    kind: "query",
    title: isExplain ? null : source.title,
    titleManual: !isExplain && source.titleManual === true,
    sql: source.sql,
    lastExecutedSql: source.lastExecutedSql,
  };
}
