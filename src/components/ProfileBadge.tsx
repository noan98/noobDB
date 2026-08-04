import { chakra, type HTMLChakraProps } from "@chakra-ui/react";
import { AnimatePresence, motion } from "motion/react";
import { useT } from "../i18n";
import { Icon, ICON_SIZES } from "./Icon";
import { semanticColorToken } from "../semanticColors";
import { transitions, variants } from "../motion";
import { TreeBadge } from "./tree";
import { Tooltip } from "./Tooltip";
import {
  groupAvatarColor,
  groupAvatarForeground,
  groupInitials,
  normalizeChipColor,
  profileBadgeKinds,
} from "../profileIdentity";

/**
 * 接続プロファイルのビジュアルアイデンティティ (カラーチップ・グループアバター・
 * 本番/読取専用バッジ) を単一のデザイン言語で描画する共有部品 (#663)。
 *
 * 色/イニシャルの決定ロジックは `profileIdentity.ts` に集約済みで、ここは
 * それを描画するだけの薄い層。`ConnectionList` / `TitleBar` / 本番接続確認
 * ダイアログ (`App.tsx`) がここを参照し、実装を二重に持たない。
 *
 * バッジの配色は `semanticColors.ts` (#664) の意味色トークンか、既存の
 * danger ベタ塗りトークン (`app.dangerBg` / `app.dangerFg`。ボタン等の破壊的
 * アクションと同じ、常に警戒色を保つ塗り) を参照し、色を独自に持たない。
 */

// バッジ/チップの出現・入替を Motion のクロスフェードで表現する
// (`MultiStateBadge` と同じパターン)。`prefers-reduced-motion` はルートの
// `<MotionConfig reducedMotion="user">` により自動的に即時化される。
const MotionSpan = chakra(motion.span, {}, { forwardProps: ["transition", "initial", "animate", "exit"] });

export interface ProfileBadgeStyleProps {
  /** ConnectionList のような密なツリー行では既定サイズ、TitleBar 等の限られた
   *  横幅ではより小さいサイズを使う。 */
  compact?: boolean;
}

/** 本番プロファイルを示すバッジ。danger のベタ塗り (常に警戒色) で最も目立たせる。 */
export function ProductionBadge({
  compact,
  ...rest
}: ProfileBadgeStyleProps & HTMLChakraProps<"span">) {
  const t = useT();
  return (
    <MotionSpan
      key="production-badge"
      initial={variants.fadeScale.initial}
      animate={variants.fadeScale.animate}
      exit={variants.fadeScale.exit}
      transition={transitions.crossfade}
      display="inline-flex"
    >
      {/* TreeBadge は非対話の <span> でそもそもフォーカスを持てないため、
          native title のままではキーボードで一切読めなかった。`focusableWrapper`
          で読み取り専用のタブストップを与える (#814/#884)。 */}
      <Tooltip label={t("listProductionTitle")} focusableWrapper>
        <TreeBadge
          display="inline-flex"
          alignItems="center"
          gap="1"
          bg="app.dangerBg"
          color="app.dangerFg"
          borderColor="app.dangerBg"
          fontSize={compact ? "2xs" : "xs"}
          fontWeight={700}
          px={compact ? "1.5" : "2"}
          py={compact ? "1px" : "0.5"}
          {...rest}
        >
          <Icon name="warning" size={ICON_SIZES.sm} />
          {t("listProduction")}
        </TreeBadge>
      </Tooltip>
    </MotionSpan>
  );
}

/** 読み取り専用プロファイルを示すバッジ。info の淡色 (subtle/border/text) で控えめに示す。 */
export function ReadOnlyBadge({
  compact,
  ...rest
}: ProfileBadgeStyleProps & HTMLChakraProps<"span">) {
  const t = useT();
  return (
    <MotionSpan
      key="readonly-badge"
      initial={variants.fadeScale.initial}
      animate={variants.fadeScale.animate}
      exit={variants.fadeScale.exit}
      transition={transitions.crossfade}
      display="inline-flex"
    >
      <Tooltip label={t("listReadOnlyTitle")} focusableWrapper>
        <TreeBadge
          display="inline-flex"
          alignItems="center"
          gap="1"
          bg={semanticColorToken("info", "subtle")}
          color={semanticColorToken("info", "text")}
          borderColor={semanticColorToken("info", "border")}
          fontSize={compact ? "2xs" : "xs"}
          fontWeight={700}
          px={compact ? "1.5" : "2"}
          py={compact ? "1px" : "0.5"}
          {...rest}
        >
          <Icon name="key" size={ICON_SIZES.sm} />
          {t("listReadOnly")}
        </TreeBadge>
      </Tooltip>
    </MotionSpan>
  );
}

