// フローティング・ランチャー (#1254) の純ロジック。
//
// ワークスペースの隅に常駐するボタン (FAB) から、お気に入りスニペット・最近の
// クエリ・お気に入りテーブル・最近のテーブルを呼び出す。ここにはボタン位置の
// 保存形式 (最寄りの隅 + 端からの割合)・クランプ・ドラッグ判定・キーボード移動・
// ポップオーバーの開く向き・セクションの組み立てを置き、描画と副作用は
// `components/QuickLauncher.tsx` が担当する (`__tests__/quickLauncher.test.ts`)。

import type { Snippet } from "./api/tauri";
import type { SnippetQuickAccessState } from "./snippetQuickAccess";
import type { QuickAccessState, TableRef } from "./tableQuickAccess";

// ---------------------------------------------------------------------------
// セクションの表示件数 (設定)
// ---------------------------------------------------------------------------

export interface QuickLauncherSectionLimits {
  favoriteSnippets: number;
  recentQueries: number;
  favoriteTables: number;
  recentTables: number;
}

export type QuickLauncherSectionId = keyof QuickLauncherSectionLimits;

/** セクションの並び順 (スニペット → クエリ → テーブル、各「お気に入り → 最近」)。 */
export const QUICK_LAUNCHER_SECTIONS: readonly QuickLauncherSectionId[] = [
  "favoriteSnippets",
  "recentQueries",
  "favoriteTables",
  "recentTables",
];

export const DEFAULT_QUICK_LAUNCHER_SECTION_LIMIT = 5;
export const MIN_QUICK_LAUNCHER_SECTION_LIMIT = 1;
export const MAX_QUICK_LAUNCHER_SECTION_LIMIT = 20;

export const DEFAULT_QUICK_LAUNCHER_SECTION_LIMITS: QuickLauncherSectionLimits = {
  favoriteSnippets: DEFAULT_QUICK_LAUNCHER_SECTION_LIMIT,
  recentQueries: DEFAULT_QUICK_LAUNCHER_SECTION_LIMIT,
  favoriteTables: DEFAULT_QUICK_LAUNCHER_SECTION_LIMIT,
  recentTables: DEFAULT_QUICK_LAUNCHER_SECTION_LIMIT,
};

function sanitizeLimit(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_QUICK_LAUNCHER_SECTION_LIMIT;
  return Math.min(
    MAX_QUICK_LAUNCHER_SECTION_LIMIT,
    Math.max(MIN_QUICK_LAUNCHER_SECTION_LIMIT, Math.round(v)),
  );
}

/** 永続化された表示件数を検証して取り込む。欠けた・壊れたキーは既定 (5)。 */
export function sanitizeQuickLauncherSectionLimits(input: unknown): QuickLauncherSectionLimits {
  const o = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return {
    favoriteSnippets: sanitizeLimit(o.favoriteSnippets),
    recentQueries: sanitizeLimit(o.recentQueries),
    favoriteTables: sanitizeLimit(o.favoriteTables),
    recentTables: sanitizeLimit(o.recentTables),
  };
}

// ---------------------------------------------------------------------------
// セクションの組み立て
// ---------------------------------------------------------------------------

export type QuickLauncherItem =
  | { kind: "snippet"; key: string; snippet: Snippet }
  | { kind: "query"; key: string; sql: string }
  | { kind: "table"; key: string; ref: TableRef };

export interface QuickLauncherSection {
  id: QuickLauncherSectionId;
  items: QuickLauncherItem[];
  /** 表示件数を超えた項目があるか (「もっと見る」で既存の一覧へ)。 */
  hasMore: boolean;
}

export interface QuickLauncherSources {
  snippets: readonly Snippet[];
  snippetQuickAccess: SnippetQuickAccessState;
  /** 直近のクエリ (新しいものが先頭)。 */
  queryHistory: readonly string[];
  tableQuickAccess: QuickAccessState;
}

function take<T>(all: T[], limit: number): { items: T[]; hasMore: boolean } {
  return { items: all.slice(0, limit), hasMore: all.length > limit };
}

/**
 * 4 つのセクションを組み立てる。削除済みスニペットの id は捨て、クエリは
 * 空白だけの違いを同一視して重複を除く。空のセクションも返す (描画側で省く)。
 */
