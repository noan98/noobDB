import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Box, chakra, VisuallyHidden } from "@chakra-ui/react";
import { useT } from "../i18n";
import { Icon, ICON_SIZES } from "./Icon";
import { Tooltip } from "./Tooltip";
import { springs, staggerContainer, transitions, variants } from "../motion";
import { semanticColorToken } from "../semanticColors";
import { useFocusTrap, useReturnFocus } from "../keyboardNav";
import {
  ACTIVITY_LIMIT,
  ACTIVITY_SEVERITIES,
  ACTIVITY_SEVERITY_ROLE,
  clearActivity,
  countBySeverity,
  countUnread,
  filterActivity,
  markActivityRead,
  relativeActivityTime,
  useActivityLog,
  type ActivityEntry,
  type ActivitySeverity,
} from "../activityLog";
import type { I18nKey } from "../i18n";

/**
 * アプリ内アクティビティ (通知センター、#912)。
 *
 * トーストは自動で消えるため、見逃した重要イベント (インポート結果・同期の成否・
 * 実行計画ウォッチのアラートなど) を後から確認する手段が無かった。ここでは
 * `activityLog` ストアに溜まった通知を、タイトルバーのベルアイコンから時系列で
 * 再閲覧できるようにする。
 *
 * - 重大度の色は `semanticColors.ts` の意味色トークンを参照し、トースト/バッジと
 *   共有する (状態色を二重管理しない)。
 * - 出入りは `motion.ts` の共有プリセットで、reduced-motion はルートの
 *   `MotionConfig` が自動で抑制する。
 * - **`aria-live` は付けない**: 通知そのものはトースト側 (`role="region"
 *   aria-live="polite"`) が既に読み上げており、ここは「後から開いて読む」ための
 *   静的な一覧。同じ文言を二重に読み上げないための意図的な設計。パネル自体は
 *   `role="dialog"` + フォーカストラップで、キーボードだけで開閉・巡回できる。
 *
 * **登場コレオグラフィ (#984)**: 一覧は `motion.ts` の `staggerContainer` /
 * `variants.staggerItem` (`WelcomeView` / `ProfileCardGrid` と同じパターン) で
 * 順次フェードインする。フィルタチップの切替は `<ul>` の `key` を絞り込み条件で
 * 差し替えることで再マウントし、瞬間ハードスワップではなく再ステガーで滑らかに
 * 差し替える。200 件までローテーションする一覧を全件順番に遅延させると体感が
 * 重くなるため、先頭 `STAGGER_CAP` 件だけ協調出現させ、残りは即時表示する
 * (`useReducedMotion()` が true のときは `staggerContainer` 自体が同時表示へ
 * フォールバックする)。未読バッジは `AnimatePresence` + `variants.fadeScale` /
 * `springs.snappy` で pop / dismiss する — こちらは stagger ではない単発の
 * enter/exit なので `MotionConfig` が reduced-motion 時に自動で即時化する
 * (追加の分岐は不要)。いずれも `role="dialog"` + フォーカストラップ + `aria-live`
 * を付けない既存設計は変えない (バッジは従来どおり `aria-hidden`)。
 */

/**
 * stagger を適用する先頭件数の上限 (#984)。`ACTIVITY_LIMIT` (200) 件を全件
 * 順番に遅延させると体感遅延になるため、先頭のみ協調出現させ、残りは
 * (`variants` を渡さないことで) 即時表示にする。
 */
const STAGGER_CAP = 20;

// motion 用 props は Chakra のスタイルプロップに飲まれないよう forwardProps で
// 素通しする (`WelcomeView` / `ProfileCardGrid` と同じパターン)。
const MotionUl = chakra(motion.ul, {}, { forwardProps: ["variants", "initial", "animate"] });
const MotionLi = chakra(motion.li, {}, { forwardProps: ["variants"] });
const MotionBadge = chakra(motion.span, {}, {
  forwardProps: ["variants", "initial", "animate", "exit", "transition"],
});

