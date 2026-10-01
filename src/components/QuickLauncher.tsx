import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Box, chakra, Flex } from "@chakra-ui/react";
import type { Snippet } from "../api/tauri";
import { useT } from "../i18n";
import { useRovingFocus } from "../keyboardNav";
import {
  DEFAULT_LAUNCHER_POSITION,
  buildQuickLauncherSections,
  clampLauncherPoint,
  computeLauncherPopoverPosition,
  exceedsDragThreshold,
  launcherPointToPosition,
  launcherPositionToPoint,
  loadLauncherPosition,
  nudgeLauncherPoint,
  saveLauncherPosition,
  singleLineSql,
  type LauncherBounds,
  type LauncherPosition,
  type Point,
  type QuickLauncherItem,
  type QuickLauncherSectionId,
  type QuickLauncherSectionLimits,
  type QuickLauncherSources,
} from "../quickLauncher";
import type { TableRef } from "../tableQuickAccess";
import { ContextMenu } from "./ContextMenu";
import { EmptyState } from "./EmptyState";
import { Icon, ICON_SIZES } from "./Icon";
import {
  QUICK_LAUNCHER_RESET_EVENT,
  QUICK_LAUNCHER_SECTION_LABEL,
  resetQuickLauncherPosition,
} from "./QuickLauncherSettings";
import { Tooltip } from "./Tooltip";

/**
 * フローティング・ランチャー (#1254)。デザインシステム上の第 5 の置き場
 * 「Floating Launcher」で、**参照/呼び出しのショートカット専用** (作業内容そのものは
 * 置かない)。SQL エディタのある画面にだけ常駐し、クリックでお気に入りスニペット /
 * 最近のクエリ / お気に入りテーブル / 最近のテーブルのポップオーバーを開く。
 *
 * - 行のクリックは「エディタへ挿入」。実行は修飾キー (Cmd/Ctrl) 併用か行内の
 *   「実行」ボタンで、App 側が既存の実行経路 (危険クエリ確認・読み取り専用ガード) を通す。
 * - ボタンはドラッグで移動でき、しきい値未満の移動はクリックとして扱う。位置は
 *   「最寄りの隅 + 端からの割合」で localStorage に保存し、リサイズでも可視範囲に収める。
 *   Bottom Panel 等と重なっても自動では動かさない (右クリック →「位置をリセット」)。
 * - 位置計算・クランプ・保存形式・セクション構築は `quickLauncher.ts` の純関数。
 */
interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sources: QuickLauncherSources;
  limits: QuickLauncherSectionLimits;
  onInsertSnippet: (snippet: Snippet) => void;
  onRunSnippet: (snippet: Snippet) => void;
  onInsertQuery: (sql: string) => void;
  onRunQuery: (sql: string) => void;
  onInsertTable: (ref: TableRef) => void;
  onOpenTable: (ref: TableRef) => void;
  /** 「もっと見る」: 既存の一覧 (スニペット / 履歴 / スキーマツリー) を開く。 */
  onShowMore: (section: QuickLauncherSectionId) => void;
  /** 設定画面を開く (右クリックメニュー)。 */
  onOpenSettings: () => void;
}

/** ボタンの一辺 (px)。レイアウトの実寸なので px で持つ。 */
const BUTTON_SIZE = 40;
/** ウィンドウ端からの余白 (タイトルバー・ステータスバーを避ける)。 */
const EDGE = { left: 12, right: 12, top: 52, bottom: 40 };

function viewportBounds(): LauncherBounds {
  const w = typeof window === "undefined" ? 1280 : window.innerWidth;
  const h = typeof window === "undefined" ? 800 : window.innerHeight;
  return {
    left: EDGE.left,
    top: EDGE.top,
    width: Math.max(BUTTON_SIZE, w - EDGE.left - EDGE.right),
    height: Math.max(BUTTON_SIZE, h - EDGE.top - EDGE.bottom),
  };
}

const SIZE = { width: BUTTON_SIZE, height: BUTTON_SIZE };

function itemLabel(item: QuickLauncherItem): { primary: string; secondary: string | null } {
  switch (item.kind) {
    case "snippet":
      return { primary: item.snippet.name, secondary: item.snippet.folder };
    case "query":
      return { primary: singleLineSql(item.sql), secondary: null };
    case "table":
      return { primary: item.ref.table, secondary: item.ref.database };
  }
}

const ITEM_SELECTOR = "[data-launcher-item]";

