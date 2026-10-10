import { forwardRef, memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Box, chakra, Input } from "@chakra-ui/react";
import { AnimatePresence, motion, Reorder, useReducedMotion } from "motion/react";
import { useT } from "../i18n";
import { Icon, ICON_SIZES } from "./Icon";
import { transitions, variants } from "../motion";
import { moveTabBy } from "../tabReorder";
import { TAB_RENAME_MAX } from "../tabTitle";
import { Tooltip } from "./Tooltip";
import { labelWithShortcut } from "../shortcutLabel";
import { DropInsertionMarker } from "./DropInsertionMarker";
import { FlightIcon } from "./FlightIcon";
import { tabOpenFlightId, useTabOpenFlight } from "../sharedElement";

// キーボードフォーカスリング。単一ソースの `--focus-ring` (App.css) をそのまま使う。
const focusRing = "var(--focus-ring)";

// motion 要素を Chakra style props で装飾できるようにラップする。motion の
// `transition` プロップは Chakra のスタイルプロップ名と衝突するため明示的に転送する
// (それ以外の motion プロップ — layout / initial / animate / exit / layoutId — は
// スタイルプロップではないので既定で転送される)。CSS のホバー遷移は
// transitionProperty/Duration/TimingFunction の個別指定で表現する。
const MotionIndicator = chakra(motion.span, {}, { forwardProps: ["transition"] });

// タブのドラッグ並び替えには Motion の `Reorder.Item` を使う。既定の描画要素は
// `<li>` だが、タブは `role="tab"` の `<div>` 群にしたいので `as="div"` 固定の薄い
// ラッパを噛ませてから Chakra でスタイル付与する (Chakra の `as` は描画要素を
// 置き換えてしまい Reorder.Item のロジックを失うため、ここでは渡さない)。`value` /
// `drag*` / `whileDrag` などの motion プロップは Chakra のスタイルプロップ名ではない
// ので既定で転送され、`transition` のみ明示転送する。
const ReorderItemDiv = forwardRef<HTMLDivElement, React.ComponentProps<typeof Reorder.Item<string>>>(
  function ReorderItemDiv(props, ref) {
    return <Reorder.Item as="div" ref={ref} {...props} />;
  },
);
const MotionTab = chakra(ReorderItemDiv, {}, { forwardProps: ["transition"] });

export interface TabInfo {
  id: string;
  kind: "table" | "query" | "explain";
  title: string;
  /** ダブルクリックでインライン名前変更できるか (#1390)。query タブのみ true。 */
  renamable?: boolean;
  database?: string;
  table?: string;
  dirty?: boolean;
}

/**
 * タブ名のインライン編集欄 (#1390)。Enter で確定・Esc でキャンセル・フォーカスが外れたら確定。
 * 確定値の解釈 (空 = 自動命名へ戻す、同名は変更なし) は呼び出し側 (resolveRename)。
 * キー・ポインタ操作はタブ側のハンドラ (選択 / 削除 / 矢印移動 / ドラッグ開始) へ伝えない。
 */
function TabRenameInput({
  initial,
  ariaLabel,
  onCommit,
  onCancel,
}: {
  initial: string;
  ariaLabel: string;
  /** `viaKey`: Enter での確定 (フォーカスをタブへ戻してよい)。blur 確定では戻さない。 */
  onCommit: (value: string, viaKey: boolean) => void;
  /** `viaKey`: Esc でのキャンセル (フォーカスをタブへ戻してよい)。 */
  onCancel: (viaKey: boolean) => void;
}) {
  const [value, setValue] = useState(initial);
  // Enter/Esc の直後に続く blur で二重に確定しない。
  const settled = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // 右クリックメニューから開始したとき、メニューの片付け (フォーカスを持つ項目の除去) が
  // マウントと同じコミットで起きて autoFocus を打ち消すので、次フレームでフォーカスする。
  useEffect(() => {
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, []);
  const settle = (fn: () => void) => {
    if (settled.current) return;
    settled.current = true;
    fn();
  };
  return (
    <Input
      ref={inputRef}
      size="xs"
      value={value}
      maxLength={TAB_RENAME_MAX}
      aria-label={ariaLabel}
      w="150px"
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      // 編集せずに外れただけなら何も変えない (同名の確定は手動命名への昇格になるため、Enter のときだけ)。
      onBlur={() => settle(() => (value === initial ? onCancel(false) : onCommit(value, false)))}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // IME 変換中の Enter は確定にしない。
        if (e.nativeEvent.isComposing) {
          e.stopPropagation();
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          settle(() => onCommit(value, true));
        } else if (e.key === "Escape") {
          e.preventDefault();
          settle(() => onCancel(true));
        }
        e.stopPropagation();
      }}
    />
  );
}