/** 重大度ごとのアイコン (色は意味色トークン)。 */
const SEVERITY_ICON: Record<ActivitySeverity, "check" | "warning" | "help"> = {
  success: "check",
  warning: "warning",
  error: "warning",
  info: "help",
};

/** 重大度ラベルの i18n キー (フィルタチップと読み上げに使う)。 */
const SEVERITY_LABEL: Record<ActivitySeverity, I18nKey> = {
  success: "activitySeveritySuccess",
  warning: "activitySeverityWarning",
  error: "activitySeverityError",
  info: "activitySeverityInfo",
};

/** 相対時刻を i18n 文字列へ。1 分未満は「たった今」。 */
function formatRelative(t: ReturnType<typeof useT>, at: number, now: number): string {
  const rel = relativeActivityTime(at, now);
  switch (rel.unit) {
    case "minutes":
      return t("activityTimeMinutes", { n: rel.value });
    case "hours":
      return t("activityTimeHours", { n: rel.value });
    case "days":
      return t("activityTimeDays", { n: rel.value });
    case "now":
    default:
      return t("activityTimeNow");
  }
}

function ActivityRow({
  entry,
  now,
  animated,
}: {
  entry: ActivityEntry;
  now: number;
  /** false のときは stagger に参加させず即時表示する (#984、`STAGGER_CAP` 超過分)。 */
  animated: boolean;
}) {
  const t = useT();
  const role = ACTIVITY_SEVERITY_ROLE[entry.severity];
  const absolute = new Date(entry.at).toLocaleString();
  return (
    <MotionLi
      variants={animated ? variants.staggerItem : undefined}
      display="flex"
      alignItems="flex-start"
      gap="2"
      px="2.5"
      py="2"
      borderBottom="1px solid"
      borderColor="app.borderSubtle"
      _last={{ borderBottom: "none" }}
    >
      <chakra.span
        display="inline-flex"
        flexShrink={0}
        mt="2px"
        color={semanticColorToken(role, "text")}
        aria-hidden
      >
        <Icon name={SEVERITY_ICON[entry.severity]} size={ICON_SIZES.sm} />
      </chakra.span>
      <Box flex="1" minW={0} display="flex" flexDirection="column" gap="0.5">
        <chakra.span fontSize="var(--text-sm)" color="app.text" lineHeight="1.4" wordBreak="break-word">
          {entry.message}
        </chakra.span>
        <chakra.span fontSize="var(--text-xs)" color="app.textMuted">
          {/* 重大度は色だけに頼らずテキストでも示す (CB 配慮)。絶対時刻は
              ツールチップではなく title 相当の情報として同じ行に持たせず、
              相対時刻の隣に読み上げ用の文言としてだけ添える。 */}
          <VisuallyHidden>{t(SEVERITY_LABEL[entry.severity])}: </VisuallyHidden>
          {formatRelative(t, entry.at, now)}
          <VisuallyHidden> ({absolute})</VisuallyHidden>
        </chakra.span>
      </Box>
    </MotionLi>
  );
}

/** フィルタチップ 1 個 (「すべて」+ 重大度ごと)。 */
function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <chakra.button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      display="inline-flex"
      alignItems="center"
      gap="1"
      px="2"
      py="0.5"
      fontSize="var(--text-xs)"
      fontWeight={600}
      borderRadius="pill"
      border="1px solid"
      borderColor={active ? "app.accent" : "app.border"}
      bg={active ? "app.hover" : "transparent"}
      color={active ? "app.text" : "app.textMuted"}
      cursor="pointer"
      whiteSpace="nowrap"
      _hover={{ bg: "app.hover", color: "app.text" }}
    >
      {label}
      <chakra.span color="app.textMuted" fontWeight={500}>
        {count}
      </chakra.span>
    </chakra.button>
  );
}

