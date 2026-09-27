import { useId } from "react";
import { chakra, Flex, Text } from "@chakra-ui/react";
import { motion, useReducedMotion } from "motion/react";
import type { ConnectionProfile } from "../api/tauri";
import { useT } from "../i18n";
import { staggerContainer, variants } from "../motion";
import { selectableCardRecipe } from "../theme";
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
// カードの見た目 (角丸・静止エレベーション・ホバーの 1 段上のリフト・押下・
// フォーカスリング) は `ui.tsx` の `SelectableCard` と同じ `selectableCardRecipe`
// (#1161) を共有する。以前 (#1144) はここに `whileHover`/`whileTap` の scale
// spring を個別に持っていたが、影 (box-shadow) と transform を 1 つの CSS
// transition で協調させる必要があり、Motion の spring と CSS transition の
// 二重管理は手触りがずれやすい (影だけ CSS、scale だけ Motion、という分割は
// #1144 の実装コメントにもある通り既に box-shadow との衝突を避けるための妥協
// だった)。そのため hover/press の手触りは recipe 側の CSS transition
// (translateY + shadow) へ一本化し、Motion は要素の出入り (stagger, #875) だけを
// 担当する。stagger アイテムの入場 (`variants.staggerItem`) は変更しない。
const MotionCard = chakra(motion.button, selectableCardRecipe, {
  forwardProps: ["variants"],
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
          alignItems="center"
          justifyContent="center"
          flex="0 1 240px"
          minW="220px"
          maxW="280px"
          minH="118px"
          bg="transparent"
          border="1px dashed"
          borderColor="app.borderStrong"
          color="app.textMuted"
          _hover={{ bg: "app.hover", color: "app.text", borderColor: "app.accent" }}
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
  const inert = disabled || connecting;
  return (
    <MotionCard
      type="button"
      variants={variants.staggerItem}
      onClick={onConnect}
      disabled={inert}
      aria-label={p.name}
      aria-describedby={descId}
      aria-busy={connecting || undefined}
      flex="0 1 240px"
      minW="220px"
      maxW="280px"
      minH="118px"
      // 本番は常に危険色のスパインで際立たせる (サイドバーのワークスペース・
      // スパイン #791 と同じ色決定を共有)。非本番はプロファイル色/アクセント。
      // ホバーで変わらない色なので、recipe の `_hover` (borderColor/shadow/
      // transform を担当) と衝突しない単一の style prop で足りる。
      borderLeft="3px solid"
      borderLeftColor={workspaceSpineColor(p)}
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
