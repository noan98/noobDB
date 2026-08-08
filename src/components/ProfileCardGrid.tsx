import { useId } from "react";
import { chakra, Flex, Text } from "@chakra-ui/react";
import { motion, useReducedMotion } from "motion/react";
import type { ConnectionProfile } from "../api/tauri";
import { useT } from "../i18n";
import { staggerContainer, variants } from "../motion";
import {
  driverColor,
  driverIconName,
  workspaceSpineColor,
} from "../profileIdentity";
import { Heading } from "./ui";
import { Icon, ICON_SIZES, type IconName } from "./Icon";
import { GroupAvatar, ProfileBadges, ProfileColorChip } from "./ProfileBadge";
import { Spinner } from "./Spinner";

// Chakra でラップした motion 要素 (WelcomeView / EmptyState と同じパターン)。
// motion 用 props は Chakra のスタイルプロップに飲まれないよう forwardProps で
// 素通しする。
const MotionFlex = chakra(motion.div, {}, {
  forwardProps: ["transition", "initial", "animate", "variants"],
});
const MotionCard = chakra(motion.button, {}, {
  forwardProps: ["transition", "variants"],
});

interface Props {
  /** 表示するプロファイル (App の並び順そのまま)。 */
  profiles: ConnectionProfile[];
  /** 接続試行中のプロファイル id (カードにスピナーを出し、多重クリックを防ぐ)。 */
  connectingId: string | null;
  onConnect: (profile: ConnectionProfile) => void;
  /** 「新しい接続」カード — 空の接続フォームを開く。 */
  onCreate: () => void;
}

/** プロファイルの接続先を 1 行で要約する (ヘッダーの表示と同じ書式)。 */
function endpointSummary(p: ConnectionProfile): string {
  if (p.driver === "sqlite") return p.file_path ?? "";
  return `${p.user}@${p.host}:${p.port}${p.database ? `/${p.database}` : ""}`;
}

/**
 * 起動直後・未接続時の接続プロファイルカード (#874)。
 *
 * サイドバーの密なツリー行が「常用ナビ」なのに対し、こちらは「入口」— メイン
 * ペインの空状態に、どこへ繋ぐかを一目で選べるカードを並べる。色チップ・
 * グループアバター・本番/読取専用バッジは `ProfileBadge.tsx`、ドライバの
 * アイコン/色と本番スパイン色は `profileIdentity.ts` をそのまま再利用し、
 * 実装を二重に持たない。出現は `motion.ts` の stagger プリセット (#875) で、
 * reduced-motion 時は `useReducedMotion` (MotionConfig の設定も反映) を渡して
 * 同時表示へフォールバックする。
 */
export function ProfileCardGrid({ profiles, connectingId, onConnect, onCreate }: Props) {
  const t = useT();
  const reduced = useReducedMotion() ?? false;

  return (
    <Flex direction="column" flex="1" overflow="auto" align="center" px="6" py="8" gap="5">
      <Flex direction="column" align="center" gap="1.5" textAlign="center">
        <Heading role="display">{t("profileCardsTitle")}</Heading>
        <Text color="app.textMuted" fontSize="sm" lineHeight="1.6" maxW="52ch">
          {t("profileCardsSubtitle")}
        </Text>
      </Flex>
      <MotionFlex
        display="flex"
        flexWrap="wrap"
        justifyContent="center"
        gap="3"
        maxW="960px"
        variants={staggerContainer(reduced)}
        initial="initial"
        animate="animate"
      >
        {profiles.map((p) => {
          const connecting = connectingId === p.id;
          return (
            <ProfileCard
              key={p.id}
              profile={p}
              connecting={connecting}
              disabled={connectingId != null && !connecting}
              onConnect={() => onConnect(p)}
            />
          );
        })}
        <MotionCard
          type="button"
          variants={variants.staggerItem}
          onClick={onCreate}
          display="flex"
          flexDirection="column"
          alignItems="center"
          justifyContent="center"
          gap="2"
          flex="0 1 240px"
          minW="220px"
          maxW="280px"
          minH="118px"
          p="4"
          bg="transparent"
          border="1px dashed"
          borderColor="app.borderStrong"
          borderRadius="lg"
          color="app.textMuted"
          cursor="pointer"
          transitionProperty="background, border-color, color"
          transitionDuration="var(--dur-fast)"
          transitionTimingFunction="var(--ease)"
          _hover={{ bg: "app.hover", color: "app.text", borderColor: "app.accent" }}
          _focusVisible={{ outline: "none", boxShadow: "var(--focus-ring)" }}
        >
          <Icon name="plus" size={ICON_SIZES.lg} />
          <Text fontWeight={600} fontSize="sm">
            {t("profileCardsNew")}
          </Text>
        </MotionCard>
      </MotionFlex>
    </Flex>
  );
}

