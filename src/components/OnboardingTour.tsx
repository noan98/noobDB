import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { chakra, Flex, Text } from "@chakra-ui/react";
import { AnimatePresence, motion } from "motion/react";
import { transitions, variants } from "../motion";
import { useFocusTrap, useReturnFocus } from "../keyboardNav";
import { useT } from "../i18n";
import { Icon, type IconName } from "./Icon";
import { Button } from "./ui";
import {
  INITIAL_TOUR_STATE,
  isFirstStep,
  isLastStep,
  nextStep,
  prevStep,
  TOUR_STEP_COUNT,
  type TourState,
} from "../onboarding";

// 既存 (ContextMenu / SplashScreen) と同じく chakra でラップした motion 要素。
// `transition` を Chakra のスタイルプロップに飲まれず motion へ渡すため
// forwardProps で素通しする。
const MotionCard = chakra(motion.div, {}, { forwardProps: ["transition"] });

interface StepContent {
  icon: IconName;
  title: string;
  description: string;
}

/** 長さ N のタプル型を組み立てる再帰ヘルパー (下記 steps の長さ固定用)。 */
type TupleOf<T, N extends number, R extends readonly T[] = []> = R["length"] extends N
  ? R
  : TupleOf<T, N, [...R, T]>;

/**
 * steps 配列の要素数は `onboarding.ts` の `TOUR_STEP_COUNT` と一致していなければ
 * ならない (進行状態のクランプ先が配列外だと最終ステップで undefined を引く)。
 * タプル型で長さをコンパイル時に固定し、片方だけ変更すると tsc が落ちるようにする。
 */
type StepTuple = TupleOf<StepContent, typeof TOUR_STEP_COUNT>;

interface Props {
  /** スキップ・完了・Esc いずれで閉じても呼ぶ。永続化 (`markShown`) は呼び出し側
   *  (App.tsx) の責務とし、このコンポーネント自体はステップの進行のみ扱う。 */
  onClose: () => void;
}

/**
 * 初回起動オンボーディングツアー (#599)。画面右下に浮く軽量なステップカードで、
 * 特定 UI 要素へのアンカー吹き出し (コーチマーク) までは行わず、説明カードの
 * 遷移のみで完結する。`useFocusTrap` でカード内にフォーカスを閉じ込め、Esc で
 * 閉じられる (`keyboardNav.ts` を他のポップオーバーと同様に再利用)。登場は
 * `motion.ts` の enter 系プリセットのみで、reduced-motion 時は `MotionConfig`
 * により自動的に即時化される。
 */
