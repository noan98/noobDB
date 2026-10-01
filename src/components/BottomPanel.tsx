import {
  forwardRef,
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Box, chakra, Flex } from "@chakra-ui/react";
import { AnimatePresence, motion } from "motion/react";
import { useT } from "../i18n";
import { transitions, variants } from "../motion";
import {
  bottomPanelGroupStarts,
  nextBottomPanelTab,
  type BottomPanelStripEntry,
  type BottomPanelTab,
  type BottomPanelUnavailableReason,
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
 *
 * ## モーション (#1142)
 *
 * 全画面サーフェス・結果ペイン種別の切替と同じ語彙で、タブ切替は本体を
 * `variants.fade` でクロスフェードし、開閉は `WorkspaceSplit` がパネル全体を
 * `variants.slideUp` で出し入れする。reduced-motion 時はルートの `MotionConfig`
 * が y 移動を抑制する (フェードだけが残る)。
 */

/** アニメーションする本体・パネルの枠。flex 子として高さいっぱいに広がる。 */
const FILL_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

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
        boxShadow: "var(--focus-ring)",
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
  // 用途グループ (ログ / 診断 / 参照、#1114) の切れ目に区切り線を引く。
  const groupStarts = useMemo(() => bottomPanelGroupStarts(tabs), [tabs]);

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
            <Fragment key={key}>
              {groupStarts.has(key) && (
                // 装飾の区切り線。タブ列のキーボード巡回 (矢印キー) には参加させない。
                <Box
                  aria-hidden
                  data-testid="bottom-panel-group-divider"
                  alignSelf="center"
                  w="1px"
                  h="16px"
                  mx="1"
                  bg="app.border"
                  flexShrink={0}
                />
              )}
              <BottomPanelTabButton
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
            </Fragment>
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
        {/* 結果ペインの種別切替 (App.tsx) と同じ組み合わせ。初回表示はパネル
            自体の出現 (WorkspaceSplit) と二重にならないよう initial={false}。 */}
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={tab}
            initial={variants.fade.initial}
            animate={variants.fade.animate}
            exit={variants.fade.exit}
            transition={transitions.crossfade}
            style={FILL_STYLE}
          >
            {children}
          </motion.div>
        </AnimatePresence>
      </Box>
    </Flex>
  );
}

/**
 * ボトムパネルを閉じているときに `<main>` の下端へ常設するパネルバー。
 *
 * ## なぜ置くのか
 *
 * #1112 の設計では閉じるとタブ列ごと消え、プロセスモニタ・クエリインスペクタ・
 * アドバイザ・接続ヘルスといった中核機能の入口がサイドバー右上のレンチアイコン
 * (フラットな 17 項目メニュー) とコマンドパレットしか無かった。VS Code の折りたたみ
 * パネルと同じく、閉じていても「何が下にあるか」を 1 行で見せ、1 クリックで開ける
 * ようにする。項目の並び・有効 / 無効・理由は `bottomPanelStripTabs` (純ロジック) が
 * 決め、ここは描画だけを担う。開いているときは `BottomPanel` のタブバーが同じ役目を
 * 持つので、このバーは出さない (二重のタブ列を作らない)。
 *
 * 無効な項目は `disabled` にせず `aria-disabled` で止める — `disabled` だとホバーも
 * フォーカスも効かず、「なぜ今は開けないか」のツールチップが読めないため。
 */
