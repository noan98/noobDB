// スニペットフォルダの開閉状態の永続化 (#677)。
//
// フォルダは既定で開いているため、接続リストのグループ折りたたみ (`COLLAPSED_GROUPS_KEY`)
// と同じく「閉じているフォルダのキーだけ」を配列で保存する。フォルダ名はプロファイルに
//依存しない (スニペットは横断的) ので、単一のグローバルキーで持つ。
//
// 破損耐性 (#566) の作法に従い、壊れた JSON・型不一致は破棄して空 (= すべて開いている)
// へフォールバックする。純ロジックのみを提供し、UI 反映は `SnippetList` が担う。

const COLLAPSED_SNIPPET_FOLDERS_KEY = "noobdb.snippetlist.collapsedFolders";

/**
 * パース済み JSON (閉じているフォルダキーの配列) を `expandedFolders` の初期値
 * ({ key: false } の Record) へ整える。純粋 (ストレージ非依存)。未知の形・非文字列は捨てる。
 */
export function normalizeCollapsedFolders(parsed: unknown): Record<string, boolean> {
  if (!Array.isArray(parsed)) return {};
  const out: Record<string, boolean> = {};
  for (const k of parsed) if (typeof k === "string") out[k] = false;
  return out;
}

/**
 * localStorage から閉じているフォルダ集合を復元する。SSR/未対応環境やパース失敗時は空。
 */
export function readCollapsedSnippetFolders(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSED_SNIPPET_FOLDERS_KEY);
    if (!raw) return {};
    return normalizeCollapsedFolders(JSON.parse(raw));
  } catch {
    return {};
  }
}

/**
 * 開閉状態を保存する。既定 (すべて開いている) のときはエントリを削除して、
 * ストレージを最小限に保つ (`COLLAPSED_GROUPS_KEY` と同じ発想)。
 */
export function writeCollapsedSnippetFolders(expanded: Record<string, boolean>): void {
  const collapsed = Object.entries(expanded)
    .filter(([, open]) => open === false)
    .map(([key]) => key);
  try {
    if (collapsed.length > 0) {
      localStorage.setItem(COLLAPSED_SNIPPET_FOLDERS_KEY, JSON.stringify(collapsed));
    } else {
      localStorage.removeItem(COLLAPSED_SNIPPET_FOLDERS_KEY);
    }
  } catch {
    // ストレージ不可環境では永続化を諦める (セッション内の動作には影響しない)。
  }
}
