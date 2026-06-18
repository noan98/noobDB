import { Flex, chakra } from "@chakra-ui/react";
import { motion } from "motion/react";
import { BrandMark, Wordmark } from "../brand";
import { durations, easings } from "../motion";
import { useT } from "../i18n";

// 既存 (Modal.tsx) と同じく chakra でラップした motion 要素。`transition` は
// Chakra に消されないよう forwardProps で素通しする。
const MotionFlex = chakra(motion.div, {}, { forwardProps: ["transition"] });
const MotionDiv = chakra(motion.div, {}, { forwardProps: ["transition"] });

/**
 * 起動 / 初期ロードのスプラッシュ (#619)。
 *
 * 接続プロファイルの初回読み込みが終わるまでの一瞬を、ブランドマーク + ワードマーク
 * の落ち着いた出現で整える。`AnimatePresence` 配下に置き、ブート完了で取り外すと
 * フェードアウトする (`App.tsx` 参照)。
 *
 * Motion は `motion/react` ツリー (`MotionConfig reducedMotion="user"`、`main.tsx`)
 * の配下にあるため、OS が「動きを減らす」設定のときは出現/退場アニメが自動で即時化
 * される (個別の分岐は不要)。下端の不定プログレスは CSS アニメーションだが、
 * `App.css` 末尾の `@media (prefers-reduced-motion: reduce)` が同様に無効化する。
 */
export function SplashScreen() {
  const t = useT();
  return (
    <MotionFlex
      // タイトルバーを含む全面を覆う。地はアプリ背景でテーマに追従。
      position="absolute"
      inset={0}
      zIndex="modal"
      display="flex"
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      gap="5"
      bg="app.bg"
      css={{ userSelect: "none", WebkitUserSelect: "none" }}
      aria-hidden
      initial={{ opacity: 1 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: durations.slow, ease: easings.standard }}
    >
      <MotionDiv
        initial={{ opacity: 0, scale: 0.86, y: 6 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: durations.slow, ease: easings.out }}
      >
        <BrandMark size={96} />
      </MotionDiv>

      <MotionDiv
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: durations.med, ease: easings.out, delay: 0.08 }}
      >
        <Flex direction="column" align="center" gap="1.5">
          <Wordmark fontSize="var(--text-xl)" />
          <chakra.span fontSize="var(--text-sm)" color="app.textMuted">
            {t("splashTagline")}
          </chakra.span>
        </Flex>
      </MotionDiv>

      {/* 不定プログレス (起動中の合図)。控えめな幅でブランド青を流す。 */}
      <chakra.div
        position="relative"
        width="160px"
        height="3px"
        borderRadius="pill"
        overflow="hidden"
        bg="app.border"
        aria-hidden
      >
        <chakra.div
          position="absolute"
          insetY={0}
          width="40%"
          borderRadius="pill"
          css={{
            background: "var(--brand-gradient)",
            animation: "query-progress-slide 1.1s var(--ease) infinite",
          }}
        />
      </chakra.div>
    </MotionFlex>
  );
}