export function BottomPanelStrip({
  entries,
  label,
  reasonLabel,
  onOpen,
}: {
  /** `bottomPanelStripTabs` の戻り値。 */
  entries: readonly BottomPanelStripEntry[];
  /** タブラベル。`BottomPanel` と同じ関数を渡す。 */
  label: (tab: BottomPanelTab) => string;
  /** 無効な項目の理由 (ツールチップ)。i18n 済みの文字列を返す。 */
  reasonLabel: (reason: BottomPanelUnavailableReason) => string;
  onOpen: (tab: BottomPanelTab) => void;
}) {
  const t = useT();
  const groupStarts = useMemo(
    () => bottomPanelGroupStarts(entries.map((e) => e.tab)),
    [entries],
  );
  if (entries.length === 0) return null;
  return (
    <Flex
      as="nav"
      aria-label={t("bottomPanelStripAria")}
      data-testid="bottom-panel-strip"
      align="stretch"
      gap="0.5"
      flexShrink={0}
      bg="app.toolbar"
      borderTopWidth="1px"
      borderTopColor="app.border"
      overflowX="auto"
      // 「下から生えるパネル」の折りたたみ状態なので、`BottomPanel` のヘッダと
      // 同じ面色 + 上辺の線で連続性を持たせる。
    >
      {entries.map(({ tab, enabled, reason }) => (
        <Fragment key={tab}>
          {groupStarts.has(tab) && (
            <Box
              aria-hidden
              data-testid="bottom-panel-group-divider"
              alignSelf="center"
              w="1px"
              h="16px"
              mx="1"
              bg="app.border"
              flexShrink={0}
            />
          )}
          {/* 有効な項目は `label` が undefined になり、Tooltip は子をそのまま返す。 */}
          <Tooltip label={enabled || !reason ? undefined : reasonLabel(reason)}>
            <chakra.button
              type="button"
              aria-disabled={enabled ? undefined : true}
              data-testid={`bottom-panel-strip-${tab}`}
              bg="transparent"
              border="none"
              borderTop="2px solid transparent"
              borderRadius="0"
              px="2.5"
              py="1"
              fontSize="sm"
              fontWeight={600}
              whiteSpace="nowrap"
              color="app.textMuted"
              opacity={enabled ? 1 : 0.5}
              cursor={enabled ? "pointer" : "not-allowed"}
              transition="background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease)"
              _hover={enabled ? { bg: "app.hover", color: "app.text" } : undefined}
              _focusVisible={{ outline: "none", boxShadow: "var(--focus-ring)" }}
              onClick={() => {
                if (enabled) onOpen(tab);
              }}
            >
              {label(tab)}
            </chakra.button>
          </Tooltip>
        </Fragment>
      ))}
    </Flex>
  );
}

/**
 * ワークスペース (全画面サーフェス) とボトムパネルの縦分割 (#1112)。
 *
 * `bottom` が null のときはセパレータを隠し、2 つ目のペインを `collapsed`
 * (折りたたみ時のパネルバー) の高さだけの帯にする — 0 高のペインとセパレータを
 * 残すと `<main>` の下端に押せない線が居座るため。Splitter 自体は閉じても残す
 * (出し入れすると `children` が再マウントされて開閉が重くなる)。
 *
 * 分割の実装は既存の `Splitter` に委ねる。ドラッグ・キーボード操作 (矢印 / Home /
 * End / Enter)・localStorage 永続化・最小サイズのクランプはすべてそちらと
 * `paneLayout.ts` に実装済みで、ここで持つと規則が二重になる。既定の配分 (0.62) は
 * 「エディタと結果が主役、パネルは従」という Epic #1110 の方針をそのまま比率にした。
 *
 * 開閉はパネル全体を `variants.slideUp` で出し入れする (#1142)。高さは補間しない —
 * 分割比は `Splitter` が持っているので、高さを動かすとドラッグ中の比率計算と
 * 競合する。閉じるときは退場アニメーションが終わるまで分割を残し、
 * `onExitComplete` で初めて折りたたみの帯へ戻す。起動時に前回開いていた
 * パネルは演出なしで出す (アプリの初期表示を遅く見せないため)。
 */
export function WorkspaceSplit({
  bottom,
  collapsed,
  children,
}: {
  bottom: ReactNode | null;
  /**
   * 閉じているときだけ `children` の下に置くもの (`BottomPanelStrip`)。開いている
   * 間と退場アニメーション中は出さない (タブ列が二重に見えないように)。
   */
  collapsed?: ReactNode;
  children: ReactNode;
}) {
  const t = useT();
  const open = Boolean(bottom);
  // 閉じる操作の後も退場アニメーションが終わるまで分割を残すためのフラグ。
  // 開いた瞬間は描画中に同期で立てる (effect で立てると 1 フレーム分割無しで描かれる)。
  const [split, setSplit] = useState(open);
  if (open && !split) setSplit(true);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);

  // 閉じていても Splitter は残し、2 つ目のペインを折りたたみ時のパネルバーの帯に
  // するだけにする。開閉のたびに Splitter ごと出し入れすると、`children` (エディタと
  // 結果グリッド) が別の親へ移って丸ごと再マウントされ、開閉が目に見えて遅くなる。
  return (
    <Splitter
      direction="column"
      first={children}
      secondCollapsed={!open && !split}
      second={
        !open && !split ? (
          collapsed ?? null
        ) : (
          <AnimatePresence onExitComplete={() => setSplit(false)}>
            {open && (
              <motion.div
                key="bottom-panel"
                initial={mounted.current ? variants.slideUp.initial : false}
                animate={variants.slideUp.animate}
                exit={variants.slideUp.initial}
                transition={transitions.enter}
                style={FILL_STYLE}
              >
                {bottom}
              </motion.div>
            )}
          </AnimatePresence>
        )
      }
      defaultFraction={0.62}
      minSize={140}
      storageKey="noobdb.bottomPanelSplit"
      ariaLabel={t("bottomPanelResizeAria")}
    />
  );
}