export function buildQuickLauncherSections(
  src: QuickLauncherSources,
  limits: QuickLauncherSectionLimits,
): QuickLauncherSection[] {
  const byId = new Map(src.snippets.map((s) => [s.id, s]));
  const favSnippets = src.snippetQuickAccess.favorites
    .map((id) => byId.get(id))
    .filter((s): s is Snippet => s !== undefined)
    .map((snippet): QuickLauncherItem => ({ kind: "snippet", key: `snippet:${snippet.id}`, snippet }));

  const seen = new Set<string>();
  const queries: QuickLauncherItem[] = [];
  for (const sql of src.queryHistory) {
    const norm = sql.trim().replace(/\s+/g, " ");
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    queries.push({ kind: "query", key: `query:${queries.length}`, sql });
  }

  const tableItem = (prefix: string) => (ref: TableRef): QuickLauncherItem => ({
    kind: "table",
    key: `${prefix}:${ref.database}\u0000${ref.table}`,
    ref,
  });
  // お気に入りは登録順 (新しいものが末尾) なので、新しい順に並べ替えて見せる。
  const favTables = [...src.tableQuickAccess.favorites].reverse().map(tableItem("fav"));
  const recentTables = src.tableQuickAccess.recent.map(tableItem("recent"));

  const all: Record<QuickLauncherSectionId, QuickLauncherItem[]> = {
    favoriteSnippets: favSnippets,
    recentQueries: queries,
    favoriteTables: favTables,
    recentTables,
  };
  return QUICK_LAUNCHER_SECTIONS.map((id) => ({ id, ...take(all[id], limits[id]) }));
}

/** 一覧に出す 1 行ぶんの SQL (改行・連続空白を畳み、長すぎれば省略)。 */
export function singleLineSql(sql: string, max = 80): string {
  const s = sql.trim().replace(/\s+/g, " ");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ---------------------------------------------------------------------------
// ボタン位置 (最寄りの隅 + 端からの割合)
// ---------------------------------------------------------------------------

export type LauncherCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/**
 * 永続化するボタン位置。`corner` は最寄りの隅、`rx` / `ry` はその隅の側の端から
 * ボタンまでの距離を「動かせる幅 (可視範囲 - ボタン)」で割った割合 (0〜1)。
 * ウィンドウサイズが変わっても相対位置を保ち、常に可視範囲に収まる。
 */
export interface LauncherPosition {
  corner: LauncherCorner;
  rx: number;
  ry: number;
}

export const DEFAULT_LAUNCHER_POSITION: LauncherPosition = { corner: "bottom-right", rx: 0, ry: 0 };

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  left: number;
  top: number;
}

/** ボタンを置ける可視範囲 (ビューポート座標)。 */
export interface LauncherBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

const CORNERS: readonly LauncherCorner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function track(bounds: LauncherBounds, size: Size): { w: number; h: number } {
  return { w: Math.max(0, bounds.width - size.width), h: Math.max(0, bounds.height - size.height) };
}

/** 位置をビューポート座標の左上点へ変換する (常に `bounds` 内に収まる)。 */
export function launcherPositionToPoint(pos: LauncherPosition, bounds: LauncherBounds, size: Size): Point {
  const { w, h } = track(bounds, size);
  const fromLeft = pos.corner.endsWith("left");
  const fromTop = pos.corner.startsWith("top");
  const dx = clamp01(pos.rx) * w;
  const dy = clamp01(pos.ry) * h;
  return {
    left: bounds.left + (fromLeft ? dx : w - dx),
    top: bounds.top + (fromTop ? dy : h - dy),
  };
}

/** 左上点を `bounds` 内へクランプする (ドラッグ中・リサイズ後の補正)。 */
export function clampLauncherPoint(p: Point, bounds: LauncherBounds, size: Size): Point {
  const { w, h } = track(bounds, size);
  const left = Number.isFinite(p.left) ? p.left : bounds.left + w;
  const top = Number.isFinite(p.top) ? p.top : bounds.top + h;
  return {
    left: Math.min(bounds.left + w, Math.max(bounds.left, left)),
    top: Math.min(bounds.top + h, Math.max(bounds.top, top)),
  };
}

/** 左上点から保存形式 (最寄りの隅 + 割合) を求める。 */
export function launcherPointToPosition(p: Point, bounds: LauncherBounds, size: Size): LauncherPosition {
  const c = clampLauncherPoint(p, bounds, size);
  const { w, h } = track(bounds, size);
  const x = c.left - bounds.left;
  const y = c.top - bounds.top;
  const fromLeft = x + size.width / 2 <= bounds.width / 2;
  const fromTop = y + size.height / 2 <= bounds.height / 2;
  const ratio = (d: number, total: number) => (total > 0 ? clamp01(d / total) : 0);
  return {
    corner: `${fromTop ? "top" : "bottom"}-${fromLeft ? "left" : "right"}` as LauncherCorner,
    rx: ratio(fromLeft ? x : w - x, w),
    ry: ratio(fromTop ? y : h - y, h),
  };
}

