/**
 * ポップオーバー型コンボボックス `ComboSelect`。
 *
 * `QueryBuilder` が使っていたネイティブ `<datalist>` ベースの簡易コンボボックス
 * (ブラウザ依存の見た目・弱いキーボード操作・候補行に付加情報を出せない) を置き換える
 * ための汎用部品。テキスト入力 + 下向きのポップオーバー listbox という
 * WAI-ARIA combobox (aria-activedescendant 方式) パターンで実装する。
 *
 * ## 位置決め
 *
 * ポップオーバーは `ContextMenu` (`src/components/ContextMenu.tsx`) と同じ理由 —
 * モーダル/スクロールコンテナ内でクリップされないよう — `document.body` へ
 * portal で出す。位置決めは `menuPosition.ts::computeMenuPosition` の
 * 「測定 (getBoundingClientRect) → フリップ → クランプ」という流儀を踏襲しつつ、
 * この部品専用のロジックとして実装している (`computeMenuPosition` の `rect` 分岐は
 * サブメニューを親項目の**右側**に開く用途に特化しており、コンボボックスの
 * 「入力欄の直下に開き、幅を入力欄に揃え、縦方向だけ上下反転する」という要件とは
 * 形が異なるため、直接の呼び出しではなく `MENU_MARGIN` 定数だけを共有して余白の
 * 基準を揃える)。
 *
 * ## 自由入力 (`freeSolo`)
 *
 * 既定 (`freeSolo: true`) では入力値がそのまま `onChange` に流れる、既存の
 * `QueryBuilder` 内 `ComboBox` と同じ「常に controlled」な挙動。`freeSolo: false`
 * を渡すと、候補から明示的に選択する (クリック / Enter で確定) までは
 * `onChange` を呼ばない — 入力中のテキストは内部 `draft` state にだけ反映し、
 * blur 時に確定されていなければ直前の `value` へ巻き戻す。
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Box, chakra, type SystemStyleObject } from "@chakra-ui/react";
import { motion } from "motion/react";
import { transitions } from "../motion";
import { semanticColorVar } from "../semanticColors";
import { Icon, ICON_SIZES } from "./Icon";
import { MENU_MARGIN } from "./menuPosition";

export interface ComboSelectOption {
  value: string;
  /** 候補行の右側に薄く表示する補足 (例: カラム型 "varchar(255)")。 */
  detail?: string;
  /** 候補行に表示する小バッジ (例: PK / NOT NULL / FK)。 */
  badges?: readonly { label: string; tone?: "accent" | "muted" | "warning" }[];
}

export interface ComboSelectProps {
  value: string;
  options: readonly ComboSelectOption[];
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  /** Enter で確定したときの追加ハンドラ (既存 `ComboBox` の `onEnter` 相当)。
   *  ハイライト中の候補が無い状態で Enter を押したときだけ呼ばれる — ハイライト
   *  中の候補があるときの Enter は、その候補を確定するだけで `onEnter` は呼ばない。 */
  onEnter?: () => void;
  /** 自由入力を許すか (既定 true)。true なら候補に無い値もそのまま `onChange` に
   *  流れる (常に controlled)。false なら候補から明示的に選択するまで
   *  `onChange` を呼ばず、確定されないまま blur すると直前の `value` へ戻す。 */
  freeSolo?: boolean;
  /** 入力要素へ適用する Chakra css。 */
  css?: SystemStyleObject;
  /** 候補 0 件時に表示する文言 (i18n はこのコンポーネントでは持たないため props で受ける)。 */
  emptyText?: string;
}

const MotionListbox = chakra(motion.div, {}, { forwardProps: ["transition"] });

/** ポップオーバーと入力欄の間の隙間 (px)。 */
const POPOVER_GAP = 4;

function optionElementId(listboxId: string, index: number): string {
  return `${listboxId}-opt-${index}`;
}

function badgeToneCss(tone: "accent" | "muted" | "warning" = "muted"): SystemStyleObject {
  if (tone === "accent") {
    return {
      background: "color-mix(in srgb, var(--accent) 16%, transparent)",
      color: "var(--accent)",
    };
  }
  if (tone === "warning") {
    return {
      background: semanticColorVar("warning", "subtle"),
      color: semanticColorVar("warning", "text"),
    };
  }
  return { background: "var(--bg-hover)", color: "var(--text-muted)" };
}

