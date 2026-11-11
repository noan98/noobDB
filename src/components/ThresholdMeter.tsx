import { Box, chakra } from "@chakra-ui/react";

/** メーターの塗りの色調。`accent` は通常、`warning` / `danger` は閾値超え。 */
export type ThresholdMeterTone = "accent" | "warning" | "danger";

/** 目盛り上の閾値マーカー (0〜100% の位置とラベル)。 */
export interface ThresholdMarker {
  percent: number;
  label: string;
}

const FILL_BG: Record<ThresholdMeterTone, string> = {
  accent: "app.accent",
  warning: "app.warningBg",
  danger: "app.dangerBg",
};

/** 右端に近いマーカーのラベルは、右端を合わせて親の外へはみ出さないようにする。 */
const LABEL_FLIP_PERCENT = 85;

/**
 * 閾値マーカー付きの使用率メーター (#2239)。SQLite メンテナンスの空きページ率 (閾値 1 本) と、
 * アドバイザの採番枯渇 (警告 80% / 危険 95% の 2 本) で共用する。値は 0〜100 の割合で、
 * `role="meter"` + `aria-valuenow` を付ける。色は呼び出し側が `tone` で決める (閾値の意味は画面ごとに違う)。
 * `testIdPrefix` 付きなら `<prefix>` / `-fill` / `-threshold` の `data-testid` を出す。
 */
export function ThresholdMeter({
  percent,
  tone,
  markers,
  ariaLabel,
  valueText,
  testIdPrefix,
}: {
  percent: number;
  tone: ThresholdMeterTone;
  markers: readonly ThresholdMarker[];
  ariaLabel: string;
  /** 読み上げ用の値 (既定は「N%」)。 */
  valueText?: string;
  testIdPrefix?: string;
}) {
  const pct = Math.min(100, Math.max(0, percent));
  const tid = (suffix: string) => (testIdPrefix ? `${testIdPrefix}${suffix}` : undefined);
  return (
    <Box data-testid={tid("")}>
      <Box
        role="meter"
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-valuetext={valueText ?? `${Math.round(pct)}%`}
        position="relative"
        h="2"
        borderRadius="sm"
        bg="app.surfaceMuted"
        overflow="visible"
      >
        <Box
          h="100%"
          borderRadius="sm"
          bg={FILL_BG[tone]}
          style={{ width: `${pct}%` }}
          data-testid={tid("-fill")}
          data-tone={tone}
        />
        {markers.map((m) => (
          <Box
            key={m.percent}
            aria-hidden
            position="absolute"
            top="-1"
            bottom="-1"
            w="0.5"
            bg="app.text"
            style={{ left: `${m.percent}%` }}
            data-testid={tid("-threshold")}
          />
        ))}
      </Box>
      <chakra.div position="relative" h="4" mt="1" textStyle="caption" color="app.textMuted" aria-hidden>
        {markers.map((m) => (
          <chakra.span
            key={m.percent}
            position="absolute"
            textStyle="numeric"
            whiteSpace="nowrap"
            style={
              m.percent > LABEL_FLIP_PERCENT ? { right: `${100 - m.percent}%` } : { left: `${m.percent}%` }
            }
          >
            {m.label}
          </chakra.span>
        ))}
      </chakra.div>
    </Box>
  );
}
