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

/** 複製元タブのうち、複製の組み立てに必要な最小限のフィールド。 */
export interface DuplicateSource {
  kind: "table" | "query" | "explain";
  title: string;
  /** 手動リネーム済みか (#1390)。複製にも引き継ぐ (複製直後の実行で名前が消えないように)。 */
  titleManual?: boolean;
  database?: string;
}

/** 複製タブの仕様 (`makeQueryTab` を土台に上書きするフィールド)。 */
export interface DuplicateTabSpec {
  kind: "query";
  /** 複製元のタイトルを引き継ぐ。explain は元のタイトルが計画用なので null (無題クエリ)。 */
  title: string | null;
  /** 手動リネーム済みのフラグ (#1390)。explain はタイトルを引き継がないので常に false。 */
  titleManual: boolean;
  sql: string;
  database: string | undefined;
  /** 未実行扱い (dirty 表示) にするため常に空。 */
  lastExecutedSql: string;
}

/**
 * タブ複製 (#1354) の仕様。結果を引き継がないため、table / explain も含め複製は常に
 * クエリタブ (SQL のコピー) になる。`sql` は編集中の最新本文を渡す。
 */
export function duplicateTabSpec(src: DuplicateSource, sql: string): DuplicateTabSpec {
  return {
    kind: "query",
    title: src.kind === "explain" ? null : src.title,
    titleManual: src.kind === "explain" ? false : src.titleManual === true,
    sql,
    database: src.database,
    lastExecutedSql: "",
  };
}
