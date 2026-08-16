import { useId, useRef } from "react";
import { chakra } from "@chakra-ui/react";
import { motion } from "motion/react";

import { springs } from "../motion";
import { useRovingFocus } from "../keyboardNav";
import { Icon, ICON_SIZES, type IconName } from "./Icon";

// motion 要素を Chakra style props で装飾できるようにラップする。`TabBar` の
// `MotionIndicator` と同じパターン (motion の `transition` プロップは Chakra の
// スタイルプロップ名と衝突するため明示的に転送する。それ以外の motion プロップ —
// layoutId など — はスタイルプロップではないので既定で転送される)。新しい Motion
// 基盤を増やさず、既存の `layoutId` スプリングパターンをそのまま再利用する。
const MotionThumb = chakra(motion.span, {}, { forwardProps: ["transition"] });

export interface SegmentedOption<T extends string> {
  value: T;
  /** 表示ラベル (呼び出し側で翻訳済みの文字列を渡す)。 */
  label: string;
  /** ラベルの前に表示する任意のアイコン。 */
  icon?: IconName;
}

interface Props<T extends string> {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  /** `role="radiogroup"` のアクセシブルネーム。 */
  ariaLabel: string;
}

/**
 * 排他選択の共有セグメントコントロール (#975)。
 *
 * `ResultViewSwitch` (グリッド/ピボット/チャート) と `SettingsView` の密度・
 * モーション設定セグメントが、それぞれ背景色の瞬間切替のみで実装されており
 * `TabBar` が確立している「Motion の `layoutId` スプリング付きインジケータ」の
 * 品質水準に達していなかった。本コンポーネントへ集約し、アクティブなセグメントの
 * 背後を `layoutId` サムが `springs.snappy` (`Switch` のつまみと同じスプリング)
 * でスライドする挙動に統一する。
 *
 * サムは選択中のボタン自身の内側に `position: absolute; inset: 0` で描画する
 * (`TabBar` のアクティブインジケータと同じ技法)。ボタンごとに幅が異なっても、
 * Motion が `layoutId` を共有する要素間の bounding box の差分を検出して
 * 自動で FLIP アニメーションするため、サムの幅/位置を手動計算する必要がない。
 *
 * reduced-motion: ルートの `<MotionConfig reducedMotion="user">`
 * (`src/main.tsx`) が `motion/react` ツリー全体へ伝播するため、個別の分岐は
 * 不要 (`motion.ts` の reducedMotion 方針を参照)。
 *
 * a11y: `role="radiogroup"` + 各セグメント `role="radio"` / `aria-checked` の
 * 排他選択として公開し、左右矢印 / Home / End のフォーカス移動を
 * `useRovingFocus` に委ねる (選択は Enter/Space またはクリック — ネイティブ
 * `<button>` なので追加のキー処理は不要)。未選択セグメントは `tabIndex={-1}`
 * としてグループ全体を Tab 移動で 1 ストップとして扱う。
 */
export function Segmented<T extends string>({ value, options, onChange, ariaLabel }: Props<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const thumbId = `segmented-thumb-${useId()}`;
  const { onKeyDown } = useRovingFocus(ref, "[role=radio]", {
    orientation: "horizontal",
  });

  return (
    <chakra.div
      ref={ref}
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      display="inline-flex"
      alignItems="stretch"
      flexShrink={0}
      gap="1px"
      p="2px"
      border="1px solid"
      borderColor="app.borderStrong"
      borderRadius="md"
      bg="app.surface"
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <chakra.button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => {
              if (!active) onChange(opt.value);
            }}
            position="relative"
            display="inline-flex"
            alignItems="center"
            justifyContent="center"
            gap="1"
            py="1"
            px="2.5"
            font="inherit"
            fontSize="sm"
            fontWeight={active ? 600 : 500}
            whiteSpace="nowrap"
            cursor="pointer"
            border="none"
            borderRadius="sm"
            bg="transparent"
            color={active ? "app.text" : "app.textMuted"}
            transitionProperty="color"
            transitionDuration="var(--dur-fast)"
            transitionTimingFunction="var(--ease)"
            _hover={active ? undefined : { color: "app.text" }}
            _focusVisible={{
              outline: "none",
              boxShadow: "inset 0 0 0 2px color-mix(in srgb, var(--accent) 55%, transparent)",
            }}
          >
            {active && (
              <MotionThumb
                layoutId={thumbId}
                transition={springs.snappy}
                position="absolute"
                inset="0"
                borderRadius="sm"
                bg="color-mix(in srgb, var(--accent) 18%, transparent)"
                zIndex={0}
                aria-hidden
              />
            )}
            <chakra.span
              position="relative"
              zIndex={1}
              display="inline-flex"
              alignItems="center"
              gap="1"
            >
              {opt.icon && <Icon name={opt.icon} size={ICON_SIZES.sm} />}
              {opt.label}
            </chakra.span>
          </chakra.button>
        );
      })}
    </chakra.div>
  );
}
