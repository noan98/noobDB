import { chakra, VisuallyHidden } from "@chakra-ui/react";

import { useCountUp } from "../useCountUp";

/**
 * 確定した数値のカウントアップ表示 (#977)。`useCountUp` の補間値を視覚的にのみ
 * 表示し、支援技術には常に最終値だけを渡す — アニメーション中の途中値が
 * スクリーンリーダーに連続読み上げされるのを防ぐための構成:
 *
 * - 見える桁 (`aria-hidden`): アニメーション中は補間値、収束後は確定値。
 * - 読み上げ用テキスト (`VisuallyHidden`): 常に確定値のみ。呼び出し側が
 *   `aria-live="polite"` な祖先要素の中に置けば、値が変わった瞬間に 1 回だけ
 *   確定値が読み上げられる (aria-hidden な兄弟の連続変化は読み上げに影響しない)。
 *
 * 表示専用: `value` を書き換えたり副作用を起こしたりしない。
 */
export function CountUp({
  value,
  formatter = defaultCountUpFormatter,
}: {
  value: number;
  /** 補間値/確定値の両方に適用する整形関数。既定はロケール区切りの整数表記。 */
  formatter?: (n: number) => string;
}) {
  const { display } = useCountUp(value);
  return (
    <>
      <chakra.span aria-hidden="true">{formatter(display)}</chakra.span>
      <VisuallyHidden>{formatter(value)}</VisuallyHidden>
    </>
  );
}

function defaultCountUpFormatter(n: number): string {
  return Math.round(n).toLocaleString();
}
