import { forwardRef, useCallback, useRef, type ReactNode } from "react";
import { Box, chakra, Flex } from "@chakra-ui/react";
import { useT } from "../i18n";
import {
  nextBottomPanelTab,
  type BottomPanelTab,
} from "./bottomPanelTabs";
import { Icon, ICON_SIZES } from "./Icon";
import { Splitter } from "./Splitter";
import { Tooltip } from "./Tooltip";
import { Button } from "./ui";

/**
 * ワークスペース下部のボトムパネル (#1112 / Epic #1110 Phase 2)。
 *
 * **器だけを提供する**シェルで、タブの並び・中身・開閉状態は `App.tsx` が持つ
 * (判定ロジックは `bottomPanelTabs.ts` の純関数)。ここが担うのは
 * 「タブバー + 閉じる + 本体スクロール枠」という共通の見た目と、WAI-ARIA tabs
 * パターンのキーボード操作だけ。
 *
 * ## 高さのリサイズはここでは持たない
 *
 * 上下の配分は呼び出し側 (`App.tsx`) が既存の `Splitter direction="column"` で
 * 与える。ドラッグ・キーボード操作・localStorage 永続化・クランプ規則はすべて
 * `Splitter` / `paneLayout.ts` に実装済みで、ここで二重実装すると規則がズレる。
 *
 * ## パネル本体はタイトルを持たない
 *
 * どのパネルを見ているかはタブバーが示し、閉じる操作はここの × に集約する。
 * そのため中身のコンポーネント (`AdvisorPanel` など) 側の見出し + 閉じるボタンは
 * #1112 で削除した。中身はツールバー (再実行・フィルタなど) から始まる。
 */

const tabId = (key: BottomPanelTab) => `bottom-panel-tab-${key}`;
const panelId = (key: BottomPanelTab) => `bottom-panel-${key}`;

/**
 * ボトムパネルのタブ 1 つ。サイドバーのタブ (`SidebarTabButton`) と同じ
 * ローピング tabindex + 自動アクティベーションで、アクティブタブだけが
 * `tabIndex=0` を持つ。選択の表現だけは上辺のアクセント線にして、
 * 「下から生えているパネル」という位置関係を見た目でも示す。
 */
const BottomPanelTabButton = forwardRef<
  HTMLButtonElement,
  {
    tabKey: BottomPanelTab;
    active: boolean;
    onActivate: () => void;
    onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => void;
    children: ReactNode;
  }
>(function BottomPanelTabButton({ tabKey, active, onActivate, onKeyDown, children }, ref) {
  return (
    <chakra.button
      ref={ref}
      type="button"
      role="tab"
      id={tabId(tabKey)}
      aria-controls={panelId(tabKey)}
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      bg={active ? "app.surface" : "transparent"}
      border="none"
      borderTop="2px solid"
      borderTopColor={active ? "app.accent" : "transparent"}
      borderRadius="0"
      px="3"
      py="1.5"
      fontSize="sm"
      fontWeight={600}
      whiteSpace="nowrap"
      color={active ? "app.text" : "app.textMuted"}
      cursor="pointer"
      transition="background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease)"
      _hover={{ bg: "app.hover", color: "app.text" }}
      _focusVisible={{
        outline: "none",
        boxShadow: "0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent)",
      }}
      onClick={onActivate}
      onKeyDown={onKeyDown}
    >
      {children}
    </chakra.button>
  );
});

interface Props {
  /** 表示中のタブ。`resolveBottomPanelTab` で解決済みの値を渡す。 */
  tab: BottomPanelTab;
  /** その文脈で開けるタブ (表示順)。`availableBottomPanelTabs` の戻り値。 */
  tabs: readonly BottomPanelTab[];
  /** タブラベル。i18n 済みの文字列を呼び出し側が解決して渡す。 */
  label: (tab: BottomPanelTab) => string;
  onSelect: (tab: BottomPanelTab) => void;
  onClose: () => void;
  children: ReactNode;
}

