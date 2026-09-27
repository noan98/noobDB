/**
 * `ListboxSelect` — 自由入力なしの単純選択用の共有 listbox セレクタ (#1143)。
 *
 * `src/components/ui.tsx` の `Select` (素のネイティブ `<select>`) は
 * webkit2gtk (Tauri/Linux) では GTK がポップアップを描画するため、アプリの
 * ダーク/アクセント配色・角丸・enter アニメーションに追従しない。
 * `ComboSelect.tsx` (portal + `transitions.enter` の WAI-ARIA listbox
 * ポップオーバー) と同じ基盤を、自由入力を持たない「候補から 1 つを選ぶ」
 * 用途向けに提供する。
 *
 * WAI-ARIA は APG の "Collapsible Dropdown Listbox" (select-only combobox)
 * パターン: トリガーは `role="combobox"` の `<button>`、開くと
 * `role="listbox"` のポップオーバーを `aria-controls` で結び、選択中の候補は
 * `aria-activedescendant` で示す。キーボードは ↑↓ でハイライト移動 (端で
 * ループ)、Home/End で先頭/末尾、Enter/Space で確定、Esc で選択せず閉じる、
 * 印字可能な文字入力で前方一致ジャンプ (ネイティブ select の型入力に相当) を
 * 行う。判定ロジックは `listboxNav.ts` に切り出し純粋にテストする。
 *
 * ポップオーバーの位置決め・モーション (`transitions.enter`) は `ComboSelect`
 * と同じ流儀 (`document.body` へ portal、`MENU_MARGIN` で余白を揃える) を
 * そのまま踏襲し、二重実装を避ける。
 *
 * 全面移行は 1 PR で強制しない (#1143) — まず `PaginationBar` など目立つ箇所
 * から段階的に置き換える。
 */
import { type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Box, chakra, type SystemStyleObject } from "@chakra-ui/react";
import { motion } from "motion/react";
import { transitions } from "../motion";
import { Icon, ICON_SIZES } from "./Icon";
import { MENU_MARGIN } from "./menuPosition";
import {
  appendTypeaheadKey,
  computeListboxMove,
  findTypeaheadIndex,
  isTypeaheadKey,
  type TypeaheadState,
} from "./listboxNav";

export interface ListboxSelectOption {
  value: string;
  /** 候補行に表示するラベル。省略時は `value` をそのまま使う。 */
  label?: ReactNode;
  /** 型入力ジャンプ・トリガーの表示テキストに使う検索用文字列。省略時は
   *  `value` を使う (`label` が ReactNode で文字列化できない場合に指定する)。 */
  searchText?: string;
}

export interface ListboxSelectProps {
  value: string;
  options: readonly ListboxSelectOption[];
  onChange: (v: string) => void;
  id?: string;
  disabled?: boolean;
  /** トリガーに紐づく非可視ラベル (`FieldLabel` 等で可視ラベルがある場合は省略可)。 */
  ariaLabel?: string;
  /** 一致する候補が無いときにトリガーへ表示する文言。 */
  placeholder?: string;
  /** トリガー要素へ適用する追加 Chakra css。 */
  css?: SystemStyleObject;
}

const MotionListbox = chakra(motion.div, {}, { forwardProps: ["transition"] });

/** ポップオーバーと入力欄の間の隙間 (px)。`ComboSelect` と揃える。 */
const POPOVER_GAP = 4;

function optionElementId(listboxId: string, index: number): string {
  return `${listboxId}-opt-${index}`;
}

function labelText(opt: ListboxSelectOption): string {
  return opt.searchText ?? (typeof opt.label === "string" ? opt.label : opt.value);
}

