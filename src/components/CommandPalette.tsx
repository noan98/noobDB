import { chakra, Box, Flex } from "@chakra-ui/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useT } from "../i18n";
import { Icon } from "./Icon";
import { Modal } from "./Modal";
import {
  flattenGroups,
  groupCommands,
  splitLabel,
  type CommandGroup,
  type CommandItem,
} from "./commandPaletteSearch";

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
 * クリック) すると `item.run()` を呼んだ直後に `onClose()` で自分を閉じる。
 */

interface CommandPaletteProps {
  items: CommandItem[];
  onClose: () => void;
}

export function CommandPalette({ items, onClose }: CommandPaletteProps) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const grouped = useMemo(() => groupCommands(items, query), [items, query]);
  const flat = useMemo(() => flattenGroups(grouped), [grouped]);

  const groupLabel: Record<CommandGroup, string> = {
    navigation: t("cmdkGroupNavigation"),
    connections: t("cmdkGroupConnections"),
    tables: t("cmdkGroupTables"),
    snippets: t("cmdkGroupSnippets"),
    history: t("cmdkGroupHistory"),
  };

  // クエリが変わって候補が並び替わるたび、選択を先頭へ戻す (範囲外防止も兼ねる)。
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // アクティブ候補が画面外なら追従スクロール。
  useEffect(() => {
    const active = flat[activeIndex];
    if (!active) return;
    itemRefs.current.get(active.item.id)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, flat]);

  const runAt = (index: number) => {
    const target = flat[index]?.item;
    if (!target) return;
    // 先に閉じてから実行する。run が確認ダイアログ等を開いてもパレットが残らない。
    onClose();
    target.run();
  };

  const move = (delta: number) => {
    if (flat.length === 0) return;
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
    <Modal open onClose={onClose} width="620px" initialFocusEl={() => inputRef.current}>
      <Flex
        align="center"
        gap="2"
        px="3.5"
        borderBottomWidth="1px"
        borderBottomColor="app.border"
        bg="app.surface"
      >
        <Box color="app.textMuted" flexShrink={0} display="inline-flex">
          <Icon name="query" size={16} />
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

      <Box
        ref={listRef}
        id="command-palette-list"
        role="listbox"
        maxH="min(420px, 60vh)"
        overflowY="auto"
        py="1.5"
      >
        {flat.length === 0 ? (
          <Box px="4" py="5" textAlign="center" color="app.textMuted" fontSize="sm">
            {t("cmdkNoResults")}
          </Box>
        ) : (
          grouped.map((g) => (
            <Box key={g.group}>
              <Box
                px="4"
                pt="2"
                pb="1"
                fontSize="xs"
                fontWeight={700}
                textTransform="uppercase"
                letterSpacing="0.06em"
                color="app.textMuted"
              >
                {groupLabel[g.group]}
              </Box>
              {g.items.map((scored) => {
                const flatIndex = flat.indexOf(scored);
                const isActive = flatIndex === activeIndex;
                return (
                  <CommandRow
                    key={scored.item.id}
                    ref={(el) => {
                      if (el) itemRefs.current.set(scored.item.id, el);
                      else itemRefs.current.delete(scored.item.id);
                    }}
                    item={scored.item}
                    labelSegments={splitLabel(scored.item.label, scored.ranges)}
                    active={isActive}
                    onMouseMove={() => {
                      if (!isActive) setActiveIndex(flatIndex);
                    }}
                    onClick={() => runAt(flatIndex)}
                  />
                );
              })}
            </Box>
          ))
        )}
      </Box>

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
      <chakra.kbd
        px="1.5"
        py="1px"
        borderRadius="sm"
        borderWidth="1px"
        borderColor="app.border"
        bg="app.surface"
        fontSize="xs"
        fontFamily="inherit"
        color="app.textSecondary"
      >
        {keys}
      </chakra.kbd>
      <chakra.span>{label}</chakra.span>
    </Flex>
  );
}

interface CommandRowProps {
  item: CommandItem;
  labelSegments: { text: string; highlighted: boolean }[];
  active: boolean;
  onMouseMove: () => void;
  onClick: () => void;
  ref?: (el: HTMLButtonElement | null) => void;
}

function CommandRow({ item, labelSegments, active, onMouseMove, onClick, ref }: CommandRowProps) {
  return (
    <chakra.button
      ref={ref}
      type="button"
      id={`cmdk-item-${item.id}`}
      role="option"
      aria-selected={active}
      tabIndex={-1}
      onMouseMove={onMouseMove}
      onClick={onClick}
      display="flex"
      alignItems="center"
      gap="2"
      w="100%"
      textAlign="left"
      px="4"
      py="2"
      border="none"
      cursor="pointer"
      bg={active ? "app.active" : "transparent"}
      color="app.text"
      css={{ scrollMarginBlock: "8px" }}
    >
      {item.icon && (
        <Box color="app.textMuted" flexShrink={0} display="inline-flex">
          <Icon name={item.icon} size={15} />
        </Box>
      )}
      <Flex direction="column" minW={0} flex="1" gap="1px">
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
      {item.badges && item.badges.length > 0 && (
        <Flex gap="1" flexShrink={0}>
          {item.badges.map((badge) => (
            <Badge key={badge}>{badge}</Badge>
          ))}
        </Flex>
      )}
    </chakra.button>
  );
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <chakra.span
      fontSize="xs"
      px="1.5"
      py="1px"
      borderRadius="pill"
      borderWidth="1px"
      borderColor="app.border"
      bg="app.surface"
      color="app.textMuted"
      textTransform="uppercase"
      letterSpacing="0.04em"
      fontWeight={600}
      whiteSpace="nowrap"
    >
      {children}
    </chakra.span>
  );
}
