/**
 * ER 図のノード位置の保存 (#1628)。ドラッグで並べ替えたレイアウトを、接続 (プロファイル) と
 * データベースごとにブラウザの localStorage へ覚え、次に開いたときに再現する。
 * per-viewer の表示設定でサーバへは送らない。読めない・壊れているときは自動レイアウトに倒す。
 *
 * 位置は保存時のレイアウト方向と密度に紐づける。自動レイアウトの座標系が別物になるので、
 * 方向/密度が違うときは保存位置を使わない (勝手に混ぜると重なる)。
 */
export interface ErPoint {
  x: number;
  y: number;
}

export interface ErSavedLayout {
  direction: string;
  density: string;
  /** テーブル名 → 位置。フォーカス表示で一部しか描かれていない場合に備え、既存分とマージして保持する。 */
  positions: Record<string, ErPoint>;
}

const STORAGE_KEY = "noobdb.erPositions.v1";
/** 保存するレイアウト (接続 × DB) の上限。超えたら古い順に捨てる。 */
export const ER_LAYOUT_MAX_ENTRIES = 50;
/** 1 レイアウトに保存するテーブル数の上限。 */
export const ER_LAYOUT_MAX_TABLES = 2000;

export function erLayoutKey(connectionKey: string, database: string): string {
  return JSON.stringify([connectionKey, database]);
}

function isFinitePoint(p: unknown): p is ErPoint {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  return typeof o.x === "number" && typeof o.y === "number" && Number.isFinite(o.x) && Number.isFinite(o.y);
}

/** 保存値を検証する。不正なエントリ・座標は捨てる。 */
export function sanitizeErLayouts(raw: unknown): Record<string, ErSavedLayout> {
  const out: Record<string, ErSavedLayout> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    if (typeof o.direction !== "string" || typeof o.density !== "string") continue;
    if (!o.positions || typeof o.positions !== "object" || Array.isArray(o.positions)) continue;
    const positions: Record<string, ErPoint> = {};
    for (const [table, p] of Object.entries(o.positions as Record<string, unknown>)) {
      if (isFinitePoint(p)) positions[table] = { x: p.x, y: p.y };
    }
    out[key] = { direction: o.direction, density: o.density, positions };
  }
  return out;
}

function readAll(): Record<string, ErSavedLayout> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null ? {} : sanitizeErLayouts(JSON.parse(raw));
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, ErSavedLayout>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // ignore (private mode, quota)
  }
}

/** 保存済み位置。方向/密度が一致しないとき・無いときは null。 */
export function readErLayout(
  connectionKey: string,
  database: string,
  direction: string,
  density: string,
): Record<string, ErPoint> | null {
  const hit = readAll()[erLayoutKey(connectionKey, database)];
  if (!hit || hit.direction !== direction || hit.density !== density) return null;
  return Object.keys(hit.positions).length > 0 ? hit.positions : null;
}

/**
 * 位置を保存する。同じ方向/密度の既存分とマージし (フォーカス表示で見えていないテーブルの位置を
 * 失わない)、方向/密度が違えば置き換える。エントリ数・テーブル数には上限がある。
 */
export function mergeErLayout(
  all: Record<string, ErSavedLayout>,
  key: string,
  direction: string,
  density: string,
  positions: Record<string, ErPoint>,
): Record<string, ErSavedLayout> {
  const prev = all[key];
  const base = prev && prev.direction === direction && prev.density === density ? prev.positions : {};
  const merged: Record<string, ErPoint> = { ...base };
  for (const [table, p] of Object.entries(positions)) {
    if (isFinitePoint(p)) merged[table] = { x: p.x, y: p.y };
  }
  const limited = Object.fromEntries(Object.entries(merged).slice(-ER_LAYOUT_MAX_TABLES));
  // 更新したエントリを末尾 (= 最新) へ移し、上限を超えた分を先頭 (古い順) から捨てる。
  const next: Record<string, ErSavedLayout> = { ...all };
  delete next[key];
  next[key] = { direction, density, positions: limited };
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - ER_LAYOUT_MAX_ENTRIES))) delete next[k];
  return next;
}

export function writeErLayout(
  connectionKey: string,
  database: string,
  direction: string,
  density: string,
  positions: Record<string, ErPoint>,
): void {
  writeAll(mergeErLayout(readAll(), erLayoutKey(connectionKey, database), direction, density, positions));
}

export function clearErLayout(connectionKey: string, database: string): void {
  const all = readAll();
  delete all[erLayoutKey(connectionKey, database)];
  writeAll(all);
}
