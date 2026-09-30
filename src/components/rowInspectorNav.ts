/** Row Inspector の行送り方向と幅 (純ロジック、#1234)。 */

/** 送り方向。1 = 次へ (行番号が増える)、-1 = 前へ、0 = 変化なし/初回。 */
export type NavDirection = -1 | 0 | 1;

/**
 * 直前の行番号と現在の行番号から送り方向を返す。`directionalSlide` は正の向きで
 * 右から入るので、prev (番号減) は右→左の入りを表す正、next は負に対応させる。
 * 戻り値はスライドの `custom` にそのまま渡せる向き (prev=+1 / next=-1)。
 */
export function rowSlideDirection(prevRow: number, nextRow: number): NavDirection {
  if (nextRow === prevRow) return 0;
  return nextRow > prevRow ? -1 : 1;
}

/** ドロワー幅 (Fields / Related)。値はここだけに置く。 */
export function inspectorWidth(view: "fields" | "related"): string {
  return view === "related" ? "min(560px, 92vw)" : "min(380px, 92vw)";
}
