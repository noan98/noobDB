import { useId, useMemo, useState } from "react";
import { chakra, Flex, Text } from "@chakra-ui/react";
import { motion, useReducedMotion } from "motion/react";
import type { ConnectionProfile } from "../api/tauri";
import { useT } from "../i18n";
import { staggerContainer, variants } from "../motion";
import { driverColor, driverIconName, workspaceSpineColor } from "../profileIdentity";
import {
  filterProfileCards,
  PROFILE_SEARCH_MIN,
  profileGroupNames,
  UNGROUPED_FILTER,
} from "../profileSearch";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";
import {
  contextMenuTriggerFromRect,
  isContextMenuOpenKey,
  pickContextMenuOpenKeys,
  type ContextMenuTriggerEvent,
} from "./contextMenuKeyboard";
import { useConfirm } from "./ConfirmDialog";
import { Heading, Input, SelectableCard } from "./ui";
import { Icon, ICON_SIZES, type IconName } from "./Icon";
import { GroupAvatar, ProfileBadges, ProfileColorChip } from "./ProfileBadge";
import { Spinner } from "./Spinner";

// Chakra でラップした motion 要素 (WelcomeView / EmptyState と同じパターン)。
// motion 用 props は Chakra のスタイルプロップに飲まれないよう forwardProps で
// 素通しする。
const MotionFlex = chakra(
  motion.div,
  {},
  {
    forwardProps: ["transition", "initial", "animate", "variants"],
  },
);
// stagger 入場 (#875) だけを担当する薄いラッパー。カードの見た目・ホバー/押下は
// `ui.tsx` の `SelectableCard` (`selectableCardRecipe`、#1161) にそのまま任せる。
//
// `SelectableCard` 自身を `motion.button` 化 (`chakra(motion.button, recipe)`) して
// `variants={variants.staggerItem}` を渡すと、入場アニメ完了後に Motion が
// `transform: none` をインライン style に残してしまい、それが recipe の
// `_hover`/`&:active` の `transform: translateY(...)` (CSS) より詳細度で勝って
// ホバーリフト/押下フィードバックが一切効かなくなる不具合があった (実 Chromium で
// 確認、#1161 フォローアップ)。stagger の入場 (opacity/y) を担う要素と、ホバー/
// 押下の transform を担う要素 (`SelectableCard` = 素の button、CSS transition の
// み) を分離することで、Motion のインライン transform が CSS の transform と
// 衝突しないようにする。レイアウト用の flex/minW/maxW/minH はこのラッパー側に
// 置き、`base.display: "flex"` によりラッパー自身を flex コンテナ化することで、
// 中の `SelectableCard` (`flex="1"`) がラッパーの幅いっぱい・高さいっぱい
// (align-items の既定 stretch) に広がる。
const MotionCardWrap = chakra(
  motion.div,
  { base: { display: "flex" } },
  {
    forwardProps: ["variants"],
  },
);

interface Props {
  /** 表示するプロファイル (App の並び順そのまま)。 */
  profiles: ConnectionProfile[];
  /** 接続試行中のプロファイル id (カードにスピナーを出し、多重クリックを防ぐ)。 */
  connectingId: string | null;
  onConnect: (profile: ConnectionProfile) => void;
  /** 「新しい接続」カード — 空の接続フォームを開く。 */
  onCreate: () => void;
  /** カードの右クリックメニュー (#1630)。未指定の操作は項目を出さない。 */
  onEdit?: (profile: ConnectionProfile) => void;
  onDuplicate?: (profile: ConnectionProfile) => void;
  onDelete?: (profile: ConnectionProfile) => void;
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
export function ProfileCardGrid({
  profiles,
  connectingId,
  onConnect,
  onCreate,
  onEdit,
  onDuplicate,
  onDelete,
}: Props) {
  const t = useT();
  const reduced = useReducedMotion() ?? false;
  const { confirm, dialog: confirmDialog } = useConfirm();
  // 件数が多いときの検索 (名前・ホスト・グループ) とグループのチップ (#1630)。
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuEntry[] } | null>(null);
  const showFilter = profiles.length >= PROFILE_SEARCH_MIN;
  const groups = useMemo(() => profileGroupNames(profiles), [profiles]);
  const hasUngrouped = useMemo(() => profiles.some((p) => !p.group), [profiles]);
  // 絞り込みが効くのは検索欄を出している間だけ (件数が減って欄が消えたとき古い絞り込みで空にしない)。
  const visible = useMemo(
    () => (showFilter ? filterProfileCards(profiles, query, group) : profiles),
    [showFilter, profiles, query, group],
  );
  const filtering = showFilter && (query.trim() !== "" || group !== null);

