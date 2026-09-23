/**
 * サイドバー (Database Explorer) の幅と開閉の純ロジック (#1112 / Epic #1110 Phase 2)。
 * 副作用なし (DOM / localStorage に触れない) なので Vitest で単体テストできる。
 *
 * #1112 以前、サイドバーの幅変更はポインタ操作だけで、キーボードでは動かせず、
 * 区切り線の読み上げ名も「サイドバーを折りたたむ」になっていた。一方エディタ ⇔
 * 結果やワークスペース ⇔ ボトムパネルの区切りは `Splitter` が矢印キー / Home /
 * End / Enter (既定に戻す) / ダブルクリックを揃えて持つ。サイドバーの区切りも
 * 同じ操作体系に揃えるため、キー → 次の幅の対応をここに置く (`SidebarResizeHandle`
 * が使う)。幅はピクセルで永続化する (比率ではなく、ウィンドウ幅を変えても
 * サイドバーの見た目の幅を保つため) ので、`Splitter` の比率ロジックとは別に持つ。
 */

export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 560;
export const SIDEBAR_DEFAULT_WIDTH = 300;
/** 矢印キー 1 回で動かす幅 (px)。 */
const SIDEBAR_KEY_STEP = 16;
/** Shift + 矢印キーで動かす幅 (px)。 */
const SIDEBAR_KEY_STEP_LARGE = 64;

/** 幅を許容範囲へ収める。 */
export function clampSidebarWidth(w: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, w));
}

/**
 * 永続化された幅を検証して正規化する。正の有限数だけを採用してクランプし、
 * それ以外 (null / NaN / 0 / 負数 / 文字列ゴミ) は既定幅を返す (#566 の破損耐性方針)。
 */
export function parseSidebarWidth(raw: unknown): number {
  if (raw === null || raw === undefined || raw === "") return SIDEBAR_DEFAULT_WIDTH;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? clampSidebarWidth(n) : SIDEBAR_DEFAULT_WIDTH;
}

/**
 * 区切り線にフォーカスがあるときのキー操作から次の幅を求める。対象外のキーは
 * `null` (呼び出し側は既定動作を妨げない)。`Splitter` と同じ割り当て:
 * ← / → で縮小 / 拡大 (Shift で大きく)、Home / End で最小 / 最大、Enter で既定。
 */
export function sidebarWidthForKey(
  current: number,
  key: string,
  shiftKey = false,
): number | null {
  const step = shiftKey ? SIDEBAR_KEY_STEP_LARGE : SIDEBAR_KEY_STEP;
  switch (key) {
    case "ArrowLeft":
      return clampSidebarWidth(current - step);
    case "ArrowRight":
      return clampSidebarWidth(current + step);
    case "Home":
      return SIDEBAR_MIN_WIDTH;
    case "End":
      return SIDEBAR_MAX_WIDTH;
    case "Enter":
      return SIDEBAR_DEFAULT_WIDTH;
    default:
      return null;
  }
}
