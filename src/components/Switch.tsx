import { chakra } from "@chakra-ui/react";
import { motion } from "motion/react";
import { useId, type KeyboardEvent, type ReactNode } from "react";
import { springs } from "../motion";

/**
 * `motion` の `layout` を使って thumb をスプリングアニメーションで動かす
 * 自作 Switch コンポーネント。Chakra v3 の Switch は使わず、見た目とトークン
 * (`app.accent` / `app.muted`) は Chakra で揃え、動きだけ `motion` に任せる
 * 役割分担にしている。
 *
 * `prefers-reduced-motion: reduce` は親の `<MotionConfig reducedMotion="user">`
 * (`main.tsx`) が `motion/react` 全体に伝播するため、本コンポーネントの
 * トランジションも自動で即時切替になる。
 *
 * アクセシビリティ:
 * - `role="switch"` と `aria-checked` をルート要素に付与する。
 * - キーボード操作は Space / Enter で切替。
 * - `disabled` のときは tabIndex を外し、操作不能にする。
 */

const SIZES = {
  sm: { trackW: 28, trackH: 16, thumb: 12, pad: 2 },
  md: { trackW: 34, trackH: 20, thumb: 16, pad: 2 },
} as const;

const MotionThumb = chakra(motion.span, {}, { forwardProps: ["transition", "layout"] });

interface Props {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Internal label rendered to the right (optional). */
  label?: ReactNode;
  size?: keyof typeof SIZES;
  id?: string;
  name?: string;
  /** Passed through to the root `<button>` for accessibility wiring. */
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-label"?: string;
  title?: string;
}

export function Switch({
  checked,
  onChange,
  disabled,
  label,
  size = "md",
  id,
  name,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
  "aria-label": ariaLabel,
  title,
}: Props) {
  const dims = SIZES[size];
  // 内蔵 label を表示するときは、その span に id を振って button の
  // `aria-labelledby` に連結する。これがないと SR からは無名コントロールに見える。
  const generatedId = useId();
  const buttonId = id ?? generatedId;
  const internalLabelId = label !== undefined ? `${buttonId}-label` : undefined;
  const labelledBy =
    [ariaLabelledBy, internalLabelId].filter(Boolean).join(" ") || undefined;

  const handleKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      onChange(!checked);
    }
  };

  const focusRing = "0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent)";

  const button = (
    <chakra.button
      type="button"
      role="switch"
      id={buttonId}
      name={name}
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      aria-labelledby={labelledBy}
      aria-describedby={ariaDescribedBy}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      onKeyDown={handleKey}
      display="inline-flex"
      alignItems="center"
      position="relative"
      flexShrink={0}
      width={`${dims.trackW}px`}
      height={`${dims.trackH}px`}
      px={`${dims.pad}px`}
      border="1px solid"
      borderColor={checked ? "app.accent" : "app.borderStrong"}
      bg={checked ? "app.accent" : "app.surfaceMuted"}
      borderRadius="pill"
      cursor={disabled ? "not-allowed" : "pointer"}
      opacity={disabled ? 0.5 : 1}
      transitionProperty="background, border-color"
      transitionDuration="var(--dur-fast)"
      transitionTimingFunction="var(--ease)"
      _focusVisible={{ outline: "none", boxShadow: focusRing }}
      verticalAlign="middle"
    >
      <chakra.span
        display="flex"
        width="100%"
        justifyContent={checked ? "flex-end" : "flex-start"}
      >
        <MotionThumb
          layout
          transition={springs.snappy}
          display="block"
          width={`${dims.thumb}px`}
          height={`${dims.thumb}px`}
          borderRadius="full"
          // チェック時はアクセント地のトラック上に乗る「つまみ」なので、文字色
          // (app.accentText) ではなく常に白で塗る。accentText はダークでは紺色に
          // なり、それを使うとつまみがトラックに埋もれてしまうため。
          bg={checked ? "white" : "app.surface"}
          boxShadow="sm"
        />
      </chakra.span>
    </chakra.button>
  );

  if (label === undefined) return button;

  return (
    <chakra.span
      display="inline-flex"
      alignItems="center"
      gap="1.5"
      cursor={disabled ? "not-allowed" : "pointer"}
      userSelect="none"
      onClick={(e) => {
        // Clicking the label toggles the switch — but skip if the click was on
        // the button itself (otherwise we'd toggle twice).
        if (disabled) return;
        if (e.target instanceof HTMLElement && e.target.closest("button[role=switch]")) return;
        onChange(!checked);
      }}
    >
      {button}
      <chakra.span id={internalLabelId} fontSize="inherit" color="inherit">
        {label}
      </chakra.span>
    </chakra.span>
  );
}