function ActivityPanel({ anchor, onClose }: { anchor: DOMRect; onClose: () => void }) {
  const t = useT();
  const { entries } = useActivityLog();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [severity, setSeverity] = useState<ActivitySeverity | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // 相対時刻は開いた時点で固定する (開きっぱなしで秒刻みに再描画しない)。
  const [now] = useState(() => Date.now());
  // 一覧の stagger 出現 (#984)。MotionConfig の設定も反映される。
  const reduced = useReducedMotion() ?? false;

  useFocusTrap(panelRef, onClose);
  useReturnFocus();

  // 開いたらパネル自身へフォーカスを移す。フォーカストラップ (Esc / Tab 巡回) は
  // コンテナ上の keydown で成り立つため、ここへ入れないとキーボードだけで
  // 操作・離脱できない。閉じると `useReturnFocus` がベルへ戻す。
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const counts = useMemo(() => countBySeverity(entries), [entries]);
  const shown = useMemo(() => filterActivity(entries, severity), [entries, severity]);

  // アンカー (ベルボタン) の直下にビューポート内へクランプして配置する
  // (`ColumnStatsMenu` / `ColumnFilterMenu` と同じ方式)。
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 6;
    let left = anchor.right - width;
    if (left < margin) left = anchor.left;
    left = Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - width - margin));
    let top = anchor.bottom + 4;
    if (top + height + margin > window.innerHeight) top = Math.max(margin, anchor.top - height - 4);
    setPos({ left, top });
  }, [anchor, shown.length]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return createPortal(
    <motion.div
      variants={variants.dialog}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={transitions.enter}
      style={{
        position: "fixed",
        left: pos?.left ?? anchor.left,
        top: pos?.top ?? anchor.bottom,
        visibility: pos ? "visible" : "hidden",
        // レイヤリングは App.css の --z-* が正 (theme.ts の zIndex トークンと同じ値)。
        // motion.div は素の div なので CSS 変数を直接参照する。
        zIndex: "var(--z-popover)",
      }}
    >
      <Box
        ref={panelRef}
        role="dialog"
        aria-label={t("activityCenterTitle")}
        tabIndex={-1}
        outline="none"
        width="min(360px, calc(100vw - 2 * var(--space-4)))"
        display="flex"
        flexDirection="column"
        bg="app.surface"
        border="1px solid"
        borderColor="app.borderStrong"
        borderRadius="md"
        boxShadow="md"
        overflow="hidden"
      >
        <Box
          display="flex"
          alignItems="center"
          gap="2"
          px="2.5"
          py="2"
          borderBottom="1px solid"
          borderColor="app.border"
        >
          <chakra.h2 flex="1" minW={0} fontSize="var(--text-sm)" fontWeight={600} color="app.text">
            {t("activityCenterTitle")}
          </chakra.h2>
          <chakra.button
            type="button"
            onClick={clearActivity}
            disabled={entries.length === 0}
            fontSize="var(--text-xs)"
            px="1.5"
            py="0.5"
            borderRadius="sm"
            border="1px solid"
            borderColor="app.border"
            bg="transparent"
            color="app.textMuted"
            cursor="pointer"
            _hover={{ bg: "app.hover", color: "app.text" }}
            _disabled={{ opacity: 0.5, cursor: "not-allowed", _hover: { bg: "transparent" } }}
          >
            {t("activityClear")}
          </chakra.button>
          <chakra.button
            type="button"
            onClick={onClose}
            aria-label={t("activityClose")}
            display="inline-flex"
            alignItems="center"
            justifyContent="center"
            p="0.5"
            color="app.textMuted"
            bg="transparent"
            border="none"
            borderRadius="sm"
            cursor="pointer"
            _hover={{ bg: "app.hover", color: "app.text" }}
          >
            <Icon name="close" size={ICON_SIZES.sm} />
          </chakra.button>
        </Box>

        <Box
          display="flex"
          flexWrap="wrap"
          gap="1"
          px="2.5"
          py="1.5"
          borderBottom="1px solid"
          borderColor="app.borderSubtle"
          role="group"
          aria-label={t("activityFilterAria")}
        >
          <FilterChip
            label={t("activityFilterAll")}
            count={entries.length}
            active={severity === null}
            onClick={() => setSeverity(null)}
          />
          {ACTIVITY_SEVERITIES.map((s) => (
            <FilterChip
              key={s}
              label={t(SEVERITY_LABEL[s])}
              count={counts[s]}
              active={severity === s}
              onClick={() => setSeverity(severity === s ? null : s)}
            />
          ))}
        </Box>

        {shown.length === 0 ? (
          <chakra.p px="2.5" py="4" fontSize="var(--text-sm)" color="app.textMuted" textAlign="center">
            {entries.length === 0 ? t("activityEmpty") : t("activityNoMatches")}
          </chakra.p>
        ) : (
          <MotionUl
            // フィルタ変更時は key を差し替えて再マウントし、瞬間ハードスワップ
            // ではなく stagger を再生させる (#984)。
            key={severity ?? "__all__"}
            variants={staggerContainer(reduced)}
            initial="initial"
            animate="animate"
            listStyleType="none"
            m={0}
            p={0}
            maxHeight="320px"
            overflowY="auto"
            aria-label={t("activityListAria")}
          >
            {shown.map((e, i) => (
              <ActivityRow key={e.id} entry={e} now={now} animated={i < STAGGER_CAP} />
            ))}
          </MotionUl>
        )}

        <chakra.p
          px="2.5"
          py="1.5"
          fontSize="var(--text-xs)"
          color="app.textMuted"
          borderTop="1px solid"
          borderColor="app.borderSubtle"
        >
          {t("activityFooterNote", { limit: ACTIVITY_LIMIT })}
        </chakra.p>
      </Box>
    </motion.div>,
    document.body,
  );
}

