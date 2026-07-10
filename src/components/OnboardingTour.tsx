import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { chakra, Flex, Text } from "@chakra-ui/react";
import { motion } from "motion/react";
import { transitions } from "../motion";
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

  const steps: StepContent[] = [
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
          >
            <Icon name={current.icon} size={16} strokeWidth={1.5} />
          </Flex>
          <Text fontWeight="600" fontSize="sm" color="app.text">
            {current.title}
          </Text>
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

      <Text color="app.textMuted" fontSize="sm" lineHeight="1.6">
        {current.description}
      </Text>

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