export function QuickLauncher({
  open,
  onOpenChange,
  sources,
  limits,
  onInsertSnippet,
  onRunSnippet,
  onInsertQuery,
  onRunQuery,
  onInsertTable,
  onOpenTable,
  onShowMore,
  onOpenSettings,
}: Props) {
  const t = useT();
  const [position, setPosition] = useState<LauncherPosition>(() => loadLauncherPosition());
  const [bounds, setBounds] = useState<LauncherBounds>(() => viewportBounds());
  // ドラッグ中だけ使う生の左上点 (null なら position から求める)。
  const [dragPoint, setDragPoint] = useState<Point | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; origin: Point; dragging: boolean } | null>(null);
  // 直前のポインタ操作がドラッグだったか (続く click で開閉させない)。
  const suppressClickRef = useRef(false);

  const point = dragPoint ?? launcherPositionToPoint(position, bounds, SIZE);

  useEffect(() => {
    const onResize = () => setBounds(viewportBounds());
    const onReset = () => setPosition(DEFAULT_LAUNCHER_POSITION);
    window.addEventListener("resize", onResize);
    window.addEventListener(QUICK_LAUNCHER_RESET_EVENT, onReset);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener(QUICK_LAUNCHER_RESET_EVENT, onReset);
    };
  }, []);

  const commitPoint = useCallback(
    (p: Point) => {
      const next = launcherPointToPosition(p, bounds, SIZE);
      setPosition(next);
      saveLauncherPosition(next);
    },
    [bounds],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    // Splitter など下層のドラッグ操作へ伝播させない。
    e.stopPropagation();
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origin: point,
      dragging: false,
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // jsdom など未対応の環境では捕捉なしで続行する。
    }
  };
  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.dragging && !exceedsDragThreshold(dx, dy)) return;
    if (!d.dragging) {
      d.dragging = true;
      onOpenChange(false);
    }
    e.preventDefault();
    setDragPoint(clampLauncherPoint({ left: d.origin.left + dx, top: d.origin.top + dy }, bounds, SIZE));
  };
  const endDrag = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    dragRef.current = null;
    if (d.dragging) {
      suppressClickRef.current = true;
      commitPoint(
        clampLauncherPoint(
          { left: d.origin.left + (e.clientX - d.startX), top: d.origin.top + (e.clientY - d.startY) },
          bounds,
          SIZE,
        ),
      );
      setDragPoint(null);
    }
  };

  const onButtonClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onOpenChange(!open);
  };

  const onButtonKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const next = nudgeLauncherPoint(point, e.key, e.shiftKey);
    if (!next) return;
    e.preventDefault();
    commitPoint(clampLauncherPoint(next, bounds, SIZE));
  };

  // ---- ポップオーバー ----
  const sections = useMemo(() => buildQuickLauncherSections(sources, limits), [sources, limits]);
  const visibleSections = sections.filter((s) => s.items.length > 0);
  const [popoverPos, setPopoverPos] = useState<Point | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPopoverPos(null);
      return;
    }
    const el = popoverRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const p = computeLauncherPopoverPosition(
      { left: point.left, top: point.top, width: BUTTON_SIZE, height: BUTTON_SIZE },
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setPopoverPos({ left: p.left, top: p.top });
    // 位置・中身が変わったときだけ測り直す。
  }, [open, point.left, point.top, bounds, visibleSections.length]);

  // 開いたら先頭の項目へフォーカスを移す。
  useEffect(() => {
    if (!open) return;
    const id = window.requestAnimationFrame(() => {
      const first = popoverRef.current?.querySelector<HTMLElement>(ITEM_SELECTOR);
      (first ?? popoverRef.current)?.focus();
    });
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  const close = useCallback(
    (returnFocus: boolean) => {
      onOpenChange(false);
      if (returnFocus) buttonRef.current?.focus();
    },
    [onOpenChange],
  );

  // 外側クリックで閉じる。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      onOpenChange(false);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open, onOpenChange]);

  const roving = useRovingFocus(popoverRef, ITEM_SELECTOR, { wrap: true });

  const activate = (item: QuickLauncherItem, run: boolean) => {
    close(false);
    switch (item.kind) {
      case "snippet":
        (run ? onRunSnippet : onInsertSnippet)(item.snippet);
        return;
      case "query":
        (run ? onRunQuery : onInsertQuery)(item.sql);
        return;
      case "table":
        (run ? onOpenTable : onInsertTable)(item.ref);
        return;
    }
  };

  const runLabel = (item: QuickLauncherItem) =>
    item.kind === "table" ? t("quickLauncherOpenTable") : t("quickLauncherRun");

  return (
    <>
      <Tooltip label={t("quickLauncherButtonTooltip")}>
        <chakra.button
          ref={buttonRef}
          type="button"
          data-testid="quick-launcher-button"
          aria-label={t("quickLauncherButtonAria")}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={onButtonClick}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onButtonKeyDown}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY });
          }}
          position="fixed"
          zIndex="raised"
          style={{ left: point.left, top: point.top, width: BUTTON_SIZE, height: BUTTON_SIZE }}
          display="inline-flex"
          alignItems="center"
          justifyContent="center"
          borderRadius="pill"
          bg="app.accent"
          color="app.accentText"
          shadow="elevationRaised"
          border="none"
          cursor={dragPoint ? "grabbing" : "pointer"}
          touchAction="none"
          userSelect="none"
          opacity={open || dragPoint ? 1 : 0.85}
          _hover={{ opacity: 1, bg: "app.accentHover" }}
          _focusVisible={{ outline: "none", boxShadow: "var(--focus-ring)", opacity: 1 }}
        >
          <Icon name="star" size={ICON_SIZES.md} />
        </chakra.button>
      </Tooltip>

      {open &&
        createPortal(
          <Box
            ref={popoverRef}
            role="dialog"
            aria-label={t("quickLauncherTitle")}
            tabIndex={-1}
            data-testid="quick-launcher-popover"
            position="fixed"
            zIndex="popover"
            style={{
              left: popoverPos?.left ?? point.left,
              top: popoverPos?.top ?? point.top,
              visibility: popoverPos ? "visible" : "hidden",
            }}
            w="320px"
            maxH="min(480px, 70vh)"
            overflowY="auto"
            bg="app.surface"
            border="1px solid"
            borderColor="app.border"
            borderRadius="lg"
            shadow="elevationPopover"
            p="1.5"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                close(true);
                return;
              }
              roving.onKeyDown(e);
            }}
          >
            {visibleSections.length === 0 ? (
              <EmptyState
                compact
                icon="star"
                title={t("quickLauncherEmptyTitle")}
                description={t("quickLauncherEmptyDescription")}
              />
            ) : (
              visibleSections.map((section) => (
                <Box key={section.id} role="group" aria-label={t(QUICK_LAUNCHER_SECTION_LABEL[section.id])} py="1">
                  <chakra.div textStyle="overline" px="2" py="1">
                    {t(QUICK_LAUNCHER_SECTION_LABEL[section.id])}
                  </chakra.div>
                  {section.items.map((item) => {
                    const label = itemLabel(item);
                    return (
                      <Flex key={item.key} align="center" gap="1" borderRadius="sm" _hover={{ bg: "app.hover" }}>
                        <chakra.button
                          type="button"
                          data-launcher-item=""
                          flex="1"
                          minW="0"
                          display="flex"
                          flexDirection="column"
                          alignItems="flex-start"
                          gap="0.25"
                          px="2"
                          py="1"
                          bg="transparent"
                          border="none"
                          borderRadius="sm"
                          textAlign="left"
                          cursor="pointer"
                          color="app.text"
                          fontSize="sm"
                          fontFamily={item.kind === "query" ? "mono" : undefined}
                          aria-label={t("quickLauncherInsertAria", { name: label.primary })}
                          _focusVisible={{ outline: "none", boxShadow: "inset var(--focus-ring)" }}
                          onClick={(e) => activate(item, e.metaKey || e.ctrlKey)}
                        >
                          <chakra.span truncate maxW="100%">
                            {label.primary}
                          </chakra.span>
                          {label.secondary && (
                            <chakra.span fontSize="xs" color="app.textMuted" truncate maxW="100%">
                              {label.secondary}
                            </chakra.span>
                          )}
                        </chakra.button>
                        <Tooltip label={runLabel(item)}>
                          <chakra.button
                            type="button"
                            aria-label={`${runLabel(item)}: ${label.primary}`}
                            display="inline-flex"
                            alignItems="center"
                            justifyContent="center"
                            p="1"
                            mr="1"
                            bg="transparent"
                            border="none"
                            borderRadius="sm"
                            color="app.textMuted"
                            cursor="pointer"
                            _hover={{ color: "app.text" }}
                            _focusVisible={{ outline: "none", boxShadow: "var(--focus-ring)" }}
                            onClick={() => activate(item, true)}
                          >
                            <Icon name={item.kind === "table" ? "table" : "play"} size={ICON_SIZES.sm} />
                          </chakra.button>
                        </Tooltip>
                      </Flex>
                    );
                  })}
                  {section.hasMore && (
                    <chakra.button
                      type="button"
                      data-launcher-item=""
                      display="block"
                      w="100%"
                      px="2"
                      py="1"
                      bg="transparent"
                      border="none"
                      borderRadius="sm"
                      textAlign="left"
                      fontSize="xs"
                      color="app.textMuted"
                      cursor="pointer"
                      _hover={{ color: "app.text", bg: "app.hover" }}
                      _focusVisible={{ outline: "none", boxShadow: "inset var(--focus-ring)" }}
                      onClick={() => {
                        close(false);
                        onShowMore(section.id);
                      }}
                    >
                      {t("quickLauncherShowMore")}
                    </chakra.button>
                  )}
                </Box>
              ))
            )}
            <chakra.div px="2" pt="1" fontSize="2xs" color="app.textMuted">
              {t("quickLauncherFooterHint")}
            </chakra.div>
          </Box>,
          document.body,
        )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: t("quickLauncherResetPosition"), onSelect: resetQuickLauncherPosition },
            { label: t("quickLauncherOpenSettings"), onSelect: onOpenSettings },
          ]}
        />
      )}
    </>
  );
}