/**
 * サンドボックス (壊せる砂場、#747) のセッションを示すバッジ。専用色 (violet 系。
 * `titleBarContext.ts` の `SANDBOX_BAND_COLOR` と同じ値) で常時明示し、「このタブは
 * 接続先へ一切影響しないローカルコピーである」ことをひと目で伝える。production/
 * read-only とは意味論的に独立 (両立しうる) なため `ProfileBadges` には含めず、
 * 呼び出し側 (`ConnectionList` / `TitleBar`) が個別に描画する。
 */
export function SandboxBadge({
  compact,
  ...rest
}: ProfileBadgeStyleProps & HTMLChakraProps<"span">) {
  const t = useT();
  return (
    <MotionSpan
      key="sandbox-badge"
      initial={variants.fadeScale.initial}
      animate={variants.fadeScale.animate}
      exit={variants.fadeScale.exit}
      transition={transitions.crossfade}
      display="inline-flex"
    >
      <Tooltip label={t("sandboxBadgeTitle")} focusableWrapper>
        <TreeBadge
          display="inline-flex"
          alignItems="center"
          gap="1"
          bg="rgba(139, 92, 246, 0.16)"
          color="#8b5cf6"
          borderColor="rgba(139, 92, 246, 0.5)"
          fontSize={compact ? "2xs" : "xs"}
          fontWeight={700}
          px={compact ? "1.5" : "2"}
          py={compact ? "1px" : "0.5"}
          {...rest}
        >
          <Icon name="flask" size={ICON_SIZES.sm} />
          {t("sandboxBadge")}
        </TreeBadge>
      </Tooltip>
    </MotionSpan>
  );
}

/**
 * `is_production` / `read_only` の 2 フラグから該当バッジをまとめて描画する。
 * どちらも false なら何も描画しない。切替時 (プロファイル変更でフラグが変わる)
 * は `AnimatePresence` でクロスフェードする。
 */
export function ProfileBadges({
  isProduction,
  readOnly,
  sandbox,
  compact,
  gap = "1",
}: {
  isProduction: boolean;
  readOnly: boolean;
  /** サンドボックスのセッション/プロファイルなら true (#747)。 */
  sandbox?: boolean;
  compact?: boolean;
  gap?: string;
}) {
  const kinds = profileBadgeKinds({ is_production: isProduction, read_only: readOnly });
  if (kinds.length === 0 && !sandbox) return null;
  return (
    <chakra.span display="inline-flex" alignItems="center" gap={gap}>
      <AnimatePresence initial={false}>
        {sandbox && <SandboxBadge compact={compact} />}
        {kinds.includes("production") && <ProductionBadge compact={compact} />}
        {kinds.includes("readOnly") && <ReadOnlyBadge compact={compact} />}
      </AnimatePresence>
    </chakra.span>
  );
}

/**
 * プロファイルカラーの丸チップ。`TitleBar` の接続コンテキストと本番接続確認
 * ダイアログ (`App.tsx`) で共有する。色が未設定のときはワークスペースアクセント
 * (`--ws-accent`) へフォールバックする — `titleBarContext.ts` の
 * `connectionBandColor` と同じフォールバック方針。
 */
export function ProfileColorChip({
  color,
  size = 10,
  title,
}: {
  color?: string | null;
  size?: number;
  title?: string;
}) {
  const normalized = normalizeChipColor(color);
  const chip = (
    <MotionSpan
      key={`chip-${normalized ?? "default"}`}
      aria-hidden
      initial={variants.fadeScale.initial}
      animate={variants.fadeScale.animate}
      transition={transitions.crossfade}
      display="inline-block"
      boxSize={`${size}px`}
      borderRadius="full"
      flexShrink={0}
      borderWidth="1px"
      borderStyle="solid"
      borderColor="app.borderStrong"
      style={{ background: normalized ?? "var(--ws-accent, var(--accent))" }}
    />
  );
  // このチップは `aria-hidden` の装飾要素なので、フォーカス可能にする
  // `focusableWrapper` はあえて使わない (aria-hidden な要素にフォーカスを
  // 持たせるのは a11y 上の逆効果)。マウスホバー時の表示速度・テーマ追従のみ
  // 底上げする。
  if (!title) return chip;
  return <Tooltip label={title}>{chip}</Tooltip>;
}

/**
 * グループ名のイニシャルアバター。`ConnectionList` のグループ見出しで使う。
 * イニシャルが取れない (空文字) グループ名では何も描画しない。
 */
export function GroupAvatar({ name, size = 18 }: { name: string; size?: number }) {
  const initials = groupInitials(name);
  if (!initials) return null;
  const bg = groupAvatarColor(name);
  const fg = groupAvatarForeground(name);
  return (
    <chakra.span
      aria-hidden
      display="inline-flex"
      alignItems="center"
      justifyContent="center"
      boxSize={`${size}px`}
      borderRadius="sm"
      flexShrink={0}
      fontSize="9px"
      fontWeight={700}
      lineHeight="1"
      textTransform="none"
      style={{ background: bg, color: fg }}
    >
      {initials}
    </chakra.span>
  );
}
