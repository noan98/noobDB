import { chakra, type SystemStyleObject } from "@chakra-ui/react";
import { AnimatePresence, motion } from "motion/react";
import type { ComponentProps, MouseEvent } from "react";
import { transitions, variants } from "../motion";
import { Icon, ICON_SIZES } from "./Icon";
import { Tooltip } from "./Tooltip";

/** `transition` は Chakra 自身のスタイルプロップ名と衝突するため、`MultiStateBadge` /
 *  `Tooltip` と同じく motion へ明示的に forward する。 */
const MotionInner = chakra(motion.span, {}, { forwardProps: ["transition", "initial", "animate", "exit"] });

export interface CopyButtonProps
  extends Omit<ComponentProps<typeof chakra.button>, "onClick" | "children" | "aria-label" | "color"> {
  /**
   * 直近のコピーが成功し確認表示中かどうか。`useCopyFeedback` / `useKeyedCopyFeedback`
   * の `copied` (または `copiedKey === key`) をそのまま渡す。
   */
  copied: boolean;
  /**
   * クリック時に呼ぶ。実際のクリップボード書き込みは `useCopyFeedback` 側が担う。
   * 一覧の行のように親要素のクリックも処理している場合は、引数のイベントで
   * `stopPropagation()` を呼べる。
   */
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  /** アイドル時のツールチップ文言・aria-label。 */
  label: string;
  /** コピー直後 (確認表示中) のツールチップ文言・aria-label。 */
  copiedLabel: string;
  /** true ならアイコンの右にラベル文字列も表示する (chip 型)。既定はアイコンのみ。 */
  showLabel?: boolean;
  /** アイコンサイズ。既定 `ICON_SIZES.md`。 */
  iconSize?: number | string;
  /** アイドル時の色トークン。既定 `app.textMuted`。確認表示中は常に `app.textSuccess`。 */
  color?: string;
  /** `Tooltip` の `focusableWrapper` へそのまま渡す (disabled 時も Tab で辿れるようにする)。 */
  focusableWrapper?: boolean;
}

/**
 * 「クリップボードへコピー → 1500ms だけチェックアイコンに切替 → ツールチップ /
 * aria-label も『コピー済み』に変わる」というコピー確認 UI の共通プリミティブ
 * (#1158)。copy ↔ check のアイコン切替は `MultiStateBadge` と同じ
 * `AnimatePresence` + `variants.fadeScale` + `transitions.crossfade` でクロス
 * フェードする (`prefers-reduced-motion` はルートの `MotionConfig` が自動抑制)。
 *
 * 成功色は面の上のテキスト/アイコンなので、渡された `color` に関わらず確認表示中
 * は常に `app.textSuccess` に統一する (UI 規約 §4/§7.3)。
 *
 * クリップボード書き込み自体・1500ms タイマー・unmount cleanup・失敗時トーストは
 * 本コンポーネントの責務ではなく `useCopyFeedback` / `useKeyedCopyFeedback` が担う。
 * レイアウト (サイズ・位置・枠線など) は呼び出し側が Chakra のスタイル props で
 * 指定する (置き場所ごとに差が大きいため、本プリミティブは統一しない)。
 */
export function CopyButton({
  copied,
  onClick,
  label,
  copiedLabel,
  showLabel = false,
  iconSize = ICON_SIZES.md,
  color,
  focusableWrapper,
  disabled,
  _hover,
  ...rest
}: CopyButtonProps) {
  const text = copied ? copiedLabel : label;
  const hoverStyle: SystemStyleObject | undefined = copied
    ? { ...(_hover as SystemStyleObject | undefined), color: "app.textSuccess" }
    : (_hover as SystemStyleObject | undefined);

  return (
    <Tooltip label={text} focusableWrapper={focusableWrapper}>
      <chakra.button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={text}
        color={copied ? "app.textSuccess" : (color ?? "app.textMuted")}
        _hover={hoverStyle}
        {...rest}
      >
        <AnimatePresence mode="wait" initial={false}>
          <MotionInner
            key={copied ? "check" : "copy"}
            initial={variants.fadeScale.initial}
            animate={variants.fadeScale.animate}
            exit={variants.fadeScale.exit}
            transition={transitions.crossfade}
            display="inline-flex"
            flexShrink={0}
            aria-hidden
          >
            <Icon name={copied ? "check" : "copy"} size={iconSize} />
          </MotionInner>
        </AnimatePresence>
        {showLabel && (
          <AnimatePresence mode="wait" initial={false}>
            <MotionInner
              key={copied ? "copied-label" : "idle-label"}
              initial={variants.slideUp.initial}
              animate={variants.slideUp.animate}
              exit={variants.slideUp.exit}
              transition={transitions.crossfade}
              display="inline-block"
            >
              {text}
            </MotionInner>
          </AnimatePresence>
        )}
      </chakra.button>
    </Tooltip>
  );
}