export function ListboxSelect({
  value,
  options,
  onChange,
  id,
  disabled,
  ariaLabel,
  placeholder,
  css,
}: ListboxSelectProps) {
  const autoId = useId();
  const triggerId = id ?? autoId;
  const listboxId = useId();

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listboxRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef(new Map<number, HTMLButtonElement>());
  const typeaheadRef = useRef<TypeaheadState | null>(null);

  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState<number | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);

  const selectedIndex = useMemo(
    () => options.findIndex((o) => o.value === value),
    [options, value],
  );
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const labels = useMemo(() => options.map(labelText), [options]);

  const openListbox = () => {
    if (disabled) return;
    setHighlighted(selectedIndex >= 0 ? selectedIndex : options.length > 0 ? 0 : null);
    setOpen(true);
  };

  const closeListbox = () => {
    setOpen(false);
    setHighlighted(null);
  };

  const selectOption = (index: number) => {
    const opt = options[index];
    if (!opt) return;
    onChange(opt.value);
    closeListbox();
    triggerRef.current?.focus();
  };

  // 開いたとき / 候補数が変わったときにポップオーバーの位置を測り直す
  // (`ComboSelect` と同じ「測定 → フリップ → クランプ」の流れ)。
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const triggerEl = triggerRef.current;
    const listEl = listboxRef.current;
    if (!triggerEl || !listEl) return;
    const anchor = triggerEl.getBoundingClientRect();
    const { height } = listEl.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    let top = anchor.bottom + POPOVER_GAP;
    if (top + height + MENU_MARGIN > viewportH) {
      top = anchor.top - POPOVER_GAP - height;
    }
    top = Math.min(
      Math.max(top, MENU_MARGIN),
      Math.max(MENU_MARGIN, viewportH - height - MENU_MARGIN),
    );
    const left = Math.min(
      Math.max(anchor.left, MENU_MARGIN),
      Math.max(MENU_MARGIN, viewportW - anchor.width - MENU_MARGIN),
    );
    setPos({ left, top, width: anchor.width });
  }, [open, options.length]);

  // ハイライト移動時に、はみ出していればスクロールして見えるようにする。
  useEffect(() => {
    if (highlighted === null) return;
    optionRefs.current.get(highlighted)?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  const handleTriggerKeyDown: React.KeyboardEventHandler<HTMLButtonElement> = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        openListbox();
        return;
      }
      setHighlighted((prev) => computeListboxMove(e.key as "ArrowDown" | "ArrowUp", prev, options.length));
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      if (!open) return;
      e.preventDefault();
      setHighlighted((prev) => computeListboxMove(e.key as "Home" | "End", prev, options.length));
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (!open) {
        openListbox();
        return;
      }
      if (highlighted !== null) selectOption(highlighted);
      return;
    }
    if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        closeListbox();
      }
      return;
    }
    if (e.key === "Tab") {
      // ブラウザ既定のフォーカス移動に任せる (blur が閉じる処理を行う)。
      return;
    }
    if (isTypeaheadKey(e)) {
      e.preventDefault();
      const next = appendTypeaheadKey(typeaheadRef.current, e.key, Date.now());
      typeaheadRef.current = next;
      const base = open ? highlighted : selectedIndex >= 0 ? selectedIndex : null;
      const match = findTypeaheadIndex(labels, next.query, base);
      if (match !== null) {
        if (open) {
          setHighlighted(match);
        } else {
          onChange(options[match].value);
        }
      }
    }
  };

  const activeDescendant =
    open && highlighted !== null ? optionElementId(listboxId, highlighted) : undefined;

  return (
    <>
      <chakra.button
        ref={triggerRef}
        id={triggerId}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={activeDescendant}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => (open ? closeListbox() : openListbox())}
        onBlur={closeListbox}
        onKeyDown={handleTriggerKeyDown}
        display="inline-flex"
        alignItems="center"
        justifyContent="space-between"
        gap="1.5"
        font="inherit"
        px="var(--field-px)"
        py="var(--control-py)"
        border="1px solid"
        borderColor="app.borderStrong"
        bg="app.bgInput"
        color="app.text"
        borderRadius="md"
        cursor={disabled ? "not-allowed" : "pointer"}
        opacity={disabled ? 0.5 : 1}
        // ネイティブ select (`selectRecipe`) と同じフォーカス表示 (枠のアクセント色 + --focus-ring)。
        _focusVisible={{ outline: "none", borderColor: "app.accent", boxShadow: "var(--focus-ring)" }}
        css={css}
      >
        <chakra.span flex="1" minW="0" overflow="hidden" whiteSpace="nowrap" textAlign="left" css={{ textOverflow: "ellipsis" }}>
          {selectedOption ? selectedOption.label ?? selectedOption.value : placeholder}
        </chakra.span>
        <Box flexShrink={0} color="app.textMuted" aria-hidden>
          <Icon name="chevron-down" size={ICON_SIZES.sm} />
        </Box>
      </chakra.button>
      {open &&
        createPortal(
          <MotionListbox
            ref={listboxRef}
            id={listboxId}
            role="listbox"
            aria-label={ariaLabel}
            position="fixed"
            zIndex="var(--z-popover)"
            maxH="260px"
            overflowY="auto"
            bg="var(--bg-elevated)"
            border="1px solid var(--border-strong)"
            borderRadius="var(--radius-md)"
            boxShadow="var(--elevation-popover)"
            py="1"
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={transitions.enter}
            style={{
              left: pos?.left ?? 0,
              top: pos?.top ?? 0,
              width: pos?.width,
              visibility: pos ? "visible" : "hidden",
            }}
            // リスト内でのクリックはトリガーの blur (= closeListbox) を起こさせない。
            // これにより「先に閉じて選択を取りこぼす」競合を避ける (ComboSelect と同じ)。
            onMouseDown={(e) => e.preventDefault()}
          >
            {options.map((opt, i) => {
              const isHighlighted = highlighted === i;
              const isSelected = i === selectedIndex;
              return (
                <chakra.button
                  key={`${opt.value}::${i}`}
                  ref={(el: HTMLButtonElement | null) => {
                    if (el) optionRefs.current.set(i, el);
                    else optionRefs.current.delete(i);
                  }}
                  id={optionElementId(listboxId, i)}
                  role="option"
                  aria-selected={isSelected}
                  // フォーカスはトリガーに残し aria-activedescendant で示すので、候補は Tab 順に入れない。
                  tabIndex={-1}
                  type="button"
                  display="flex"
                  alignItems="center"
                  gap="2"
                  width="100%"
                  textAlign="left"
                  bg={isHighlighted ? "var(--bg-hover)" : "transparent"}
                  border="none"
                  px="2.5"
                  py="1.5"
                  fontSize="var(--text-md)"
                  color="var(--text)"
                  cursor="pointer"
                  borderRadius="var(--radius-sm)"
                  transitionProperty="background"
                  transitionDuration="var(--dur-fast)"
                  transitionTimingFunction="var(--ease)"
                  onMouseEnter={() => setHighlighted(i)}
                  onClick={() => selectOption(i)}
                >
                  <Box flexShrink={0} w="14px" opacity={isSelected ? 1 : 0} aria-hidden>
                    <Icon name="check" size={ICON_SIZES.sm} />
                  </Box>
                  <chakra.span flex="1" minW="0" overflow="hidden" whiteSpace="nowrap" css={{ textOverflow: "ellipsis" }}>
                    {opt.label ?? opt.value}
                  </chakra.span>
                </chakra.button>
              );
            })}
          </MotionListbox>,
          document.body,
        )}
    </>
  );
}