/** ドラッグ開始とみなす移動量 (px)。これ未満はクリック (開閉)。 */
export const LAUNCHER_DRAG_THRESHOLD = 4;

export function exceedsDragThreshold(dx: number, dy: number, threshold = LAUNCHER_DRAG_THRESHOLD): boolean {
  return Math.hypot(dx, dy) >= threshold;
}

/** キーボードでの微調整 1 回の移動量 (Shift で大きく)。 */
export const LAUNCHER_NUDGE_STEP = 8;
export const LAUNCHER_NUDGE_STEP_LARGE = 40;

/** 矢印キーで左上点を動かす。矢印キー以外は null。 */
export function nudgeLauncherPoint(p: Point, key: string, large: boolean): Point | null {
  const step = large ? LAUNCHER_NUDGE_STEP_LARGE : LAUNCHER_NUDGE_STEP;
  switch (key) {
    case "ArrowLeft":
      return { left: p.left - step, top: p.top };
    case "ArrowRight":
      return { left: p.left + step, top: p.top };
    case "ArrowUp":
      return { left: p.left, top: p.top - step };
    case "ArrowDown":
      return { left: p.left, top: p.top + step };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 永続化 (localStorage)
// ---------------------------------------------------------------------------

const POSITION_STORAGE_KEY = "noobdb.quickLauncher.position.v1";

/** 保存された文字列を位置へ戻す。壊れていれば初期位置 (右下)。 */
export function parseLauncherPosition(raw: string | null | undefined): LauncherPosition {
  if (!raw) return DEFAULT_LAUNCHER_POSITION;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (!o || typeof o !== "object") return DEFAULT_LAUNCHER_POSITION;
    if (!CORNERS.includes(o.corner as LauncherCorner)) return DEFAULT_LAUNCHER_POSITION;
    if (typeof o.rx !== "number" || typeof o.ry !== "number") return DEFAULT_LAUNCHER_POSITION;
    return { corner: o.corner as LauncherCorner, rx: clamp01(o.rx), ry: clamp01(o.ry) };
  } catch {
    return DEFAULT_LAUNCHER_POSITION;
  }
}

export function serializeLauncherPosition(pos: LauncherPosition): string {
  return JSON.stringify({ corner: pos.corner, rx: clamp01(pos.rx), ry: clamp01(pos.ry) });
}

export function loadLauncherPosition(): LauncherPosition {
  try {
    return parseLauncherPosition(localStorage.getItem(POSITION_STORAGE_KEY));
  } catch {
    return DEFAULT_LAUNCHER_POSITION;
  }
}

export function saveLauncherPosition(pos: LauncherPosition): void {
  try {
    localStorage.setItem(POSITION_STORAGE_KEY, serializeLauncherPosition(pos));
  } catch {
    // 保存できなくても動作には影響しない (次回は初期位置から)。
  }
}

/** 「位置をリセット」: 保存を消して初期位置に戻す。 */
export function clearLauncherPosition(): void {
  try {
    localStorage.removeItem(POSITION_STORAGE_KEY);
  } catch {
    // 同上。
  }
}

// ---------------------------------------------------------------------------
// ポップオーバーの位置
// ---------------------------------------------------------------------------

export interface LauncherPopoverPlacement extends Point {
  /** ボタンの上に開くか (下半分にあるとき)。 */
  above: boolean;
  /** ボタンの右端に揃えて左へ広げるか (右半分にあるとき)。 */
  alignEnd: boolean;
}

/** ボタンとポップオーバーの間隔 (px)。 */
export const LAUNCHER_POPOVER_GAP = 8;

/**
 * ポップオーバーの左上点を決める。画面の中央側へ開く (下半分なら上、右半分なら
 * 左へ広げる) ので、画面端では自動で向きが反転する。はみ出す分は `viewport` 内へ
 * クランプする。
 */
export function computeLauncherPopoverPosition(
  button: { left: number; top: number; width: number; height: number },
  popover: Size,
  viewport: Size,
  margin = LAUNCHER_POPOVER_GAP,
): LauncherPopoverPlacement {
  const centerX = button.left + button.width / 2;
  const centerY = button.top + button.height / 2;
  const above = centerY > viewport.height / 2;
  const alignEnd = centerX > viewport.width / 2;
  let left = alignEnd ? button.left + button.width - popover.width : button.left;
  let top = above ? button.top - LAUNCHER_POPOVER_GAP - popover.height : button.top + button.height + LAUNCHER_POPOVER_GAP;
  left = Math.min(Math.max(margin, left), Math.max(margin, viewport.width - margin - popover.width));
  top = Math.min(Math.max(margin, top), Math.max(margin, viewport.height - margin - popover.height));
  return { left, top, above, alignEnd };
}
