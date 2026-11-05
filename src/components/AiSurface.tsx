import { chakra } from "@chakra-ui/react";
import { motion } from "motion/react";
import type { ComponentProps } from "react";
import { transitions, variants } from "../motion";

/**
 * AI 回答面の共通シェル (#2016、Epic #2010)。
 *
 * Ask Agent / EXPLAIN 解説 / エラー解説 / アドバイザ解説 / 影響分析 / ロック診断 /
 * 結果要約 / 同期リスク / 履歴検索の各パネルが、回答を囲むコンテナを個別に手書きして
 * いたため、面・枠線の辺・余白が画面ごとにバラバラだった。ここで次を単一ソースにする。
 *
 * - 面 (`app.surface`)・余白・角丸・出入り (`variants.slideUp`) を揃える。
 * - 左辺にブランド teal の細いアクセント (`app.aiAccent` = `--ai-accent`) を添え、
 *   どの入口でも「これは AI の出力」と一目で分かる識別子にする。teal は文字色には
 *   使わず、非テキストの装飾辺だけに使う (`--stream-caret` 経由で全テーマ 3:1 以上、
 *   ハイコントラストでは本文色へ寄る)。
 * - データ送信範囲 (sends 行) → 本体 → `AiUsageNote` の並びは子の順序で呼び出し側が
 *   決める。位置は常に面の内側の先頭〜末尾に固定する。
 *
 * ## `edge`
 * | 値 | 用途 |
 * |---|---|
 * | `"top"` | 結果の下に置く帯 (エラー解説)。上辺に区切り線 |
 * | `"bottom"` | 上部に置く帯 (EXPLAIN 解説・履歴検索)。下辺に区切り線 |
 * | `"box"` | 独立したカード (同期リスク)。四辺の枠線 + 角丸 |
 * | `"none"` (既定) | 区切り線なし。親の枠に収まるパネル |
 */
const MotionSurface = chakra(
  motion.div,
  {},
  {
    forwardProps: ["initial", "animate", "exit", "transition"],
  },
);

export type AiSurfaceEdge = "top" | "bottom" | "box" | "none";

type AiSurfaceProps = Omit<ComponentProps<typeof MotionSurface>, "children"> & {
  edge?: AiSurfaceEdge;
  children?: React.ReactNode;
};

export function AiSurface({ edge = "none", children, ...rest }: AiSurfaceProps) {
  const edgeProps =
    edge === "top"
      ? { borderTopWidth: "1px", borderTopColor: "app.border" }
      : edge === "bottom"
        ? { borderBottomWidth: "1px", borderBottomColor: "app.border" }
        : edge === "box"
          ? { borderWidth: "1px", borderColor: "app.border", borderRadius: "md" }
          : {};
  // edgeProps (box の borderWidth/borderColor shorthand) は左アクセント指定より前に展開する。
  // Chakra は props 順のまま出力するため、後ろに置くと shorthand が左辺を上書きする。
  return (
    <MotionSurface
      initial={variants.slideUp.initial}
      animate={variants.slideUp.animate}
      transition={transitions.enter}
      display="flex"
      flexDirection="column"
      gap="2"
      px="3"
      py="2"
      bg="app.surface"
      fontSize="sm"
      color="app.text"
      {...edgeProps}
      borderInlineStartWidth="3px"
      borderInlineStartColor="app.aiAccent"
      data-ai-surface=""
      {...rest}
    >
      {children}
    </MotionSurface>
  );
}