/**
 * タイトルバーに置くベルアイコン + 未読バッジ。押すとアクティビティ一覧を開き、
 * 開いた時点で既読にする (未読バッジが消える)。
 */
export function ActivityCenter() {
  const t = useT();
  const { entries, lastReadId } = useActivityLog();
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const unread = countUnread(entries, lastReadId);
  const label = unread > 0 ? t("activityOpenUnread", { count: unread }) : t("activityOpen");

  return (
    <>
      <Tooltip label={label}>
        <chakra.button
          type="button"
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={anchor !== null}
          onClick={(e) => {
            if (anchor) {
              setAnchor(null);
              return;
            }
            setAnchor(e.currentTarget.getBoundingClientRect());
            markActivityRead();
          }}
          position="relative"
          width="38px"
          display="inline-flex"
          alignItems="center"
          justifyContent="center"
          p={0}
          border="none"
          borderRadius={0}
          bg="transparent"
          color={anchor ? "app.text" : "app.textSecondary"}
          cursor="pointer"
          transitionProperty="background, color"
          transitionDuration="var(--dur-fast)"
          transitionTimingFunction="var(--ease)"
          _hover={{ bg: "app.hover", color: "app.text" }}
        >
          <Icon name="bell" size={ICON_SIZES.md} />
          <AnimatePresence>
            {unread > 0 && (
              // 未読インジケータ。件数は 9+ で頭打ちにしてタイトルバーの高さを
              // 保つ。出入りは pop/dismiss (#984)。単発の enter/exit なので
              // reduced-motion は `MotionConfig` が自動で即時化する
              // (stagger と違い明示的な分岐は不要)。
              <MotionBadge
                key="badge"
                variants={variants.fadeScale}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={springs.snappy}
                position="absolute"
                top="7px"
                right="7px"
                minWidth="14px"
                height="14px"
                px="3px"
                display="inline-flex"
                alignItems="center"
                justifyContent="center"
                fontSize="9px"
                fontWeight={700}
                lineHeight={1}
                borderRadius="7px"
                bg={semanticColorToken("danger", "solid")}
                color="#fff"
                aria-hidden
              >
                {unread > 9 ? "9+" : unread}
              </MotionBadge>
            )}
          </AnimatePresence>
        </chakra.button>
      </Tooltip>
      <AnimatePresence>
        {anchor && <ActivityPanel anchor={anchor} onClose={() => setAnchor(null)} />}
      </AnimatePresence>
    </>
  );
}
