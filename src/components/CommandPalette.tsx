import { chakra, Box, Flex } from "@chakra-ui/react";
import { motion, useReducedMotion } from "motion/react";
import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useT } from "../i18n";
import { Icon, ICON_SIZES } from "./Icon";
import { Kbd } from "./Kbd";
import { Modal } from "./Modal";
import { staggerContainer, transitions, variants } from "../motion";
import {
  groupCommands,
  limitAndIndexGroups,
  shouldStaggerEntrance,
  splitLabel,
  type CommandGroup,
  type CommandItem,
  type ScoredItem,
} from "./commandPaletteSearch";

// motion 用 props は Chakra のスタイルプロップ名 (`transition`) と衝突したり、
// スタイルプロップ以外は既定で無視されたりするため、必要なものだけ明示的に転送する
// (`TabBar` の `MotionIndicator` / `ProfileCardGrid` の `MotionFlex` と同じパターン)。
// - `MotionHighlight`: アクティブ行の背後を滑らせる `layoutId` ハイライト (#976)。
// - `MotionRow`: 結果グループのスタッガー出現に使う `variants` を持つ行本体。
const MotionHighlight = chakra(motion.div, {}, { forwardProps: ["transition"] });
const MotionRow = chakra(motion.button, {}, { forwardProps: ["variants"] });
const MotionListBox = chakra(motion.div, {}, { forwardProps: ["variants", "initial", "animate"] });

/**
 * コマンドパレット (Cmd/Ctrl+K)。接続・テーブル・スニペット・履歴・画面遷移を
 * 単一の検索 UI から横断検索し、キーボード完結で実行できる。
 *
 * - 表示・絞り込み・グループ化・ハイライトのロジックは `commandPalette.ts` に分離。
 *   ここは入力状態・キーボードナビ・実行・描画のみを担う。
 * - シェルは共通 `Modal` を流用する。Chakra の `Dialog` がフォーカストラップ・
 *   Escape クローズ・バックドロップを、`Modal` 側の `AnimatePresence` + motion
 *   プリセット (`variants.dialog`) が開閉アニメを担う。
 * - `prefers-reduced-motion` は `MotionConfig reducedMotion="user"` で自動抑制。
 *
 * 候補データと実行ハンドラは `App.tsx` が `items` として組み立てて渡す
 * (接続・テーブル・スニペット・履歴・画面遷移)。パレットは候補を選択 (Enter /
 * クリック) すると `onSelectItem` (与えられていれば) → `item.run()` の順に呼び、
 * `onClose()` で自分を閉じる。
 * - **MRU (#845)**: `mruIds` (最新が先頭の `CommandItem.id` 配列) を渡すと、空
 *   クエリ時に限り先頭へ「最近使った項目」セクションを合成する
 *   (`commandPaletteSearch.ts` の `groupCommands`)。実行された候補は
 *   `onSelectItem` 経由で呼び出し側 (`App.tsx`) が MRU へ記録する。永続化・
 *   上限・破損データ耐性は `settings.ts` / `commandPaletteSearch.ts` の責務で、
 *   このコンポーネントは受け取った id 配列を表示するだけ。
 */

interface CommandPaletteProps {
  items: CommandItem[];
  onClose: () => void;
  /** MRU (#845): 最近使った候補の id (最新が先頭)。空クエリ時のみ先頭セクションに反映。 */
  mruIds?: string[];
  /** MRU (#845): 候補を実行した (Enter / クリック) 直後に呼ばれる。呼び出し側が MRU を更新する。 */
  onSelectItem?: (item: CommandItem) => void;
}

