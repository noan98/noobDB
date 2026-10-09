import { Box, chakra } from "@chakra-ui/react";
import type { ReactNode } from "react";

import { CountUp } from "./CountUp";

/**
 * 指標カードの共通部品 (#1238): overline ラベル + 等幅数字の値 + 任意の補助行。
 * 余白・角丸・階層はここで一元化し、各パネルは値だけを渡す。
 * 静止エレベーション (`elevationRaised`, #1239) もここに集約し、border と併用して
 * ダーク系テーマでも輪郭を保つ。以後の指標カードは自動的に階層へ従う。
 *
 * `value` が number のときは `CountUp` で増分アニメ表示する (reduced-motion は
 * MotionConfig が即時化)。文字列・ノードはそのまま表示する (2^53 超の件数など
 * 丸めたくない値や、型名のような非数値)。
 */
export function StatTile({
  label,
  value,
  formatter,
  sub,
}: {
  label: string;
  value: number | string | ReactNode;
  /** `value` が number のときの整形関数 (既定はロケール区切りの整数)。 */
  formatter?: (n: number) => string;
  sub?: ReactNode;
}) {
  return (
    <Box
      minW="120px"
      flex="1"
      px="3"
      py="2"
      borderRadius="md"
      borderWidth="1px"
      borderColor="app.border"
      bg="app.surface"
      shadow="elevationRaised"
    >
      <chakra.div textStyle="overline" color="app.textMuted">
        {label}
      </chakra.div>
      <chakra.div
        fontSize="md"
        fontWeight={600}
        fontFamily="var(--font-mono)"
        textStyle="numeric"
        overflow="hidden"
        textOverflow="ellipsis"
        whiteSpace="nowrap"
      >
        {typeof value === "number" ? <CountUp value={value} formatter={formatter} /> : value}
      </chakra.div>
      {sub != null && sub !== false && (
        <chakra.div fontSize="xs" color="app.textMuted" textStyle="numeric">
          {sub}
        </chakra.div>
      )}
    </Box>
  );
}
