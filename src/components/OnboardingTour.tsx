import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { chakra, Flex, Text } from "@chakra-ui/react";
import { AnimatePresence, motion } from "motion/react";
import { transitions, variants } from "../motion";
import { useFocusTrap, useReturnFocus } from "../keyboardNav";
import { useT } from "../i18n";
import { Icon, ICON_SIZES, type IconName } from "./Icon";
import { FeatureIcon } from "./FeatureIcon";
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
import { Tooltip } from "./Tooltip";
import type { TooltipPlacement, TooltipRect, TooltipSize } from "./tooltipPosition";
import {
  anchorsForStep,
  computeCoachmarkLayout,
  isAnchorUsable,
  sameRect,
  spotlightRect,
} from "../onboardingAnchors";

// 既存 (ContextMenu / SplashScreen) と同じく chakra でラップした motion 要素。
// `transition` を Chakra のスタイルプロップに飲まれず motion へ渡すため
// forwardProps で素通しする。
/** 不可視 (inert / aria-hidden / hidden / visibility:hidden) の要素はアンカーにしない。 */
function isElementVisible(el: HTMLElement): boolean {
  if (el.closest('[inert],[aria-hidden="true"],[hidden]')) return false;
  if (typeof el.checkVisibility === "function") return el.checkVisibility({ visibilityProperty: true });
  return true;
}

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
 * 初回起動オンボーディングツアー (#599, コーチマーク化 #1504)。各ステップは対応する
 * 実 UI 要素 (`onboardingAnchors.ts` の `TOUR_ANCHORS`) を dim オーバーレイのくり抜きで
 * 照らし、その近傍に説明の吹き出しをアンカーする。位置決めは `tooltipPosition.ts`
 * (測定 → フリップ → クランプ) を流用する。アンカー先が無い・画面外・折りたたまれて
 * いる・吹き出しが枠に被るときは、従来どおり dim 無しで右下に浮く説明カードへ
 * フォールバックする。スクロール / リサイズ / レイアウト変化には再測定で追従する。
 * `useFocusTrap` でカード内にフォーカスを閉じ込め、Esc で閉じられる。登場と遷移は
 * `motion.ts` の enter 系プリセットと CSS transition のみで、reduced-motion 時は
 * `MotionConfig` と `App.css` の `prefers-reduced-motion` / `data-motion` により静止する。
 */
export function OnboardingTour({ onClose }: Props) {
  const t = useT();
  const [state, setState] = useState<TourState>(INITIAL_TOUR_STATE);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<{ spot: TooltipRect; placement: TooltipPlacement } | null>(null);
  const [size, setSize] = useState<TooltipSize>({ width: 0, height: 0 });
  const [viewport, setViewport] = useState<TooltipSize>(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  // ステップごとに 1 度だけ scrollIntoView する (測定のたびにスクロールを奪わない)。
  const scrolledStepRef = useRef(-1);
  // ビューポートに加えてアンカー要素自体のサイズ変化も拾う (サイドバー幅変更など)。
  const roRef = useRef<ResizeObserver | null>(null);

  // 開く前にフォーカスしていた要素へ、閉じたときに戻す。
  useReturnFocus();
  // カード内で Tab をループさせ、Esc で閉じる。
  useFocusTrap(cardRef, onClose);

  // マウント時は「次へ」へフォーカスを移す。DOM 順の最初のボタンは右上の × で、開いた
  // 直後の Enter / Space でカードが閉じてしまうため (#1529)。
  useEffect(() => {
    nextRef.current?.focus();
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

  // アンカー要素を探して測定する。候補を優先順に見て、最初に「見えている」ものを採用する。
  // 画面外なら 1 度だけ scrollIntoView を試す。どれも使えなければ null (= フォールバック)。
  const step = state.step;
  const measure = useCallback(() => {
    const vp = { width: window.innerWidth, height: window.innerHeight };
    setViewport((prev) => (prev.width === vp.width && prev.height === vp.height ? prev : vp));
    let found: { spot: TooltipRect; placement: TooltipPlacement } | null = null;
    for (const cand of anchorsForStep(step)) {
      const el = document.querySelector<HTMLElement>(cand.selector);
      if (!el || !isElementVisible(el)) continue;
      roRef.current?.observe(el);
      let rect = el.getBoundingClientRect();
      if (
        !isAnchorUsable(rect, vp) &&
        rect.width > 0 &&
        rect.height > 0 &&
        scrolledStepRef.current !== step
      ) {
        scrolledStepRef.current = step;
        if (typeof el.scrollIntoView === "function") {
          el.scrollIntoView({ block: "nearest", inline: "nearest" });
          rect = el.getBoundingClientRect();
        }
      }
      if (!isAnchorUsable(rect, vp)) continue;
      const spot = spotlightRect(rect, vp);
      if (spot) {
        found = { spot, placement: cand.placement };
        break;
      }
    }
    setAnchor((prev) =>
      prev === found ||
      (prev && found && prev.placement === found.placement && sameRect(prev.spot, found.spot))
        ? prev
        : found,
    );
  }, [step]);

  useLayoutEffect(() => {
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    };
    window.addEventListener("resize", schedule);
    // スクロール可能な祖先すべてを拾うためキャプチャ相で受ける。
    document.addEventListener("scroll", schedule, true);
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    roRef.current = ro;
    ro?.observe(document.documentElement);
    measure();
    // 後から現れる / 動く要素 (タブを開いた直後のエディタ、サイドバーの開閉など) を拾う保険。
    const timer = window.setInterval(measure, 500);
    return () => {
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
      ro?.disconnect();
      roRef.current = null;
      window.clearInterval(timer);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [measure]);

  // 吹き出し自身のサイズ (ステップで文面の高さが変わる) を測る。
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    setSize((prev) => (prev.width === w && prev.height === h ? prev : { width: w, height: h }));
  });

  // フォーカスがカード外 (背景クリックなど) に落ちても Esc で閉じられるようにする。
  // カード内の Esc は useFocusTrap が処理済み (defaultPrevented) なので二重に呼ばない。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // IME 変換取消・他の Esc 処理 (最大化解除など) は横取りしない。フォーカスが
      // どこにも無い (背景クリック後など) ときだけ拾う。
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      const active = document.activeElement;
      if (active && active !== document.body) return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const layout = anchor ? computeCoachmarkLayout(anchor.spot, size, anchor.placement, viewport) : null;
  // アンカーがあり、吹き出しを枠の外へ置けるときだけ「アンカー表示」。枠に被る (巨大な
  // アンカー) ときは、スポットライトは残したまま吹き出しだけ右下の固定位置へ逃がす。
  const placed = layout !== null && !layout.covers;

  const handleNext = () => {
    if (isLastStep(state)) {
      onClose();
      return;
    }
    setState(nextStep(state));
  };

  return createPortal(
    <>
      {anchor && (
        <>
          {/* 背景操作を止める透明な受け皿。クリックでフォーカスが外へ逃げないよう、
              mousedown を握りつぶして「次へ」へ戻す。 */}
          <chakra.div
            data-testid="onboarding-backdrop"
            position="fixed"
            inset="0"
            zIndex="popover"
            aria-hidden
            onMouseDown={(e) => {
              e.preventDefault();
              nextRef.current?.focus();
            }}
          />
          {/* スポットライト: 枠の外側へ巨大な box-shadow で dim をかけてくり抜く。
              移動・拡縮は CSS transition (reduced-motion は App.css が一括で静止)。 */}
          <chakra.div
            data-testid="onboarding-spotlight"
            position="fixed"
            zIndex="popover"
            pointerEvents="none"
            aria-hidden
            borderRadius="md"
            border="2px solid"
            borderColor="app.accent"
            transitionProperty="left, top, width, height"
            transitionDuration="var(--dur-med)"
            transitionTimingFunction="var(--ease)"
            css={{ boxShadow: "0 0 0 100vmax var(--tour-dim)" }}
            style={{
              left: anchor.spot.left,
              top: anchor.spot.top,
              width: anchor.spot.width,
              height: anchor.spot.height,
            }}
          />
        </>
      )}
      <MotionCard
        ref={cardRef}
        position="fixed"
        right={placed ? "auto" : "20px"}
        bottom={placed ? "auto" : "20px"}
        zIndex="popover"
        data-anchored={placed ? "true" : undefined}
        style={placed && layout ? { left: layout.left, top: layout.top } : undefined}
        transitionProperty="left, top"
        transitionDuration="var(--dur-med)"
        transitionTimingFunction="var(--ease)"
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
            <FeatureIcon icon={current.icon} size="sm" transitionKey={state.step} />
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
                  <Text textStyle="subheading">{current.title}</Text>
                </motion.div>
              </AnimatePresence>
            </chakra.div>
          </Flex>
          <Tooltip label={t("onboardingCloseAria")}>
            <chakra.button
              type="button"
              onClick={onClose}
              aria-label={t("onboardingCloseAria")}
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
              <Icon name="close" size={ICON_SIZES.md} />
            </chakra.button>
          </Tooltip>
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
            data-testid="onboarding-skip"
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
            <Button
              ref={nextRef}
              type="button"
              variant="primary"
              size="sm"
              data-testid="onboarding-next"
              onClick={handleNext}
            >
              {isLastStep(state) ? t("onboardingFinish") : t("onboardingNext")}
            </Button>
          </Flex>
        </Flex>
      </MotionCard>
    </>,
    document.body,
  );
}