export function CommandPalette({ items, onClose, mruIds = [], onSelectItem }: CommandPaletteProps) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const reduced = useReducedMotion() ?? false;
  // このパレットインスタンス限定でハイライトを共有する layoutId (#976)。TabBar の
  // インジケータと同じ発想 — 複数パレットが同時に存在することは無いが、スコープを
  // 切っておくことでコンポーネント跨ぎの衝突を構造的に避ける。
  const highlightId = `cmdk-active-highlight-${useId()}`;

  // スコア計算と大量行の再描画は優先度を下げ、入力欄の反応を先に返す (#1320)。
  const deferredQuery = useDeferredValue(query);
  const [expanded, setExpanded] = useState(false);

  const grouped = useMemo(
    () => groupCommands(items, deferredQuery, mruIds),
    [items, deferredQuery, mruIds],
  );
  // 件数上限と表示順 index の事前計算。行ごとの flat.indexOf (O(n^2)) を持たない。
  const {
    groups: visibleGroups,
    flat,
    hiddenCount,
  } = useMemo(
    () => limitAndIndexGroups(grouped, deferredQuery, expanded),
    [grouped, deferredQuery, expanded],
  );

  const groupLabel: Record<CommandGroup, string> = {
    mru: t("cmdkGroupMru"),
    navigation: t("cmdkGroupNavigation"),
    connections: t("cmdkGroupConnections"),
    tables: t("cmdkGroupTables"),
    snippets: t("cmdkGroupSnippets"),
    history: t("cmdkGroupHistory"),
  };

  // クエリが変わって候補が並び替わるたび、選択を先頭へ戻す (範囲外防止も兼ねる)。
  // biome-ignore lint/correctness/useExhaustiveDependencies: クエリ変化で選択を先頭へ戻すトリガ依存 (effect 内では参照しない)
  useEffect(() => {
    setActiveIndex(0);
    setExpanded(false);
  }, [deferredQuery]);

  // アクティブ候補が画面外なら追従スクロール。
  useEffect(() => {
    const active = flat[activeIndex];
    if (!active) return;
    itemRefs.current.get(active.item.id)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, flat]);

  // 行は memo されているので、ハンドラは参照が変わらないよう最新値を ref 経由で読む。
  const latest = useRef({ flat, onClose, onSelectItem });
  latest.current = { flat, onClose, onSelectItem };

  const runAt = useCallback((index: number) => {
    const { flat: list, onClose: close, onSelectItem: select } = latest.current;
    const target = list[index]?.item;
    if (!target) return;
    // 先に閉じてから実行する。run が確認ダイアログ等を開いてもパレットが残らない。
    close();
    select?.(target);
    target.run();
  }, []);

  const activate = useCallback((index: number) => setActiveIndex(index), []);

  const registerRef = useCallback((id: string, el: HTMLButtonElement | null) => {
    if (el) itemRefs.current.set(id, el);
    else itemRefs.current.delete(id);
  }, []);

  const move = (delta: number) => {
    if (flat.length === 0) return;
    // 上限で隠れた候補があるとき、末尾から ↓ で進んだら続きを展開して次の行へ進む。
    if (delta > 0 && hiddenCount > 0 && activeIndex === flat.length - 1) {
      setExpanded(true);
      setActiveIndex(activeIndex + 1);
      return;
    }
    setActiveIndex((cur) => (cur + delta + flat.length) % flat.length);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        break;
      case "Tab":
        // Tab / Shift+Tab で候補内をループ (フォーカストラップに奪わせない)。
        e.preventDefault();
        e.stopPropagation();
        move(e.shiftKey ? -1 : 1);
        break;
      case "Home":
        if (flat.length > 0) {
          e.preventDefault();
          setActiveIndex(0);
        }
        break;
      case "End":
        if (flat.length > 0) {
          e.preventDefault();
          setActiveIndex(flat.length - 1);
        }
        break;
      case "Enter":
        e.preventDefault();
        runAt(activeIndex);
        break;
      // Escape は Modal (Dialog) の closeOnEscape に委ねる。
    }
  };

  return (
    <Modal
      // no-submit: 検索 UI。Enter が候補の決定を担う
      open onClose={onClose} width="620px" initialFocusEl={() => inputRef.current}>
      <Flex
        align="center"
        gap="2"
        px="3.5"
        borderBottomWidth="1px"
        borderBottomColor="app.border"
        bg="app.surface"
      >
        <Box color="app.textMuted" flexShrink={0} display="inline-flex">
          <Icon name="query" size={ICON_SIZES.md} />
        </Box>
        <chakra.input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("cmdkPlaceholder")}
          aria-label={t("cmdkPlaceholder")}
          role="combobox"
          aria-expanded={flat.length > 0}
          aria-controls="command-palette-list"
          aria-activedescendant={
            flat[activeIndex] ? `cmdk-item-${flat[activeIndex].item.id}` : undefined
          }
          autoComplete="off"
          spellCheck={false}
          flex="1"
          minW={0}
          py="3.5"
          bg="transparent"
          border="none"
          outline="none"
          color="app.text"
          fontSize="md"
          css={{ "&::placeholder": { color: "var(--text-muted)" } }}
        />
      </Flex>

      <MotionListBox
        ref={listRef}
        id="command-palette-list"
        role="listbox"
        maxH="min(420px, 60vh)"
        overflowY="auto"
        py="1.5"
        variants={staggerContainer(reduced)}
        initial="initial"
        animate="animate"
      >
        {flat.length === 0 ? (
          <Box px="4" py="5" textAlign="center" color="app.textMuted" fontSize="sm">
            {t("cmdkNoResults")}
          </Box>
        ) : (
          <>
            {visibleGroups.map((g) => (
              <Box key={g.group}>
                <Box px="4" pt="2" pb="1" textStyle="overline">
                  {groupLabel[g.group]}
                </Box>
                {g.items.map(({ scored, flatIndex }) => (
                  <CommandRow
                    key={scored.item.id}
                    scored={scored}
                    index={flatIndex}
                    active={flatIndex === activeIndex}
                    animateEntrance={shouldStaggerEntrance(flatIndex)}
                    highlightId={highlightId}
                    registerRef={registerRef}
                    onActivate={activate}
                    onRun={runAt}
                  />
                ))}
              </Box>
            ))}
            {hiddenCount > 0 && (
              <chakra.button
                type="button"
                tabIndex={-1}
                onClick={() => {
                  setExpanded(true);
                  inputRef.current?.focus();
                }}
                display="block"
                w="100%"
                px="4"
                py="2"
                border="none"
                bg="transparent"
                cursor="pointer"
                textAlign="left"
                fontSize="xs"
                color="app.textMuted"
                _hover={{ bg: "app.hover", color: "app.text" }}
              >
                {t("cmdkShowMore", { count: hiddenCount })}
              </chakra.button>
            )}
          </>
        )}
      </MotionListBox>

      <Flex
        align="center"
        gap="3"
        px="4"
        py="2"
        borderTopWidth="1px"
        borderTopColor="app.border"
        bg="app.toolbar"
        fontSize="xs"
        color="app.textMuted"
        flexWrap="wrap"
      >
        <Hint keys="↑ ↓" label={t("cmdkHintMove")} />
        <Hint keys="↵" label={t("cmdkHintSelect")} />
        <Hint keys="Esc" label={t("cmdkHintClose")} />
      </Flex>
    </Modal>
  );
}

