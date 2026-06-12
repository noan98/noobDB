// お気に入り / 最近使ったテーブルのクイックアクセス。
//
// `tabPersistence.ts` と同じく、プロファイルごとに localStorage へ状態を永続化する。
// ここでは永続化と更新の純ロジックのみを提供し (Vitest でユニットテスト)、UI への
// 反映は App.tsx / ConnectionList.tsx が担当する。

const STORAGE_PREFIX = "noobdb.quickaccess.";

/** 直近に開いたテーブルとして保持する最大件数 (LRU)。 */
export const MAX_RECENT = 12;

/** データベース名 + テーブル名で一意に識別するテーブル参照。 */
export interface TableRef {
  database: string;
  table: string;
}

/** プロファイル単位のクイックアクセス状態。 */
export interface QuickAccessState {
  /** お気に入り。登録順 (新しいものが末尾)。 */
  favorites: TableRef[];
  /** 最近開いたテーブル。直近順 (新しいものが先頭) の LRU。 */
  recent: TableRef[];
}

export const EMPTY_QUICK_ACCESS: QuickAccessState = { favorites: [], recent: [] };

export function tableRefEquals(a: TableRef, b: TableRef): boolean {
  return a.database === b.database && a.table === b.table;
}

function isValidRef(v: unknown): v is TableRef {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.database === "string" && typeof o.table === "string";
}

/** 重複 (同じ db + table) を最初の出現だけ残して除去する。 */
function dedupe(refs: TableRef[]): TableRef[] {
  const out: TableRef[] = [];
  for (const r of refs) {
    if (!out.some((o) => tableRefEquals(o, r))) out.push(r);
  }
  return out;
}

/**
 * パース済み JSON を妥当な状態に整える。純粋 (ストレージ非依存) なのでユニット
 * テストできる。未知の形・不正なエントリは捨て、`recent` は上限でクランプする。
 */
export function normalizeQuickAccess(parsed: unknown): QuickAccessState {
  if (!parsed || typeof parsed !== "object") return EMPTY_QUICK_ACCESS;
  const o = parsed as Record<string, unknown>;
  const favorites = Array.isArray(o.favorites)
    ? dedupe(o.favorites.filter(isValidRef).map((r) => ({ database: r.database, table: r.table })))
    : [];
  const recent = Array.isArray(o.recent)
    ? dedupe(o.recent.filter(isValidRef).map((r) => ({ database: r.database, table: r.table }))).slice(0, MAX_RECENT)
    : [];
  return { favorites, recent };
}

export function isFavorite(state: QuickAccessState, ref: TableRef): boolean {
  return state.favorites.some((f) => tableRefEquals(f, ref));
}

/**
 * お気に入りを切り替える (純粋: 新しい状態を返す)。未登録なら末尾に追加し、登録済み
 * なら除去する。`recent` には触れない。
 */
export function toggleFavorite(state: QuickAccessState, ref: TableRef): QuickAccessState {
  if (isFavorite(state, ref)) {
    return { ...state, favorites: state.favorites.filter((f) => !tableRefEquals(f, ref)) };
  }
  return { ...state, favorites: [...state.favorites, { database: ref.database, table: ref.table }] };
}

/**
 * 最近使ったテーブルとして記録する (純粋: 新しい状態を返す)。既存の同一エントリは
 * 先頭へ繰り上げ、上限を超えた古いものは切り捨てる (LRU)。`favorites` には触れない。
 */
export function recordRecent(state: QuickAccessState, ref: TableRef): QuickAccessState {
  const entry = { database: ref.database, table: ref.table };
  const rest = state.recent.filter((r) => !tableRefEquals(r, ref));
  return { ...state, recent: [entry, ...rest].slice(0, MAX_RECENT) };
}

/**
 * お気に入りから 1 件除去する (純粋)。クイックアクセスセクションの★解除に使う。
 */
export function removeFavorite(state: QuickAccessState, ref: TableRef): QuickAccessState {
  return { ...state, favorites: state.favorites.filter((f) => !tableRefEquals(f, ref)) };
}

/**
 * もう存在しないテーブル (スキーマ変更で消えた等) をクイックアクセスから取り除く。
 * `available` は現在のスキーマに実在するテーブル参照の集合。純粋。
 */
export function pruneMissing(state: QuickAccessState, available: TableRef[]): QuickAccessState {
  const exists = (r: TableRef) => available.some((a) => tableRefEquals(a, r));
  const favorites = state.favorites.filter(exists);
  const recent = state.recent.filter(exists);
  if (favorites.length === state.favorites.length && recent.length === state.recent.length) {
    return state;
  }
  return { favorites, recent };
}

export function loadQuickAccess(profileId: string): QuickAccessState {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + profileId);
    if (!raw) return EMPTY_QUICK_ACCESS;
    return normalizeQuickAccess(JSON.parse(raw));
  } catch {
    return EMPTY_QUICK_ACCESS;
  }
}

export function saveQuickAccess(profileId: string, state: QuickAccessState): void {
  try {
    if (state.favorites.length === 0 && state.recent.length === 0) {
      localStorage.removeItem(STORAGE_PREFIX + profileId);
    } else {
      localStorage.setItem(STORAGE_PREFIX + profileId, JSON.stringify(state));
    }
  } catch {
    // ignore (quota / disabled storage)
  }
}
