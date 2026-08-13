// お気に入り (ピン留め) / 最近実行したスニペットのクイックアクセス (#877)。
//
// `tableQuickAccess.ts` の永続化パターン (お気に入り + 最近使った LRU をローカル
// ストレージへ保存) をスニペットへ横展開したもの。テーブルは database + table の
// 組でしか一意識別できなかったが、スニペットは既に一意な 8 文字スラッグ ID
// (`Snippet.id`) を持つため、ここでは ID の配列だけを扱う。また、テーブルの
// クイックアクセスはアクティブ接続プロファイル単位に分けて永続化されるが、
// スニペットはプロファイルを跨いで再利用されることが多く (`scope: "any"` が
// 既定)、プロファイルを切り替えるたびに星が消える体験は不自然なため、単一の
// グローバル状態として永続化する。
//
// 永続化と更新の純ロジックのみをここに置き (Vitest でユニットテスト)、UI への
// 反映は `App.tsx` / `SnippetList.tsx` / `CommandPalette` が担当する。

const STORAGE_KEY = "noobdb.snippetQuickAccess.v1";

/** 「最近実行した」として保持する最大件数 (LRU)。 */
export const MAX_RECENT_SNIPPETS = 12;

/** お気に入り / 最近実行したスニペットの状態。値はどちらも `Snippet.id`。 */
export interface SnippetQuickAccessState {
  /** お気に入り (ピン留め)。登録順 (新しいものが末尾)。 */
  favorites: string[];
  /** 最近実行したスニペット。直近順 (新しいものが先頭) の LRU。 */
  recent: string[];
}

export const EMPTY_SNIPPET_QUICK_ACCESS: SnippetQuickAccessState = { favorites: [], recent: [] };

function isValidId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** 重複を最初の出現だけ残して除去する。 */
function dedupe(ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * パース済み JSON を妥当な状態に整える。純粋 (ストレージ非依存) なのでユニット
 * テストできる。未知の形・不正なエントリは捨て、`recent` は上限でクランプする。
 */
export function normalizeSnippetQuickAccess(parsed: unknown): SnippetQuickAccessState {
  if (!parsed || typeof parsed !== "object") return EMPTY_SNIPPET_QUICK_ACCESS;
  const o = parsed as Record<string, unknown>;
  const favorites = Array.isArray(o.favorites) ? dedupe(o.favorites.filter(isValidId)) : [];
  const recent = Array.isArray(o.recent)
    ? dedupe(o.recent.filter(isValidId)).slice(0, MAX_RECENT_SNIPPETS)
    : [];
  return { favorites, recent };
}

export function isSnippetFavorite(state: SnippetQuickAccessState, id: string): boolean {
  return state.favorites.includes(id);
}

/**
 * お気に入り (ピン留め) を切り替える (純粋: 新しい状態を返す)。未登録なら末尾に
 * 追加し、登録済みなら除去する。`recent` には触れない。
 */
export function toggleSnippetFavorite(
  state: SnippetQuickAccessState,
  id: string,
): SnippetQuickAccessState {
  if (isSnippetFavorite(state, id)) {
    return { ...state, favorites: state.favorites.filter((f) => f !== id) };
  }
  return { ...state, favorites: [...state.favorites, id] };
}

/**
 * ワンクリック実行したスニペットを「最近実行」の先頭へ記録する (純粋: 新しい
 * 状態を返す)。既存の同一エントリは先頭へ繰り上げ、上限を超えた古いものは
 * 切り捨てる (LRU)。`favorites` には触れない。
 */
export function recordSnippetRun(
  state: SnippetQuickAccessState,
  id: string,
): SnippetQuickAccessState {
  const rest = state.recent.filter((r) => r !== id);
  return { ...state, recent: [id, ...rest].slice(0, MAX_RECENT_SNIPPETS) };
}

/**
 * 削除されたスニペットの ID を、お気に入り / 最近実行の両方から取り除く (純粋)。
 * 変化がなければ同じオブジェクト参照を返すので、呼び出し側は参照比較で
 * 永続化・再描画をスキップできる。
 */
export function forgetSnippetQuickAccess(
  state: SnippetQuickAccessState,
  id: string,
): SnippetQuickAccessState {
  const favorites = state.favorites.filter((f) => f !== id);
  const recent = state.recent.filter((r) => r !== id);
  if (favorites.length === state.favorites.length && recent.length === state.recent.length) {
    return state;
  }
  return { favorites, recent };
}

export function loadSnippetQuickAccess(): SnippetQuickAccessState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_SNIPPET_QUICK_ACCESS;
    return normalizeSnippetQuickAccess(JSON.parse(raw));
  } catch {
    return EMPTY_SNIPPET_QUICK_ACCESS;
  }
}

export function saveSnippetQuickAccess(state: SnippetQuickAccessState): void {
  try {
    if (state.favorites.length === 0 && state.recent.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }
  } catch {
    // ignore (quota / disabled storage)
  }
}