export function OnboardingTour({ onClose }: Props) {
  const t = useT();
  const [state, setState] = useState<TourState>(INITIAL_TOUR_STATE);
  const cardRef = useRef<HTMLDivElement | null>(null);

  // 開く前にフォーカスしていた要素へ、閉じたときに戻す。
  useReturnFocus();
  // カード内で Tab をループさせ、Esc で閉じる。
  useFocusTrap(cardRef, onClose);

  // マウント時にカード内の最初の操作可能要素へフォーカスを移す。
  useEffect(() => {
    cardRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, []);

  const steps: StepTuple = [
    {
      icon: "server",
      title: t("onboardingStepConnectTitle"),
      description: t("onboardingStepConnectDesc"),
    },
    {
      icon: "query",
      title: t("onboardingStepQueryTitle"),
      description: t("onboardingStepQueryDesc"),
    },
    {
      icon: "table",
      title: t("onboardingStepEditTitle"),
      description: t("onboardingStepEditDesc"),
    },
    {
      icon: "snippet",
      title: t("onboardingStepMoreTitle"),
      description: t("onboardingStepMoreDesc"),
    },
  ];
  const current = steps[state.step];

  const handleNext = () => {
    if (isLastStep(state)) {
      onClose();
      return;
    }
    setState(nextStep(state));
  };

  return createPortal(
    <MotionCard
      ref={cardRef}
      position="fixed"
      right="20px"
      bottom="20px"
      zIndex="popover"
      w="320px"
      maxW="calc(100vw - 40px)"
      bg="app.surface"
      border="1px solid"
      borderColor="app.borderStrong"
      borderRadius="lg"
      boxShadow="elevationPopover"
      p="4"
      display="flex"
      flexDirection="column"
      gap="3"
      role="dialog"
      aria-label={t("onboardingTourTitle")}
      initial={{ opacity: 0, y: 12, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={transitions.emphasized}
    >
      <Flex align="flex-start" justify="space-between" gap="2">
        <Flex align="center" gap="2">
          <Flex
            align="center"
            justify="center"
            boxSize="30px"
            rounded="md"
            bg="app.surfaceMuted"
            color="app.accent"
            aria-hidden
            overflow="hidden"
          >
            {/* ステップ切替時、アイコンをクロスフェードする (#819)。key をステップ
                番号にして毎回入れ替え、initial={false} で初回マウント時のフェード
                インは抑える。reduced-motion はルートの MotionConfig が自動吸収。 */}
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={state.step}
                initial={variants.fade.initial}
                animate={variants.fade.animate}
                exit={variants.fade.exit}
                transition={transitions.crossfade}
                style={{ display: "inline-flex" }}
              >
                <Icon name={current.icon} size={16} strokeWidth={1.5} />
              </motion.div>
            </AnimatePresence>
          </Flex>
          <chakra.div overflow="hidden">
            {/* タイトルの差し替えも同じくクロスフェード + わずかなスライド
                (`variants.slideUp`) で行う。 */}
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={state.step}
                initial={variants.slideUp.initial}
                animate={variants.slideUp.animate}
                exit={variants.slideUp.exit}
                transition={transitions.crossfade}
              >
                <Text fontWeight="600" fontSize="sm" color="app.text">
                  {current.title}
                </Text>
              </motion.div>
            </AnimatePresence>
          </chakra.div>
        </Flex>
        <chakra.button
          type="button"
          onClick={onClose}
          aria-label={t("onboardingCloseAria")}
          title={t("onboardingCloseAria")}
          display="inline-flex"
          alignItems="center"
          justifyContent="center"
          boxSize="24px"
          flexShrink={0}
          p="0"
          bg="transparent"
          border="none"
          borderRadius="sm"
          color="app.textMuted"
          cursor="pointer"
          _hover={{ bg: "app.hover", color: "app.text" }}
          _focusVisible={{ outline: "none", boxShadow: "var(--focus-ring)" }}
        >
          <Icon name="close" size={14} />
        </chakra.button>
      </Flex>

      <chakra.div overflow="hidden">
        {/* 説明文もタイトルと同じく `slideUp` でクロスフェードする (#819)。 */}
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={state.step}
            initial={variants.slideUp.initial}
            animate={variants.slideUp.animate}
            exit={variants.slideUp.exit}
            transition={transitions.crossfade}
          >
            <Text color="app.textMuted" fontSize="sm" lineHeight="1.6">
              {current.description}
            </Text>
          </motion.div>
        </AnimatePresence>
      </chakra.div>

      {/* ドット式の視覚的プログレスインジケータ (#819)。テキストの「1 / 4」を
          置き換えるのではなく併存させ、一目で全体のステップ数と現在地を示す。
          単純な色/サイズの補間なので CSS transition のまま (motion.ts の方針
          どおり、mount/unmount を伴わない状態変化は CSS に任せる)。個々のドットは
          装飾目的で aria-hidden にし、グループ全体の aria-label で
          スクリーンリーダーへ現在地を伝える。 */}
      <Flex
        role="group"
        aria-label={t("onboardingProgressAria", { current: state.step + 1, total: TOUR_STEP_COUNT })}
        justify="center"
        align="center"
        gap="1.5"
      >
        {Array.from({ length: TOUR_STEP_COUNT }, (_, i) => (
          <chakra.span
            key={i}
            aria-hidden
            data-active={i === state.step ? "true" : undefined}
            display="inline-block"
            boxSize={i === state.step ? "8px" : "6px"}
            rounded="full"
            bg={i === state.step ? "app.accent" : "app.borderStrong"}
            transitionProperty="width, height, background-color"
            transitionDuration="var(--dur-fast)"
            transitionTimingFunction="var(--ease)"
          />
        ))}
      </Flex>

      <Flex align="center" justify="space-between" mt="1" gap="2">
        <chakra.button
          type="button"
          onClick={onClose}
          fontSize="xs"
          color="app.textMuted"
          bg="transparent"
          border="none"
          cursor="pointer"
          textDecoration="underline"
          p="0"
          _hover={{ color: "app.text" }}
          _focusVisible={{ outline: "none", boxShadow: "var(--focus-ring)" }}
        >
          {t("onboardingSkip")}
        </chakra.button>

        <Flex align="center" gap="2">
          <Text fontSize="xs" color="app.textMuted" aria-hidden>
            {t("onboardingStepCounter", { current: state.step + 1, total: TOUR_STEP_COUNT })}
          </Text>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={isFirstStep(state)}
            onClick={() => setState(prevStep(state))}
          >
            {t("onboardingBack")}
          </Button>
          <Button type="button" variant="primary" size="sm" onClick={handleNext}>
            {isLastStep(state) ? t("onboardingFinish") : t("onboardingNext")}
          </Button>
        </Flex>
      </Flex>
    </MotionCard>,
    document.body,
  );
}
