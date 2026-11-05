import type { ReactNode } from "react";
import { chakra } from "@chakra-ui/react";
import { motion } from "motion/react";
import { springs, variants } from "../motion";
import { Icon, ICON_SIZES } from "./Icon";

/**
 * 破壊的確認ダイアログ (`ConfirmDialog` の danger / warning、`DangerousQueryDialog`) の
 * ヘッダタイトル。先頭の危険アイコンが `variants.fadeScale` + `springs.gentle` で 1 回
 * pop し、取り返しのつかなさを色だけに頼らず「重み」として伝える (#2040)。
 * 安全側ボタンレイアウトには触れない。reduced-motion / `data-motion` オフは
 * `MotionConfig` が自動で抑制するので独自の分岐は持たない。
 */

// motion 用 props は Chakra のスタイルプロップに飲まれないよう forwardProps で素通しする。
const MotionWeightIcon = chakra(
  motion.span,
  {},
  { forwardProps: ["initial", "animate", "transition", "variants"] },
);

export function DestructiveTitle({ tone, children }: { tone: "danger" | "warning"; children: ReactNode }) {
  return (
    <chakra.span display="inline-flex" alignItems="center" gap="2" minWidth={0}>
      <MotionWeightIcon
        aria-hidden="true"
        data-testid="destructive-title-icon"
        display="inline-flex"
        flexShrink={0}
        color={tone === "danger" ? "app.textError" : "app.textWarning"}
        variants={variants.fadeScale}
        initial="initial"
        animate="animate"
        transition={springs.gentle}
      >
        <Icon name={tone === "danger" ? "alert-circle" : "warning"} size={ICON_SIZES.md} />
      </MotionWeightIcon>
      <chakra.span minWidth={0} overflowWrap="anywhere">
        {children}
      </chakra.span>
    </chakra.span>
  );
}