function Hint({ keys, label }: { keys: string; label: string }) {
  return (
    <Flex align="center" gap="1.5">
      <Kbd>{keys}</Kbd>
      <chakra.span>{label}</chakra.span>
    </Flex>
  );
}

interface CommandRowProps {
  scored: ScoredItem;
  /** 表示順の添字 (`limitAndIndexGroups` が事前計算)。 */
  index: number;
  active: boolean;
  /** 結果グループのスタッガー出現 (#976) の対象か。上限を超えた行は即時表示。 */
  animateEntrance: boolean;
  /** アクティブ行のハイライトを滑らせる共有 `layoutId` (#976、`CommandPalette` 発行)。 */
  highlightId: string;
  /** 参照の安定したコールバック (行を memo するため、index は行が自分で渡す)。 */
  registerRef: (id: string, el: HTMLButtonElement | null) => void;
  onActivate: (index: number) => void;
  onRun: (index: number) => void;
}

/** memo 済みの行 (#1320)。↑↓ では前後のアクティブ行 2 つだけが再レンダーされる。 */
const CommandRow = memo(function CommandRow({
  scored,
  index,
  active,
  animateEntrance,
  highlightId,
  registerRef,
  onActivate,
  onRun,
}: CommandRowProps) {
  const { item, ranges } = scored;
  const labelSegments = useMemo(() => splitLabel(item.label, ranges), [item.label, ranges]);
  const ref = useCallback(
    (el: HTMLButtonElement | null) => registerRef(item.id, el),
    [registerRef, item.id],
  );
  const onMouseMove = useCallback(() => {
    if (!active) onActivate(index);
  }, [active, onActivate, index]);
  const onClick = useCallback(() => onRun(index), [onRun, index]);
  return (
    <MotionRow
      ref={ref}
      type="button"
      id={`cmdk-item-${item.id}`}
      role="option"
      aria-selected={active}
      tabIndex={-1}
      onMouseMove={onMouseMove}
      onClick={onClick}
      variants={animateEntrance ? variants.staggerItem : undefined}
      position="relative"
      display="block"
      w="100%"
      textAlign="left"
      px="4"
      py="2"
      border="none"
      cursor="pointer"
      bg="transparent"
      color="app.text"
      css={{ scrollMarginBlock: "8px" }}
    >
      {/* アクティブ行の背後を滑らせるハイライト (#976)。`bg` を行ごとに切り替える
          代わりに、単一の layoutId 要素をアクティブ行の内側だけへマウントすることで、
          ↑/↓ 移動のたびに Motion がこの要素の前回位置 → 新しい位置への layout
          アニメーションを自動計算する (`TabBar` のアクティブインジケータと同じ手法)。
          reduced-motion は MotionConfig が自動で瞬時化する。 */}
      {active && (
        <MotionHighlight
          layoutId={highlightId}
          transition={transitions.emphasized}
          position="absolute"
          inset="0"
          bg="app.active"
          zIndex={0}
          pointerEvents="none"
          aria-hidden
        />
      )}
      <Flex position="relative" zIndex={1} align="center" gap="2" w="100%">
        {item.icon && (
          <Box color="app.textMuted" flexShrink={0} display="inline-flex">
            <Icon name={item.icon} size={ICON_SIZES.md} />
          </Box>
        )}
        <Flex direction="column" minW={0} flex="1" gap="0.25">
          <chakra.span
            fontSize="sm"
            overflow="hidden"
            textOverflow="ellipsis"
            whiteSpace="nowrap"
            fontFamily={item.group === "history" ? "var(--font-mono)" : undefined}
          >
            {labelSegments.map((seg, i) =>
              seg.highlighted ? (
                <chakra.span key={i} color="app.accent" fontWeight={700}>
                  {seg.text}
                </chakra.span>
              ) : (
                <span key={i}>{seg.text}</span>
              ),
            )}
          </chakra.span>
          {item.sublabel && (
            <chakra.span
              fontSize="xs"
              color="app.textMuted"
              overflow="hidden"
              textOverflow="ellipsis"
              whiteSpace="nowrap"
            >
              {item.sublabel}
            </chakra.span>
          )}
        </Flex>
        {item.shortcut && (
          <Kbd tone="muted" flexShrink={0} color="app.textMuted">
            {item.shortcut}
          </Kbd>
        )}
        {item.badges && item.badges.length > 0 && (
          <Flex gap="1" flexShrink={0}>
            {item.badges.map((badge) => (
              <Badge key={badge}>{badge}</Badge>
            ))}
          </Flex>
        )}
      </Flex>
    </MotionRow>
  );
});

function Badge({ children }: { children: ReactNode }) {
  return (
    <chakra.span
      textStyle="overline"
      px="1.5"
      py="0.25"
      borderRadius="pill"
      borderWidth="1px"
      borderColor="app.border"
      bg="app.surface"
      whiteSpace="nowrap"
    >
      {children}
    </chakra.span>
  );
}
