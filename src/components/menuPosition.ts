/**
 * `ContextMenu` (と、そのサブメニュー) の位置決めロジック。副作用なしの純関数
 * として切り出してあるので、DOM 無しで境界ケースを単体テストできる
 * (`tooltipPosition.ts` と同じ方針・同じ「測定 → フリップ → クランプ」の形)。
 */

/** ビューポート座標系での矩形。`DOMRect` のサブセットなので、呼び出し側
 *  (とテスト) は実物を構築せずプレーンオブジェクトを渡せる。 */
export interface MenuRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface MenuSize {
  width: number;
  height: number;
}

/**
 * メニューパネルの起点。ルートメニューはクリック位置 (`point`)、サブメニューは
 * それを開いた親項目の矩形 (`rect`) を起点にする。
 */
export type MenuAnchor =
  | { kind: "point"; x: number; y: number }
  | { kind: "rect"; rect: MenuRect };

/** ビューポート端に残す余白。 */
export const MENU_MARGIN = 6;
/** サブメニューと親項目の間の隙間。 */
export const SUBMENU_GAP = 2;
/** サブメニュー先頭項目を親項目と水平に揃えるためのオフセット (パネルの
 *  上下パディング相当)。 */
export const SUBMENU_OFFSET_Y = 4;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), Math.max(min, max));

/**
 * メニューパネルを描画すべき `position: fixed` の `{ left, top }` を返す。
 *
 * - `point` 起点 (ルートメニュー): クリック位置から右下へ開き、はみ出す辺では
 *   アンカーを跨いで反対側へ折り返す。
 * - `rect` 起点 (サブメニュー): 親項目の右側へ開き、右端に収まらなければ左側へ
 *   フリップする。縦は親項目の上端に揃え、下辺がはみ出す場合は下端揃えにする。
 *
 * どちらも最後に両軸をビューポート内へクランプするので、パネルが画面外に
 * 描画されることはない。
 */
export function computeMenuPosition(
  anchor: MenuAnchor,
  size: MenuSize,
  viewport: MenuSize,
  margin: number = MENU_MARGIN,
): { left: number; top: number } {
  let left: number;
  let top: number;

  if (anchor.kind === "point") {
    left = anchor.x + size.width + margin > viewport.width ? anchor.x - size.width : anchor.x;
    top = anchor.y + size.height + margin > viewport.height ? anchor.y - size.height : anchor.y;
  } else {
    const { rect } = anchor;
    left = rect.right + SUBMENU_GAP;
    if (left + size.width + margin > viewport.width) {
      left = rect.left - SUBMENU_GAP - size.width;
    }
    top = rect.top - SUBMENU_OFFSET_Y;
    if (top + size.height + margin > viewport.height) {
      top = rect.bottom + SUBMENU_OFFSET_Y - size.height;
    }
  }

  return {
    left: clamp(left, margin, viewport.width - size.width - margin),
    top: clamp(top, margin, viewport.height - size.height - margin),
  };
}