export function ComboSelect({
  value,
  options,
  onChange,
  placeholder,
  disabled,
  id,
  onEnter,
  freeSolo = true,
  css,
  emptyText,
}: ComboSelectProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const listboxId = useId();

  const inputRef = useRef<HTMLInputElement | null>(null);
  const listboxRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef(new Map<number, HTMLButtonElement>());

  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState<number | null>(null);
  // freeSolo=false のときだけ使う内部ドラフト。value が外部 (親からの選択反映や
  // リセット) から変わったら追従させる。
  const [draft, setDraft] = useState(value);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const displayValue = freeSolo ? value : draft;

  const filtered = useMemo(() => {
    const needle = displayValue.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((o) => o.value.toLowerCase().includes(needle));
  }, [options, displayValue]);

  // フィルタで候補数が減ってハイライトが範囲外になったら先頭 (0 件なら null) へ戻す。
  useEffect(() => {
    setHighlighted((prev) => {
      if (prev === null) return prev;
      if (prev < filtered.length) return prev;
      return filtered.length > 0 ? 0 : null;
    });
  }, [filtered.length]);

  // 開いたとき / 候補数が変わったときにポップオーバーの位置を測り直す
  // (`ContextMenu` と同じ「測定 → フリップ → クランプ」の流れ)。
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const inputEl = inputRef.current;
    const listEl = listboxRef.current;
    if (!inputEl || !listEl) return;
    const anchor = inputEl.getBoundingClientRect();
    const { height } = listEl.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    let top = anchor.bottom + POPOVER_GAP;
    if (top + height + MENU_MARGIN > viewportH) {
      // 画面下端に近ければ上側へフリップする。
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
  }, [open, filtered.length]);

  // ハイライト移動時に、はみ出していればスクロールして見えるようにする。
  useEffect(() => {
    if (highlighted === null) return;
    optionRefs.current.get(highlighted)?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  const commitText = (text: string) => {
    if (freeSolo) {
      onChange(text);
    } else {
      setDraft(text);
    }
  };

  const selectOption = (opt: ComboSelectOption) => {
    if (!freeSolo) setDraft(opt.value);
    onChange(opt.value);
    setOpen(false);
    setHighlighted(null);
    inputRef.current?.focus();
  };

  const closeAndMaybeRevert = () => {
    setOpen(false);
    setHighlighted(null);
    if (!freeSolo) setDraft(value);
  };

  const activeOption =
    open && highlighted !== null ? filtered[highlighted] : undefined;

  return (
    <>
      <chakra.input
        ref={inputRef}
        id={inputId}
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={
          activeOption ? optionElementId(listboxId, highlighted as number) : undefined
        }
        css={css}
        value={displayValue}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          commitText(e.target.value);
          setOpen(true);
          setHighlighted(null);
        }}
        onBlur={closeAndMaybeRevert}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!open) {
              setOpen(true);
              setHighlighted(filtered.length > 0 ? (e.key === "ArrowDown" ? 0 : filtered.length - 1) : null);
              return;
            }
            if (filtered.length === 0) return;
            setHighlighted((prev) => {
              const n = filtered.length;
              if (prev === null) return e.key === "ArrowDown" ? 0 : n - 1;
              return e.key === "ArrowDown" ? (prev + 1) % n : (prev - 1 + n) % n;
            });
            return;
          }
          if (e.key === "Enter") {
            if (activeOption) {
              e.preventDefault();
              selectOption(activeOption);
              return;
            }
            onEnter?.();
            return;
          }
          if (e.key === "Escape") {
            if (open) {
              e.preventDefault();
              setOpen(false);
              setHighlighted(null);
            }
          }
          // Tab はブラウザ既定のフォーカス移動に任せる (blur が閉じる処理を行う)。
        }}
      />
      {open &&
        createPortal(
          <MotionListbox
            ref={listboxRef}
            id={listboxId}
            role="listbox"
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
            // リスト内でのクリックは input の blur (= closeAndMaybeRevert) を
            // 起こさせない。これにより「先に閉じて選択を取りこぼす」競合を避ける。
            onMouseDown={(e) => e.preventDefault()}
          >
            {filtered.length === 0 ? (
              <Box px="2.5" py="1.5" fontSize="var(--text-sm)" color="var(--text-muted)">
                {emptyText}
              </Box>
            ) : (
              filtered.map((opt, i) => {
                const isHighlighted = highlighted === i;
                const isSelected = opt.value === value;
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
                    onClick={() => selectOption(opt)}
                  >
                    <Box flexShrink={0} w="14px" opacity={isSelected ? 1 : 0} aria-hidden>
                      <Icon name="check" size={ICON_SIZES.sm} />
                    </Box>
                    <chakra.span
                      flex="1"
                      minW="0"
                      overflow="hidden"
                      whiteSpace="nowrap"
                      css={{ textOverflow: "ellipsis" }}
                    >
                      {opt.value}
                    </chakra.span>
                    {opt.badges?.map((b, bi) => (
                      <chakra.span
                        key={`${b.label}-${bi}`}
                        flexShrink={0}
                        fontSize="var(--text-xs)"
                        px="1.5"
                        py="0.5"
                        borderRadius="var(--radius-pill)"
                        css={badgeToneCss(b.tone)}
                      >
                        {b.label}
                      </chakra.span>
                    ))}
                    {opt.detail && (
                      <chakra.span
                        flexShrink={0}
                        ml="2"
                        fontSize="var(--text-xs)"
                        color="var(--text-muted)"
                        fontFamily="var(--font-mono)"
                      >
                        {opt.detail}
                      </chakra.span>
                    )}
                  </chakra.button>
                );
              })
            )}
          </MotionListbox>,
          document.body,
        )}
    </>
  );
}