  const openMenu = (e: ContextMenuTriggerEvent, p: ConnectionProfile) => {
    if (!onEdit && !onDuplicate && !onDelete) return;
    e.preventDefault();
    e.stopPropagation();
    const items: ContextMenuEntry[] = [];
    items.push({ label: t("contextMenuConnect"), onSelect: () => onConnect(p) });
    if (onEdit) items.push({ label: t("contextMenuEdit"), onSelect: () => onEdit(p) });
    if (onDuplicate) items.push({ label: t("contextMenuDuplicate"), onSelect: () => onDuplicate(p) });
    if (onDelete) {
      items.push({
        label: t("contextMenuDelete"),
        danger: true,
        onSelect: () => {
          void confirm({
            title: t("listDeleteConfirmTitle"),
            message: t("listDeleteConfirm", { name: p.name }),
            confirmLabel: t("contextMenuDelete"),
            tone: "danger",
          }).then((ok) => {
            if (ok) onDelete(p);
          });
        },
      });
    }
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  return (
    <Flex
      direction="column"
      flex="1"
      overflow="auto"
      align="center"
      px="6"
      py="8"
      gap="5"
      // 起動直後の第一印象面に敷く、ごく控えめなブランドウォッシュ (#1163)。値は App.css の
      // `--hero-wash` が単一ソース。重ね用の要素を置くと本文やカードの上に色が被るため、
      // ルート自身の背景画像として敷く (内容は常にその手前に描かれる)。
      css={{ backgroundImage: "var(--hero-wash)", backgroundRepeat: "no-repeat" }}
    >
      <Flex direction="column" align="center" gap="1.5" textAlign="center">
        <Heading role="display">{t("profileCardsTitle")}</Heading>
        {/* 見出し下のブランドグラデーションの短い罫線。WelcomeView と対称 (#1891、hc-* では none) */}
        <chakra.div
          aria-hidden
          w="48px"
          h="3px"
          rounded="pill"
          css={{ background: "var(--hero-rule)", display: "var(--hero-rule-display)" }}
        />
        <Text textStyle="body" color="app.textMuted" maxW="52ch">
          {t("profileCardsSubtitle")}
        </Text>
      </Flex>
      {showFilter && (
        <Flex direction="column" align="center" gap="2" w="100%" maxW="960px">
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("profileCardsSearchPlaceholder")}
            aria-label={t("profileCardsSearchAria")}
            data-testid="profile-cards-search"
            maxW="420px"
          />
          {groups.length > 0 && (
            <Flex
              gap="1.5"
              wrap="wrap"
              justify="center"
              role="group"
              aria-label={t("profileCardsGroupFilterAria")}
            >
              <GroupChip active={group === null} onClick={() => setGroup(null)}>
                {t("profileCardsGroupAll")}
              </GroupChip>
              {groups.map((g) => (
                <GroupChip key={g} active={group === g} onClick={() => setGroup(group === g ? null : g)}>
                  {g}
                </GroupChip>
              ))}
              {hasUngrouped && (
                <GroupChip
                  active={group === UNGROUPED_FILTER}
                  onClick={() => setGroup(group === UNGROUPED_FILTER ? null : UNGROUPED_FILTER)}
                >
                  {t("profileCardsGroupNone")}
                </GroupChip>
              )}
            </Flex>
          )}
          {filtering && (
            <Text textStyle="caption" role="status">
              {visible.length === 0
                ? t("profileCardsNoMatches")
                : t("profileCardsMatchCount", { shown: visible.length, total: profiles.length })}
            </Text>
          )}
        </Flex>
      )}
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
        {visible.map((p) => {
          const connecting = connectingId === p.id;
          return (
            <ProfileCard
              key={p.id}
              profile={p}
              connecting={connecting}
              disabled={connectingId != null && !connecting}
              onConnect={() => onConnect(p)}
              onMenu={openMenu}
            />
          );
        })}
        <MotionCardWrap
          variants={variants.staggerItem}
          flex="0 1 240px"
          minW="220px"
          maxW="280px"
          minH="118px"
        >
          <SelectableCard
            type="button"
            onClick={onCreate}
            flex="1"
            alignItems="center"
            justifyContent="center"
            bg="transparent"
            border="1px dashed"
            borderColor="app.borderStrong"
            color="app.textMuted"
            _hover={{ bg: "app.hover", color: "app.text", borderColor: "app.accent" }}
          >
            <Icon name="plus" size={ICON_SIZES.lg} />
            <Text textStyle="subheading" color="inherit">
              {t("profileCardsNew")}
            </Text>
          </SelectableCard>
        </MotionCardWrap>
      </MotionFlex>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {confirmDialog}
    </Flex>
  );
}

