/** アンカーに対して優先する側。優先側がビューポートをはみ出す場合は反対側へ
 *  フリップする。 */
export type TooltipPlacement = "top" | "bottom" | "left" | "right";

/**
 * アンカーに対するクロス軸方向の揃え方。`"center"` (既定。大半のツールチップ
 * UI はこちら) はバブルをアンカーの反対軸中央に揃える。`"start"` はアンカーの
 * 先頭辺に揃える — 例えば `ColumnTooltip` はスキーマツリーの行全体をアンカーに
 * するため、行の全高で中央揃えするのではなく行の上端に揃えたい。
 */
export type TooltipAlign = "start" | "center";

/** ビューポート座標系でのアンカー矩形。`DOMRect` のサブセットにしているため、
 *  呼び出し側 (とテスト) は実物を構築せずプレーンオブジェクトを渡せる。 */
export interface TooltipRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface TooltipSize {
  width: number;
  height: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), Math.max(min, max));

/**
 * アプリ内すべてのホバーカード (`Tooltip`、および `ConnectionList` 独自の
 * `ColumnTooltip`) が共有する測定 → クランプ → フリップの位置決め。アンカーの
 * 矩形、ツールチップ自身の (測定済みの) サイズ、優先する `placement`、
 * ビューポート、マージンを受け取り、ツールチップを描画すべき
 * `position: fixed` の `{ left, top }` を返す。
 *
 * 優先側がビューポートをはみ出す場合は反対側へフリップし、そのうえで両軸を
 * (`margin` の余白を保ちつつ) ビューポート内へクランプするので、ツールチップが
 * 切り取られたり画面外に描画されたりすることはない。これは `ColumnTooltip` が
 * 単発で実装していたのと同じ測定/クランプ/フリップの形を、単一の共有・単体
 * テスト済み実装として抽出したもの (#814)。
 */
export function computeTooltipPosition(
  anchor: TooltipRect,
  size: TooltipSize,
  placement: TooltipPlacement,
  margin: number,
  viewport: TooltipSize,
  align: TooltipAlign = "center",
): { left: number; top: number } {
  const centerX = anchor.left + anchor.width / 2 - size.width / 2;
  const centerY = anchor.top + anchor.height / 2 - size.height / 2;

  let left: number;
  let top: number;

  switch (placement) {
    case "bottom":
      left = centerX;
      top = anchor.bottom + margin;
      if (top + size.height + margin > viewport.height) {
        top = anchor.top - margin - size.height;
      }
      break;
    case "left":
      top = align === "start" ? anchor.top : centerY;
      left = anchor.left - margin - size.width;
      if (left < margin) {
        left = anchor.right + margin;
      }
      break;
    case "right":
      top = align === "start" ? anchor.top : centerY;
      left = anchor.right + margin;
      if (left + size.width + margin > viewport.width) {
        left = anchor.left - margin - size.width;
      }
      break;
    case "top":
    default:
      left = centerX;
      top = anchor.top - margin - size.height;
      if (top < margin) {
        top = anchor.bottom + margin;
      }
      break;
  }

  return {
    left: clamp(left, margin, viewport.width - size.width - margin),
    top: clamp(top, margin, viewport.height - size.height - margin),
  };
}
