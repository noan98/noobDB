/**
 * ファイルのドロップ位置の判定 (#1627)。Tauri の drag-drop イベントの座標は物理ピクセルなので、
 * CSS ピクセルへ直してから DOM の当たり判定に使う。
 */

/** 物理ピクセルの座標を CSS ピクセルへ。`scale` が不正 (0 以下・非有限) なら 1 とみなす。 */
export function physicalToCssPoint(
  position: { x: number; y: number },
  scale: number,
): { x: number; y: number } {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return { x: position.x / s, y: position.y / s };
}

/** 複数ファイルの本文を 1 つの挿入テキストにする。各本文の末尾の改行を 1 つに揃え、空行 1 つで区切る。 */
export function joinDroppedSql(contents: readonly string[]): string {
  return contents
    .map((c) => c.replace(/(?:\r?\n)+$/, ""))
    .filter((c) => c.length > 0)
    .join("\n\n");
}