function ProfileCard({
  profile: p,
  connecting,
  disabled,
  onConnect,
}: {
  profile: ConnectionProfile;
  connecting: boolean;
  disabled: boolean;
  onConnect: () => void;
}) {
  const t = useT();
  const descId = useId();
  const driverIcon: IconName = driverIconName(p.driver) ?? "server";
  const endpoint = endpointSummary(p);
  return (
    <MotionCard
      type="button"
      variants={variants.staggerItem}
      onClick={onConnect}
      disabled={disabled || connecting}
      aria-label={p.name}
      aria-describedby={descId}
      aria-busy={connecting || undefined}
      display="flex"
      flexDirection="column"
      alignItems="stretch"
      textAlign="left"
      gap="2"
      flex="0 1 240px"
      minW="220px"
      maxW="280px"
      minH="118px"
      p="4"
      bg="app.surface"
      border="1px solid"
      borderColor="app.border"
      // 本番は常に危険色のスパインで際立たせる (サイドバーのワークスペース・
      // スパイン #791 と同じ色決定を共有)。非本番はプロファイル色/アクセント。
      borderLeft="3px solid"
      borderLeftColor={workspaceSpineColor(p)}
      borderRadius="lg"
      cursor="pointer"
      transitionProperty="background, border-color, box-shadow, transform"
      transitionDuration="var(--dur-fast)"
      transitionTimingFunction="var(--ease)"
      _hover={{ bg: "app.hover", borderColor: "app.borderStrong", borderLeftColor: workspaceSpineColor(p) }}
      _focusVisible={{ outline: "none", boxShadow: "var(--focus-ring)" }}
      _active={{ transform: "translateY(1px)" }}
      _disabled={{ opacity: 0.6, cursor: "default" }}
    >
      <Flex align="center" gap="2" minW={0}>
        <ProfileColorChip color={p.color} />
        <Text
          fontWeight={600}
          fontSize="sm"
          color="app.text"
          flex="1"
          minW={0}
          overflow="hidden"
          textOverflow="ellipsis"
          whiteSpace="nowrap"
        >
          {p.name}
        </Text>
        <ProfileBadges isProduction={p.is_production} readOnly={p.read_only} compact />
      </Flex>
      <Flex align="center" gap="2" minW={0} color="app.textMuted">
        <chakra.span
          aria-hidden
          display="inline-flex"
          flexShrink={0}
          style={{ color: driverColor(p.driver) }}
        >
          {connecting ? <Spinner size={14} /> : <Icon name={driverIcon} size={ICON_SIZES.md} />}
        </chakra.span>
        <Text
          id={descId}
          fontSize="xs"
          fontFamily="var(--font-mono)"
          minW={0}
          overflow="hidden"
          textOverflow="ellipsis"
          whiteSpace="nowrap"
        >
          {connecting ? t("statusConnecting", { name: p.name }) : endpoint}
        </Text>
      </Flex>
      {p.group && (
        <Flex align="center" gap="1.5" minW={0} color="app.textMuted">
          <GroupAvatar name={p.group} size={16} />
          <Text fontSize="xs" minW={0} overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
            {p.group}
          </Text>
        </Flex>
      )}
    </MotionCard>
  );
}
