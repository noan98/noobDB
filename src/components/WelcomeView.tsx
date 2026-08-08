import { useId } from "react";
import { chakra, Flex, Text } from "@chakra-ui/react";
import { Heading } from "./ui";
import { motion, useReducedMotion } from "motion/react";
import { open } from "@tauri-apps/plugin-dialog";
import { useT } from "../i18n";
import { staggerContainer, transitions, variants } from "../motion";
import { BrandMark } from "../brand";
import { WelcomeIllustration } from "./illustrations";
import { Icon, ICON_SIZES, type IconName } from "./Icon";

// 既存 (EmptyState / SplashScreen) と同じく chakra でラップした motion 要素。
// `transition` は Chakra のスタイルプロップに飲まれず motion へ渡すため
// forwardProps で素通しする。
const MotionRoot = chakra(motion.div, {}, { forwardProps: ["transition"] });
const MotionDiv = chakra(motion.div, {}, { forwardProps: ["transition"] });
// 主要導線カードの stagger (順次出現、#875) 用。variants を motion へ素通しする。
const MotionRow = chakra(motion.div, {}, { forwardProps: ["variants", "initial", "animate"] });
const MotionCardButton = chakra(motion.button, {}, { forwardProps: ["variants"] });

interface Props {
  /** 「接続を追加」— 空の接続フォームを開く (ConnectionList の onCreate と同じ)。 */
  onCreateConnection: () => void;
  /** 「SQLite ファイルを開く」— ファイル選択後、選ばれたパスを渡す。 */
  onOpenSqlite: (filePath: string) => void;
  /** 「はじめかたを見る」— 軽量オンボーディングツアーを開始する。 */
  onStartTour: () => void;
}

interface CardProps {
  icon: IconName;
  title: string;
  description: string;
  onClick: () => void;
}

/**
 * ウェルカム画面の主要導線カード。ボタン要素でキーボード操作可能。
 *
 * `aria-label` をタイトルと一致させ (WCAG 2.5.3 label-in-name)、説明文は
 * `aria-describedby` で補助情報として結び付ける。これをしないと、ボタン内の
 * 見出し+説明の全テキストがそのままアクセシブルネームになってしまい
 * (アイコンだけが aria-hidden で除外される)、スクリーンリーダーでの読み上げが
 * 冗長になる。
 */
function WelcomeCard({ icon, title, description, onClick }: CardProps) {
  const descId = useId();
  return (
    <MotionCardButton
      type="button"
      variants={variants.staggerItem}
      onClick={onClick}
      aria-label={title}
      aria-describedby={descId}
      display="flex"
      flexDirection="column"
      alignItems="flex-start"
      gap="2"
      textAlign="left"
      flex="1 1 220px"
      minW="200px"
      maxW="280px"
      p="4"
      bg="app.surface"
      border="1px solid"
      borderColor="app.border"
      borderRadius="lg"
      cursor="pointer"
      transitionProperty="background, border-color, box-shadow, transform"
      transitionDuration="var(--dur-fast)"
      transitionTimingFunction="var(--ease)"
      _hover={{ bg: "app.hover", borderColor: "app.borderStrong" }}
      _focusVisible={{ outline: "none", boxShadow: "var(--focus-ring)" }}
      _active={{ transform: "translateY(1px)" }}
    >
      <Flex
        align="center"
        justify="center"
        boxSize="40px"
        rounded="lg"
        bg="app.surfaceMuted"
        color="app.accent"
        aria-hidden
      >
        <Icon name={icon} size={ICON_SIZES.lg} strokeWidth={1.5} />
      </Flex>
      <Text fontWeight="600" color="app.text" fontSize="sm">
        {title}
      </Text>
      <Text id={descId} color="app.textMuted" fontSize="xs" lineHeight="1.5">
        {description}
      </Text>
    </MotionCardButton>
  );
}

/**
 * 初回起動ウェルカム画面 (#599)。プロファイルが 1 件も無い未接続時に、通常の
 * `EmptyState` (単一 CTA) の代わりにメインペインへ表示する。ブランド + 大きめの
 * イラストで第一印象を作り、主要導線を 3 枚のカードとして横並びに提示する
 * (接続追加 / SQLite を開く / ツアーを見る)。登場は `motion.ts` の enter 系
 * プリセットのみで、reduced-motion 時は `MotionConfig` により自動的に即時化
 * される。ライト/ダーク・アクセント色への追従はすべて `app.*` トークン経由。
 */
export function WelcomeView({ onCreateConnection, onOpenSqlite, onStartTour }: Props) {
  const t = useT();
  // stagger (#875) は MotionConfig が遅延まで打ち消さないため、reduced-motion
  // では同時表示へ明示的にフォールバックする (motion.ts の staggerContainer 参照)。
  const reduced = useReducedMotion() ?? false;

  const handlePickSqlite = async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      title: t("welcomeOpenSqliteTitle"),
      filters: [
        { name: t("formSqliteFileFilter"), extensions: ["db", "sqlite", "sqlite3"] },
        { name: t("formAnyFileFilter"), extensions: ["*"] },
      ],
    });
    if (typeof selected === "string") onOpenSqlite(selected);
  };

  return (
    <MotionRoot
      display="flex"
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      flex="1"
      overflow="auto"
      gap="5"
      px="6"
      py="8"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transitions.enter}
    >
      <MotionDiv
        aria-hidden
        initial={{ opacity: 0, scale: 0.92 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={transitions.emphasized}
      >
        <WelcomeIllustration size={128} />
      </MotionDiv>

      <Flex direction="column" align="center" gap="1.5" maxW="46ch" textAlign="center">
        <Flex align="center" gap="2">
          <BrandMark size={26} />
          <Heading role="display">
            {t("welcomeTitle")}
          </Heading>
        </Flex>
        <Text color="app.textMuted" fontSize="sm" lineHeight="1.6">
          {t("welcomeSubtitle")}
        </Text>
      </Flex>

      <MotionRow
        display="flex"
        flexWrap="wrap"
        justifyContent="center"
        gap="3"
        maxW="900px"
        variants={staggerContainer(reduced)}
        initial="initial"
        animate="animate"
      >
        <WelcomeCard
          icon="server"
          title={t("welcomeCreateConnectionTitle")}
          description={t("welcomeCreateConnectionDesc")}
          onClick={onCreateConnection}
        />
        <WelcomeCard
          icon="sqlite"
          title={t("welcomeOpenSqliteTitle")}
          description={t("welcomeOpenSqliteDesc")}
          onClick={() => void handlePickSqlite()}
        />
        <WelcomeCard
          icon="help"
          title={t("welcomeStartTourTitle")}
          description={t("welcomeStartTourDesc")}
          onClick={onStartTour}
        />
      </MotionRow>
    </MotionRoot>
  );
}
