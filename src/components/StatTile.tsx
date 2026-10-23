import { Box, chakra, Flex, VisuallyHidden } from "@chakra-ui/react";
import type { ReactNode } from "react";

import { useT } from "../i18n";
import { CountUp } from "./CountUp";
import type { LatencySample } from "./connectionHealth";
import { LatencySparkline } from "./LatencySparkline";

/** デルタの「良い向き」。`neutral` は良悪を付けず、向きだけを無彩色で示す。 */
export type StatDeltaGood = "up" | "down" | "neutral";

/** デルタ行: 方向グリフ + 意味色 (色だけに頼らず、読み上げ用の文言も付ける)。 */
function StatDelta({
  delta,
  good,
  formatter,
}: {
  delta: number;
  good: StatDeltaGood;
  formatter: (n: number) => string;
}) {
  const t = useT();
  const dir = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const verdict = dir === "flat" || good === "neutral" ? null : dir === good ? "good" : "bad";
  const color =
    verdict === "good" ? "app.textSuccess" : verdict === "bad" ? "app.textError" : "app.textMuted";
  const glyph = dir === "up" ? "▲" : dir === "down" ? "▼" : "–";
  const amount = formatter(Math.abs(delta));
  const spoken = [
    dir === "up"
      ? t("statDeltaUp", { amount })
      : dir === "down"
        ? t("statDeltaDown", { amount })
        : t("statDeltaFlat"),
    verdict === "good" ? t("statDeltaGood") : verdict === "bad" ? t("statDeltaBad") : null,
    t("statDeltaVsPrev"),
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <chakra.div
      textStyle="caption"
      color={color}
      data-testid="stat-delta"
      data-direction={dir}
      data-verdict={verdict ?? "none"}
    >
      <chakra.span aria-hidden="true" textStyle="numeric">
        {glyph}
        {dir !== "flat" && ` ${amount}`}
      </chakra.span>
      <VisuallyHidden>{spoken}</VisuallyHidden>
    </chakra.div>
  );
}

/**
 * 指標カードの共通部品 (#1238): overline ラベル + 等幅数字の値 + 任意の補助行。
 * 余白・角丸・階層はここで一元化し、各パネルは値だけを渡す。
 * 静止エレベーション (`elevationRaised`, #1239) もここに集約し、border と併用して
 * ダーク系テーマでも輪郭を保つ。以後の指標カードは自動的に階層へ従う。
 *
 * `value` が number のときは `CountUp` で増分アニメ表示する (reduced-motion は
 * MotionConfig が即時化)。文字列・ノードはそのまま表示する (2^53 超の件数など
 * 丸めたくない値や、型名のような非数値)。
 *
 * 任意で `delta` (前回比の差分) と `trend` (直近の推移) を足せる (#1833)。デルタは方向グリフ
 * (▲▼) + 意味色 (`goodWhen` が一致すれば textSuccess、逆なら textError、`neutral` は無彩色)
 * で、色に加えて読み上げ文言でも増減と良悪を伝える。推移は既存 `LatencySparkline` (neutral)。
 * どちらも未指定なら従来と同じ見た目。
 */
export function StatTile({
  label,
  value,
  formatter,
  sub,
  delta,
  deltaFormatter,
  goodWhen = "neutral",
  trend,
}: {
  label: string;
  value: number | string | ReactNode;
  /** `value` が number のときの整形関数 (既定はロケール区切りの整数)。 */
  formatter?: (n: number) => string;
  sub?: ReactNode;
  /** 前回値との差分 (今回 − 前回)。null / undefined / 非有限値なら行ごと出さない。 */
  delta?: number | null;
  /** `delta` の絶対値の整形関数 (既定は `formatter`、無ければロケール区切り)。 */
  deltaFormatter?: (n: number) => string;
  /** 増加 (`up`) / 減少 (`down`) のどちらが良い指標か。既定 `neutral` は良悪を付けない。 */
  goodWhen?: StatDeltaGood;
  /** 直近の推移 (古い順)。2 点未満では出さない。 */
  trend?: readonly LatencySample[];
}) {
  const showDelta = delta != null && Number.isFinite(delta);
  const showTrend = trend != null && trend.filter((v) => v !== null).length >= 2;
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
      {showDelta && (
        <StatDelta
          delta={delta}
          good={goodWhen}
          formatter={deltaFormatter ?? formatter ?? ((n) => n.toLocaleString())}
        />
      )}
      {showTrend && (
        <Flex mt="1">
          <LatencySparkline samples={trend} neutral />
        </Flex>
      )}
      {sub != null && sub !== false && (
        <chakra.div textStyle="caption">
          <chakra.span textStyle="numeric">{sub}</chakra.span>
        </chakra.div>
      )}
    </Box>
  );
}