export function BottomPanel({ tab, tabs, label, onSelect, onClose, children }: Props) {
  const t = useT();
  const tabRefs = useRef<Partial<Record<BottomPanelTab, HTMLButtonElement | null>>>({});

  const onTabKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      // Escape はタブバーからでもパネルを閉じられるようにする (本体側の Escape は
      // 中身のコンポーネントが自分の用途で使うことがあるため、ここだけに留める)。
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : null;
      let target: BottomPanelTab | null = null;
      if (delta) target = nextBottomPanelTab(tabs, tab, delta);
      else if (e.key === "Home") target = tabs[0] ?? null;
      else if (e.key === "End") target = tabs[tabs.length - 1] ?? null;
      if (!target) return;
      e.preventDefault();
      onSelect(target);
      // 自動アクティベーション: 選択と同時にフォーカスも移す。再描画後に
      // ref が差し替わるため次フレームで当てる (サイドバーのタブと同じ方式)。
      const next = target;
      requestAnimationFrame(() => tabRefs.current[next]?.focus());
    },
    [onClose, onSelect, tab, tabs],
  );

  return (
    <Flex
      direction="column"
      flex="1"
      minH={0}
      overflow="hidden"
      bg="app.surface"
      borderTopWidth="1px"
      borderTopColor="app.border"
    >
      <Flex
        as="header"
        align="stretch"
        gap="0.5"
        bg="app.toolbar"
        borderBottomWidth="1px"
        borderBottomColor="app.border"
      >
        <Flex role="tablist" aria-label={t("bottomPanelTablistAria")} align="stretch" overflowX="auto">
          {tabs.map((key) => (
            <BottomPanelTabButton
              key={key}
              ref={(el) => {
                tabRefs.current[key] = el;
              }}
              tabKey={key}
              active={key === tab}
              onActivate={() => onSelect(key)}
              onKeyDown={onTabKeyDown}
            >
              {label(key)}
            </BottomPanelTabButton>
          ))}
        </Flex>
        <Box flex="1" />
        <Flex align="center" px="1.5">
          <Tooltip label={t("bottomPanelClose")}>
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              aria-label={t("bottomPanelClose")}
              css={{ minWidth: "28px", py: "1", px: "2", fontSize: "base", lineHeight: 1 }}
            >
              <Icon name="close" size={ICON_SIZES.sm} />
            </Button>
          </Tooltip>
        </Flex>
      </Flex>
      <Box
        id={panelId(tab)}
        role="tabpanel"
        aria-labelledby={tabId(tab)}
        flex="1"
        minH={0}
        display="flex"
        flexDirection="column"
        overflow="hidden"
      >
        {children}
      </Box>
    </Flex>
  );
}

/**
 * ワークスペース (全画面サーフェス) とボトムパネルの縦分割 (#1112)。
 *
 * `bottom` が null のときは分割そのものを作らず `children` を素通しする — 閉じている
 * ときに 0 高のペインとセパレータを残すと、`<main>` の下端に押せない線が居座るため。
 *
 * 分割の実装は既存の `Splitter` に委ねる。ドラッグ・キーボード操作 (矢印 / Home /
 * End / Enter)・localStorage 永続化・最小サイズのクランプはすべてそちらと
 * `paneLayout.ts` に実装済みで、ここで持つと規則が二重になる。既定の配分 (0.62) は
 * 「エディタと結果が主役、パネルは従」という Epic #1110 の方針をそのまま比率にした。
 */
export function WorkspaceSplit({
  bottom,
  children,
}: {
  bottom: ReactNode | null;
  children: ReactNode;
}) {
  const t = useT();
  if (!bottom) return <>{children}</>;
  return (
    <Splitter
      direction="column"
      first={children}
      second={bottom}
      defaultFraction={0.62}
      minSize={140}
      storageKey="noobdb.bottomPanelSplit"
      ariaLabel={t("bottomPanelResizeAria")}
    />
  );
}