interface Props {
  tabs: TabInfo[];
  activeTabId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  /** 「+」ボタンのツールチップに添える解決済みコンボ (#1278)。未指定ならキー表記なし。 */
  newTabCombo?: string;
  /**
   * Drag/keyboard reorder. Called with the full tab-id list in its new
   * order. Omitted disables reordering (tabs render statically).
   */
  onReorder?: (orderedIds: string[]) => void;
  disabled?: boolean;
  /** Right-click on a tab (viewport coords) — opens the move/close menu. */
  onTabContextMenu?: (id: string, x: number, y: number) => void;
  /**
   * インライン名前変更 (#1390)。`renamingId` のタブが編集欄になる。`onRenameStart` を
   * 省略するとダブルクリックでの開始を無効にする。
   */
  renamingId?: string | null;
  onRenameStart?: (id: string) => void;
  onRenameCommit?: (id: string, value: string) => void;
  onRenameCancel?: () => void;
  /**
   * Split control. With `splitMode === "split"` the button opens a second pane;
   * with `"close"` it closes this pane (merging its tabs into the other one).
   * Omitted entirely when splitting isn't available.
   */
  onSplit?: () => void;
  splitMode?: "split" | "close";
}

export const TabBar = memo(function TabBar({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onNew,
  newTabCombo,
  onReorder,
  disabled,
  onTabContextMenu,
  renamingId,
  onRenameStart,
  onRenameCommit,
  onRenameCancel,
  onSplit,
  splitMode = "split",
}: Props) {
  const t = useT();
  // サイドバー行から開いた新規テーブルタブのアイコンだけが、起点と layoutId を共有して morph する (#1415)。
  const openFlight = useTabOpenFlight();
  // opacity の補間は MotionConfig reducedMotion では止まらないので、個別に見て即時化する (#1322)。
  const reducedMotion = useReducedMotion() ?? false;
  // Scope the sliding indicator's layoutId to this TabBar so a split view's two
  // bars don't share one indicator (which would fly between panes on select).
  const indicatorId = `tab-active-indicator-${useId()}`;
  // Roving tabindex 用のタブ要素参照。配列ではなく Map にすることで、
  // タブの追加・削除でインデックスがずれても安全に参照できる。
  const tabRefs = useRef<Map<string, HTMLElement | null>>(new Map());

  // Drop-position indicator: the id of the tab whose leading edge shows the
  // insertion marker. Set while a tab is dragged (cleared on drag end) and
  // flashed briefly after a keyboard move so the landing spot is visible.
  const [dropIndicator, setDropIndicatorState] = useState<string | null>(null);
  const dropFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearDropFlash = useCallback(() => {
    if (dropFlashTimer.current) {
      clearTimeout(dropFlashTimer.current);
      dropFlashTimer.current = null;
    }
  }, []);
  // Keyboard reorder flashes the marker (no drag-end to clear it); drag sets it
  // persistently (dragEnd clears it) so pass `flash: false` there.
  const setDropIndicator = useCallback(
    (id: string | null, flash = true) => {
      clearDropFlash();
      setDropIndicatorState(id);
      if (id && flash) {
        dropFlashTimer.current = setTimeout(() => setDropIndicatorState(null), 700);
      }
    },
    [clearDropFlash],
  );
  useEffect(() => clearDropFlash, [clearDropFlash]);

  /** ArrowLeft/Right/Home/End でフォーカスとアクティブタブを同時に移動する。
   *  Enter/Space は role="tab" の div 要素では既定で click が走らないため、
   *  明示的に onSelect する。Delete はタブを閉じる (Mac の慣習に合わせ Backspace
   *  も同じ動作)。 */
  const handleTabKeyDown = useCallback(
    (currentId: string) => (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelect(currentId);
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        onClose(currentId);
        return;
      }
      const idx = tabs.findIndex((tt) => tt.id === currentId);
      if (idx < 0) return;
      // Cmd/Ctrl+Shift+←/→ moves the focused tab itself (accessible reorder,
      // mirroring the drag affordance). Guarded on `onReorder` being wired.
      if (onReorder && (e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        const dir = e.key === "ArrowRight" ? 1 : -1;
        const order = tabs.map((tt) => tt.id);
        const moved = moveTabBy(order, currentId, dir);
        // moveTabBy returns the same array reference (no-op) at the edges —
        // only fire and flash the drop indicator when the order actually moved.
        if (moved !== order) {
          e.preventDefault();
          onReorder(moved);
          setDropIndicator(currentId);
          requestAnimationFrame(() => tabRefs.current.get(currentId)?.focus());
        }
        return;
      }
      let nextIdx: number | null = null;
      if (e.key === "ArrowRight") nextIdx = (idx + 1) % tabs.length;
      else if (e.key === "ArrowLeft") nextIdx = (idx - 1 + tabs.length) % tabs.length;
      else if (e.key === "Home") nextIdx = 0;
      else if (e.key === "End") nextIdx = tabs.length - 1;
      if (nextIdx !== null && nextIdx !== idx) {
        const next = tabs[nextIdx];
        if (next) {
          e.preventDefault();
          onSelect(next.id);
          // setState 直後はまだ DOM が更新されていないため、次フレームでフォーカス。
          const nextId = next.id;
          requestAnimationFrame(() => tabRefs.current.get(nextId)?.focus());
        }
      }
    },
    [tabs, onSelect, onClose, onReorder, setDropIndicator],
  );

  const tabIds = tabs.map((tab) => tab.id);

  // --- Overflow handling: scroll arrows + "all tabs" dropdown ---
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });
  const [listOpen, setListOpen] = useState(false);
  const [listFilter, setListFilter] = useState("");
  const listWrapRef = useRef<HTMLDivElement | null>(null);
  const listBtnRef = useRef<HTMLButtonElement | null>(null);

  // Most-recently-used order: the dropdown surfaces recently visited tabs
  // first so far-away tabs are quick to return to. Updated whenever the active
  // tab changes; ids no longer open are pruned lazily when the list is built.
  const mruRef = useRef<string[]>([]);
  useEffect(() => {
    if (!activeTabId) return;
    mruRef.current = [activeTabId, ...mruRef.current.filter((id) => id !== activeTabId)];
  }, [activeTabId]);

  const recomputeOverflow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const maxScroll = el.scrollWidth - el.clientWidth;
    setOverflow({
      left: el.scrollLeft > 1,
      right: el.scrollLeft < maxScroll - 1,
    });
  }, []);

  // Recompute on resize (ResizeObserver) and whenever the tab set changes. The
  // scroll listener keeps the arrow enabled-state in sync as the user scrolls.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tabs.length はタブ数の変化でオーバーフロー状態を再計算するためのトリガーとして意図的に依存へ含めている
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    recomputeOverflow();
    const ro = new ResizeObserver(recomputeOverflow);
    ro.observe(el);
    el.addEventListener("scroll", recomputeOverflow, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", recomputeOverflow);
    };
  }, [recomputeOverflow, tabs.length]);

  // Keep the active tab visible — when selection moves to an off-screen tab
  // (e.g. via keyboard or programmatic open), scroll it into view horizontally.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tabs.length はタブ追加/削除時にアクティブタブを再度表示域へ入れるためのトリガーとして意図的に依存へ含めている
  useEffect(() => {
    if (!activeTabId) return;
    const el = tabRefs.current.get(activeTabId);
    el?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeTabId, tabs.length]);

  const scrollBy = useCallback((dir: -1 | 1) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(120, el.clientWidth * 0.7), behavior: "smooth" });
  }, []);

  const overflowing = overflow.left || overflow.right;

  // Close the dropdown on outside click / Escape.
  useEffect(() => {
    if (!listOpen) return;
    const onDown = (e: MouseEvent) => {
      if (
        !listWrapRef.current?.contains(e.target as Node) &&
        !listBtnRef.current?.contains(e.target as Node)
      ) {
        setListOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setListOpen(false);
        listBtnRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [listOpen]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: MRU 順は mruRef (ref) から読むため、ドロップダウンを開くたびに listOpen で並びを再計算する意図で依存に含めている
  const listTabs = useMemo(() => {
    const order = new Map(tabs.map((tt, i) => [tt.id, i]));
    const mruRank = new Map(mruRef.current.map((id, i) => [id, i]));
    const q = listFilter.trim().toLowerCase();
    const filtered = q
      ? tabs.filter((tt) => {
          const hay = `${tt.title} ${tt.database ?? ""} ${tt.table ?? ""}`.toLowerCase();
          return hay.includes(q);
        })
      : tabs.slice();
    // MRU first (recently active), then natural tab order for the rest.
    return filtered.sort((a, b) => {
      const ra = mruRank.has(a.id) ? mruRank.get(a.id)! : Infinity;
      const rb = mruRank.has(b.id) ? mruRank.get(b.id)! : Infinity;
      if (ra !== rb) return ra - rb;
      return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
    });
  }, [tabs, listFilter, listOpen]);

  return (
    <Box
      role="tablist"
      display="flex"
      alignItems="stretch"
      borderBottom="1px solid"
      borderColor="app.border"
      bg="app.surfaceMuted"
      minH="34px"
      position="relative"
      overflow="visible"
    >
      {overflow.left && (
        <Tooltip label={t("tabScrollLeft")}>
          <chakra.button
            display="inline-flex"
            alignItems="center"
            justifyContent="center"
            w="26px"
            border="none"
            borderRight="1px solid"
            borderRightColor="app.border"
            bg="app.surfaceMuted"
            color="app.textMuted"
            cursor="pointer"
            flexShrink={0}
            _hover={{ bg: "app.hover", color: "app.text" }}
            onClick={() => scrollBy(-1)}
            aria-label={t("tabScrollLeft")}
          >
            <Icon name="chevron-left" size={ICON_SIZES.md} />
          </chakra.button>
        </Tooltip>
      )}
      <Reorder.Group
        ref={scrollRef}
        as="div"
        axis="x"
        values={tabIds}
        onReorder={(ids: string[]) => onReorder?.(ids)}
        style={{
          display: "flex",
          flex: "1 1 auto",
          minWidth: 0,
          overflowX: "auto",
          overflowY: "hidden",
          scrollbarWidth: "thin",
          listStyle: "none",
          margin: 0,
          padding: 0,
        }}
      >
        <AnimatePresence initial={false}>
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            const isRenaming = tab.id === renamingId && !!tab.renamable;
            const title =
              tab.kind === "table" && tab.database && tab.table
                ? `${tab.database}.${tab.table}`
                : tab.title;
            return (
              <MotionTab
                key={tab.id}
                ref={(el: HTMLElement | null) => {
                  if (el) tabRefs.current.set(tab.id, el);
                  else tabRefs.current.delete(tab.id);
                }}
                // `layout="position"` で全タブを FLIP アニメーションさせると、
                // TabBar はストリーミングや入力のたびに再レンダリングされ、
                // そのたびに全タブの bounding box を測り直して操作が重くなる。
                // 追加/削除時の width/opacity アニメーション
                // (initial/animate/exit) とアクティブインジケータの layoutId は
                // 維持しつつ、per-element の layout 計測は行わない。
                // ドラッグ並び替え: Reorder.Item の `value`。`onReorder` が
                // 無いときは drag を無効化して従来どおり静的に並べる。`whileDrag` で
                // 浮き上がり (scale + 影 + 前面化) を表現し、reduced-motion 配下は
                // MotionConfig により即時化される。
                value={tab.id}
                drag={onReorder && !isRenaming ? true : false}
                whileDrag={{ scale: 1.04, boxShadow: "var(--shadow-lg)", zIndex: 3 }}
                onDragStart={onReorder ? () => setDropIndicator(tab.id, false) : undefined}
                onDragEnd={onReorder ? () => setDropIndicator(null) : undefined}
                role="tab"
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                onKeyDown={handleTabKeyDown(tab.id)}
                // タブ自体 (省略される長い名前のフルテキスト) は意図的に native
                // `title=` のまま残す (#884)。この要素は `AnimatePresence` が
                // 直接の子として追跡して開閉アニメーションを駆動しつつ、同時に
                // `Reorder.Item` としてドラッグ対象にもなっている。共有
                // `Tooltip` はトリガーを `<>{trigger}{portal}</>` という
                // Fragment で包むため、間に挟むと `AnimatePresence` から見た
                // 直接の子がこの Fragment になり、退出アニメーション
                // (exit props の注入) が届かなくなってタブを閉じたときの
                // アニメーションが壊れる。低頻度 (開いているタブ数だけ) の
                // 装飾的な補足情報のため、実害の小さいこの 1 箇所のみ native
                // title を残す判断とする。
                title={title}
                // 追加・削除は opacity + scaleX だけで表す (#1322)。width を 0 ↔ auto に
                // 補間すると隣のタブが毎フレーム再配置されるため。隣は即時に詰まる。
                initial={variants.fadeScaleX.initial}
                animate={variants.fadeScaleX.animate}
                exit={variants.fadeScaleX.exit}
                transition={reducedMotion ? { duration: 0 } : transitions.enter}
                transformOrigin="left center"
                position="relative"
                display="inline-flex"
                alignItems="center"
                gap="1.5"
                pl="2.5"
                pr="2"
                py="1.5"
                borderRight="1px solid"
                borderRightColor="app.border"
                borderTop="2px solid transparent"
                bg={isActive ? "app.surface" : "app.surfaceMuted"}
                color={isActive ? "app.text" : "app.textMuted"}
                cursor="pointer"
                userSelect="none"
                fontSize="sm"
                whiteSpace="nowrap"
                maxW="240px"
                flexShrink={0}
                transitionProperty="background, color, border-color, box-shadow"
                transitionDuration="var(--dur-fast)"
                transitionTimingFunction="var(--ease)"
                _hover={isActive ? undefined : { bg: "app.hover", color: "app.text" }}
                _focusVisible={{ outline: "none", boxShadow: focusRing }}
                onClick={() => onSelect(tab.id)}
                // ダブルクリックでインライン名前変更 (#1390)。ドラッグ (Reorder.Item) と併用するため
                // 個々の子要素ではなくタブ全体で受ける。閉じるボタンは自前で止める。
                onDoubleClick={
                  onRenameStart && tab.renamable
                    ? () => onRenameStart(tab.id)
                    : undefined
                }
                onMouseDown={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    onClose(tab.id);
                  }
                }}
                onContextMenu={
                  onTabContextMenu
                    ? (e) => {
                        e.preventDefault();
                        onTabContextMenu(tab.id, e.clientX, e.clientY);
                      }
                    : undefined
                }
              >
                <chakra.span
                  display="inline-block"
                  w="14px"
                  textAlign="center"
                  fontSize="sm"
                  color={isActive ? "var(--ws-accent)" : "app.textMuted"}
                  flexShrink={0}
                  aria-hidden
                  // 接続切替 (#978) で `--ws-accent` が変わったときになめらかに
                  // 追従させる。単純な色 transition なので CSS のままでよい
                  // (motion.ts の方針)。reduced-motion は App.css のグローバル
                  // メディアクエリが自動で抑制する。
                  transitionProperty="color"
                  transitionDuration="var(--dur-med)"
                  transitionTimingFunction="var(--ease)"
                >
                  <FlightIcon
                    flightId={
                      openFlight !== null &&
                      tab.kind === "table" &&
                      tab.database &&
                      tab.table &&
                      openFlight === tabOpenFlightId(tab.database, tab.table)
                        ? openFlight
                        : null
                    }
                  >
                    <Icon name={tab.kind === "table" ? "table" : tab.kind === "explain" ? "explain" : "query"} />
                  </FlightIcon>
                </chakra.span>
                {isRenaming ? (
                  <TabRenameInput
                    initial={tab.title}
                    ariaLabel={t("tabRenameAria")}
                    onCommit={(v, viaKey) => {
                      onRenameCommit?.(tab.id, v);
                      if (viaKey) requestAnimationFrame(() => tabRefs.current.get(tab.id)?.focus());
                    }}
                    onCancel={(viaKey) => {
                      onRenameCancel?.();
                      // Esc のときは編集欄が消えたあとタブへフォーカスを戻し、矢印キー操作を続けられるようにする。
                      if (viaKey) requestAnimationFrame(() => tabRefs.current.get(tab.id)?.focus());
                    }}
                  />
                ) : (
                  <chakra.span
                    overflow="hidden"
                    textOverflow="ellipsis"
                    whiteSpace="nowrap"
                    maxW="180px"
                  >
                    {tab.title}
                  </chakra.span>
                )}
                {tab.dirty && (
                  <Tooltip label={t("tabDirty")} focusableWrapper>
                    <chakra.span
                      display="inline-flex"
                      alignItems="center"
                      justifyContent="center"
                      w="12px"
                      fontSize="2xs"
                      lineHeight="1"
                      color="app.accent"
                      flexShrink={0}
                      aria-label={t("tabDirty")}
                    >
                      ●
                    </chakra.span>
                  </Tooltip>
                )}
                <Tooltip label={t("tabClose")}>
                  <chakra.button
                    display="inline-flex"
                    alignItems="center"
                    justifyContent="center"
                    w="18px"
                    h="18px"
                    p="0"
                    border="none"
                    bg="transparent"
                    color="app.textMuted"
                    borderRadius="sm"
                    fontSize="xs"
                    lineHeight="1"
                    cursor="pointer"
                    flexShrink={0}
                    transitionProperty="background, color, border-color, box-shadow"
                    transitionDuration="var(--dur-fast)"
                    transitionTimingFunction="var(--ease)"
                    _hover={{ bg: isActive ? "app.active" : "app.hover", color: "app.text" }}
                    aria-label={t("tabClose")}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      onClose(tab.id);
                    }}
                  >
                    <Icon name="close" size={ICON_SIZES.sm} />
                  </chakra.button>
                </Tooltip>
                {isActive && (
                  <MotionIndicator
                    layoutId={indicatorId}
                    transition={transitions.emphasized}
                    position="absolute"
                    left="0"
                    right="0"
                    top="-2px"
                    h="2px"
                    bg="var(--ws-accent, var(--accent))"
                    // 接続切替 (#978) での `--ws-accent` の変化になめらかに追従
                    // させる (位置の移動は上の `transition` prop = motion layout
                    // アニメが担う。こちらは色のみの単純遷移なので CSS のまま)。
                    transitionProperty="background"
                    transitionDuration="var(--dur-med)"
                    transitionTimingFunction="var(--ease)"
                    aria-hidden
                  />
                )}
                {/* Drop-position marker: a vertical accent bar on the tab's
                    leading edge shown while it is dragged / just after a
                    keyboard move, indicating where the tab lands. Shared
                    implementation (#1007) also used by `ConnectionList`. */}
                <DropInsertionMarker orientation="vertical" visible={dropIndicator === tab.id} />
              </MotionTab>
            );
          })}
        </AnimatePresence>
      </Reorder.Group>
      {overflow.right && (
        <Tooltip label={t("tabScrollRight")}>
          <chakra.button
            display="inline-flex"
            alignItems="center"
            justifyContent="center"
            w="26px"
            border="none"
            borderLeft="1px solid"
            borderLeftColor="app.border"
            bg="app.surfaceMuted"
            color="app.textMuted"
            cursor="pointer"
            flexShrink={0}
            _hover={{ bg: "app.hover", color: "app.text" }}
            onClick={() => scrollBy(1)}
            aria-label={t("tabScrollRight")}
          >
            <Icon name="chevron-right" size={ICON_SIZES.md} />
          </chakra.button>
        </Tooltip>
      )}
      {overflowing && (
        <Box position="relative" flexShrink={0} display="inline-flex">
          <Tooltip label={t("tabListAll")}>
            <chakra.button
              ref={listBtnRef}
              display="inline-flex"
              alignItems="center"
              justifyContent="center"
              w="30px"
              h="100%"
              border="none"
              borderLeft="1px solid"
              borderLeftColor="app.border"
              bg={listOpen ? "app.active" : "app.surfaceMuted"}
              color={listOpen ? "app.text" : "app.textMuted"}
              cursor="pointer"
              _hover={{ bg: "app.hover", color: "app.text" }}
              onClick={() => setListOpen((v) => !v)}
              aria-label={t("tabListAll")}
              aria-haspopup="menu"
              aria-expanded={listOpen}
            >
              <Icon name="list" size={ICON_SIZES.md} />
            </chakra.button>
          </Tooltip>
          <AnimatePresence>
            {listOpen && (
              <motion.div
                ref={listWrapRef}
                variants={variants.slideUp}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={transitions.enter}
                style={{ position: "absolute", top: "100%", right: 0, zIndex: "var(--z-dropdown)" }}
              >
                <Box
                  mt="0.5"
                  w="280px"
                  maxH="60vh"
                  display="flex"
                  flexDirection="column"
                  bg="app.surface"
                  border="1px solid"
                  borderColor="app.border"
                  borderRadius="md"
                  boxShadow="lg"
                  overflow="hidden"
                  role="menu"
                >
                  <Box p="1.5" borderBottom="1px solid" borderColor="app.border">
                    <Input
                      autoFocus
                      size="sm"
                      value={listFilter}
                      onChange={(e) => setListFilter(e.target.value)}
                      placeholder={t("tabListFilter")}
                      aria-label={t("tabListFilter")}
                    />
                  </Box>
                  <Box overflowY="auto" css={{ scrollbarWidth: "thin" }}>
                    {listTabs.length === 0 ? (
                      <Box px="2.5" py="2" fontSize="sm" color="app.textMuted">
                        {t("tabListEmpty")}
                      </Box>
                    ) : (
                      listTabs.map((tt) => {
                        const isActive = tt.id === activeTabId;
                        const sub =
                          tt.kind === "table" && tt.database && tt.table
                            ? `${tt.database}.${tt.table}`
                            : undefined;
                        return (
                          <chakra.button
                            key={tt.id}
                            role="menuitem"
                            display="flex"
                            alignItems="center"
                            gap="2"
                            w="100%"
                            textAlign="left"
                            px="2.5"
                            py="1.5"
                            border="none"
                            bg={isActive ? "app.active" : "transparent"}
                            color={isActive ? "app.text" : "app.textMuted"}
                            cursor="pointer"
                            _hover={{ bg: "app.hover", color: "app.text" }}
                            onClick={() => {
                              onSelect(tt.id);
                              setListOpen(false);
                              setListFilter("");
                            }}
                          >
                            <chakra.span flexShrink={0} color={isActive ? "var(--ws-accent)" : "app.textMuted"} aria-hidden>
                              <Icon name={tt.kind === "table" ? "table" : tt.kind === "explain" ? "explain" : "query"} size={ICON_SIZES.md} />
                            </chakra.span>
                            <chakra.span overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap" flex="1">
                              {tt.title}
                              {sub && (
                                <chakra.span ml="1.5" fontSize="2xs" color="app.textMuted">
                                  {sub}
                                </chakra.span>
                              )}
                            </chakra.span>
                          </chakra.button>
                        );
                      })
                    )}
                  </Box>
                </Box>
              </motion.div>
            )}
          </AnimatePresence>
        </Box>
      )}
      <Tooltip label={labelWithShortcut(t("tabNew"), newTabCombo)} focusableWrapper={disabled}>
        <chakra.button
          display="inline-flex"
          alignItems="center"
          justifyContent="center"
          w="30px"
          border="none"
          borderLeft="1px solid"
          borderLeftColor="app.border"
          bg="app.surfaceMuted"
          color="app.textMuted"
          fontSize="lg"
          lineHeight="1"
          cursor="pointer"
          borderRadius="0"
          flexShrink={0}
          transitionProperty="background, color, border-color, box-shadow"
          transitionDuration="var(--dur-fast)"
          transitionTimingFunction="var(--ease)"
          _hover={{ bg: "app.hover", color: "app.text" }}
          _disabled={{ opacity: 0.5, cursor: "not-allowed" }}
          onClick={onNew}
          disabled={disabled}
          aria-label={t("tabNew")}
        >
          <Icon name="plus" size={ICON_SIZES.md} />
        </chakra.button>
      </Tooltip>
      {onSplit && (
        <Tooltip label={splitMode === "close" ? t("tabClosePane") : t("tabSplit")}>
          <chakra.button
            display="inline-flex"
            alignItems="center"
            justifyContent="center"
            w="30px"
            border="none"
            borderLeft="1px solid"
            borderLeftColor="app.border"
            bg="app.surfaceMuted"
            color="app.textMuted"
            lineHeight="1"
            cursor="pointer"
            borderRadius="0"
            flexShrink={0}
            _hover={{ bg: "app.hover", color: "app.text" }}
            onClick={onSplit}
            aria-label={splitMode === "close" ? t("tabClosePane") : t("tabSplit")}
          >
            <Icon name={splitMode === "close" ? "close" : "columns"} size={ICON_SIZES.md} />
          </chakra.button>
        </Tooltip>
      )}
    </Box>
  );
});