/** グループ絞り込みのチップ (トグル)。 */
function GroupChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <chakra.button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      px="2.5"
      py="0.5"
      fontSize="xs"
      borderRadius="pill"
      borderWidth="1px"
      borderColor={active ? "app.accent" : "app.border"}
      bg={active ? "app.accent" : "transparent"}
      color={active ? "app.accentText" : "app.textMuted"}
      cursor="pointer"
      _hover={active ? undefined : { bg: "app.hover", color: "app.text" }}
    >
      {children}
    </chakra.button>
  );
}

function ProfileCard({
  profile: p,
  connecting,
  disabled,
  onConnect,
  onMenu,
}: {
  profile: ConnectionProfile;
  connecting: boolean;
  disabled: boolean;
  onConnect: () => void;
  onMenu: (e: ContextMenuTriggerEvent, profile: ConnectionProfile) => void;
}) {
  const t = useT();
  const descId = useId();
  const driverIcon: IconName = driverIconName(p.driver) ?? "server";
  const endpoint = endpointSummary(p);
  const inert = disabled || connecting;
  // バッジは視覚情報なので、読み上げ用に状態込みの名前を組み立てる (#1529)。
  const cardLabel = [
    p.name,
    p.is_production ? t("profileCardStatusProduction") : null,
    p.read_only ? t("profileCardStatusReadOnly") : null,
  ]
    .filter((x): x is string => x !== null)
    .join(", ");
  return (
    <MotionCardWrap variants={variants.staggerItem} flex="0 1 240px" minW="220px" maxW="280px" minH="118px">
      <SelectableCard
        type="button"
        onClick={onConnect}
        onContextMenu={(e) => onMenu(e, p)}
        onKeyDown={(e) => {
          if (isContextMenuOpenKey(pickContextMenuOpenKeys(e))) {
            onMenu(contextMenuTriggerFromRect(e.currentTarget.getBoundingClientRect()), p);
          }
        }}
        disabled={inert}
        aria-label={cardLabel}
        aria-describedby={descId}
        aria-busy={connecting || undefined}
        flex="1"
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
            textStyle="subheading"
            flex="1"
            minW={0}
            overflow="hidden"
            textOverflow="ellipsis"
            whiteSpace="nowrap"
          >
            {p.name}
          </Text>
          <ProfileBadges isProduction={p.is_production} readOnly={p.read_only} compact focusable={false} />
        </Flex>
        <Flex align="center" gap="2" minW={0} color="app.textMuted">
          <chakra.span
            aria-hidden
            display="inline-flex"
            flexShrink={0}
            style={{ color: driverColor(p.driver) }}
          >
            {connecting ? <Spinner size={14} decorative /> : <Icon name={driverIcon} size={ICON_SIZES.md} />}
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
      </SelectableCard>
    </MotionCardWrap>
  );
}
