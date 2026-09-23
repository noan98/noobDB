import { chakra, VisuallyHidden } from "@chakra-ui/react";

import { Fragment } from "react";

import {
  countUpSlotToken,
  formatCountUpPlainInt,
  splitCountUpTemplate,
  useCountUp,
} from "../useCountUp";

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
 * 見える桁は `textStyle="numeric"` (等幅数字 #1072) で描画し、補間中の横揺れを防ぐ。
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
      {/* 補間中に桁形が変わっても横幅が揺れないよう等幅数字にする (#1072)。 */}
      <chakra.span aria-hidden="true" textStyle="numeric">
        {formatter(display)}
      </chakra.span>
      <VisuallyHidden>{formatter(value)}</VisuallyHidden>
    </>
  );
}

/**
 * 数値を含む i18n 文言の、数値部分だけをカウントアップさせる共通ラッパ (#1024)。
 *
 * `render` にはスロットごとのトークン (`countUpSlotToken(i)`) が渡るので、それを
 * `t()` の `vars` に入れて展開した文字列を返す。例:
 *
 * ```tsx
 * <CountUpText values={[from, to]} render={([a, b]) => t("pageRowRange", { from: a, to: b })} />
 * ```
 *
 * テンプレートにスロットが揃わない (翻訳でプレースホルダが消えた等) ときは、
 * 確定値で展開した静的な文字列へフォールバックし、トークンを画面に漏らさない。
 * 各スロットは `CountUp` なので reduced-motion・初回表示・小さな差分のジャンプ・
 * 等幅数字・読み上げの扱いはすべて `CountUp` / `useCountUp` と同一。
 */
export function CountUpText({
  values,
  render,
  formatter = formatCountUpPlainInt,
}: {
  values: readonly number[];
  render: (slots: string[]) => string;
  formatter?: (n: number) => string;
}) {
  const segments = splitCountUpTemplate(
    render(values.map((_, i) => countUpSlotToken(i))),
    values.length,
  );
  if (!segments) return <>{render(values.map((v) => formatter(v)))}</>;
  return (
    <>
      {segments.map((seg, i) =>
        seg.kind === "text" ? (
          <Fragment key={i}>{seg.text}</Fragment>
        ) : (
          <CountUp key={i} value={values[seg.index]} formatter={formatter} />
        ),
      )}
    </>
  );
}

function defaultCountUpFormatter(n: number): string {
  return Math.round(n).toLocaleString();
}
