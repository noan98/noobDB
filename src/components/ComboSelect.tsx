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
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Box, chakra, type SystemStyleObject } from "@chakra-ui/react";
import { motion } from "motion/react";
import { transitions } from "../motion";
import { semanticColorVar } from "../semanticColors";
import { Icon, ICON_SIZES } from "./Icon";
import { rankComboOptions } from "./comboRank";
import { MENU_MARGIN } from "./menuPosition";
import { isImeComposing } from "./modalKeys";

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
  /** 候補が `COMBO_MAX_VISIBLE` を超えたときの「さらに表示」ボタンの文言 (残り件数を受ける)。 */
  showMoreText?: (hiddenCount: number) => string;
}

const MotionListbox = chakra(motion.div, {}, { forwardProps: ["transition"] });

/** ポップオーバーと入力欄の間の隙間 (px)。 */
const POPOVER_GAP = 4;

/** これを超える候補数では、マウスのハイライトを state ではなく CSS の `:hover` で表す (#1321)。 */
export const COMBO_CSS_HOVER_THRESHOLD = 50;

/** 一度に描画する候補の上限。超えた分は「さらに表示」で展開する (2000 列のテーブルでも開く/入力のたびに全件を作らない)。 */
export const COMBO_MAX_VISIBLE = 200;

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

interface ComboRowProps {
  opt: ComboSelectOption;
  index: number;
  listboxId: string;
  isHighlighted: boolean;
  isSelected: boolean;
  cssHover: boolean;
  optionRefs: React.MutableRefObject<Map<number, HTMLButtonElement>>;
  onHover: (i: number) => void;
  onSelect: (opt: ComboSelectOption) => void;
}

/** 候補 1 行。ハイライトが動いた行だけ再描画されるよう memo 化する (CommandPalette の CommandRow と同じ手法)。 */
const ComboRow = memo(function ComboRow({
  opt,
  index,
  listboxId,
  isHighlighted,
  isSelected,
  cssHover,
  optionRefs,
  onHover,
  onSelect,
}: ComboRowProps) {
  const setRef = useCallback(
    (el: HTMLButtonElement | null) => {
      if (el) optionRefs.current.set(index, el);
      else optionRefs.current.delete(index);
    },
    [optionRefs, index],
  );
  return (
    <chakra.button
      ref={setRef}
      id={optionElementId(listboxId, index)}
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
      // 候補が多いときは hover を CSS に任せ、行を通過するたびの state 更新
      // (= 全候補の再レンダー) を避ける (#1321)。
      _hover={cssHover ? { bg: "var(--bg-hover)" } : undefined}
      onMouseEnter={cssHover ? undefined : () => onHover(index)}
      onClick={() => onSelect(opt)}
    >
      <Box flexShrink={0} w="14px" opacity={isSelected ? 1 : 0} aria-hidden>
        <Icon name="check" size={ICON_SIZES.sm} />
      </Box>
      <chakra.span flex="1" minW="0" overflow="hidden" whiteSpace="nowrap" css={{ textOverflow: "ellipsis" }}>
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
});

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
  showMoreText,
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

  // 絞り込み語。利用者が打鍵したときだけ入る (null = 打鍵していない)。フォーカスや
  // ArrowDown で開いた直後は、値が入っていても全候補を出す (選択済みは aria-selected
  // とチェックで示す)。
  const [query, setQuery] = useState<string | null>(null);

  const matches = useMemo(() => {
    const needle = (query ?? "").trim();
    if (!needle) return options;
    // 完全一致 → 前方一致 → 単語境界 → 部分一致の順 (#1631)。
    return rankComboOptions(options, needle);
  }, [options, query]);
  // 件数上限。「さらに表示」で展開したら、入力が変わる / 閉じるまで全件を出す
  // (畳むのは入力の onChange と閉じる処理の中で行う)。
  const [expanded, setExpanded] = useState(false);
  const filtered = useMemo(
    () => (expanded || matches.length <= COMBO_MAX_VISIBLE ? matches : matches.slice(0, COMBO_MAX_VISIBLE)),
    [matches, expanded],
  );
  const hiddenCount = matches.length - filtered.length;
  // キーボードで辿れる行数。「さらに表示」行があれば末尾に 1 行足す。
  const moreIndex = hiddenCount > 0 ? filtered.length : -1;
  const navCount = filtered.length + (hiddenCount > 0 ? 1 : 0);

  // フィルタで候補数が減ってハイライトが範囲外になったら先頭 (0 件なら null) へ戻す。
  useEffect(() => {
    setHighlighted((prev) => {
      if (prev === null) return prev;
      if (prev < navCount) return prev;
      return navCount > 0 ? 0 : null;
    });
  }, [navCount]);

  const measure = useCallback(() => {
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
    top = Math.min(Math.max(top, MENU_MARGIN), Math.max(MENU_MARGIN, viewportH - height - MENU_MARGIN));
    const left = Math.min(
      Math.max(anchor.left, MENU_MARGIN),
      Math.max(MENU_MARGIN, viewportW - anchor.width - MENU_MARGIN),
    );
    setPos((prev) =>
      prev && prev.left === left && prev.top === top && prev.width === anchor.width
        ? prev
        : { left, top, width: anchor.width },
    );
  }, []);

  // 開いたとき / 候補数が変わったときにポップオーバーの位置を測り直す
  // (`ContextMenu` と同じ「測定 → フリップ → クランプ」の流れ)。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 候補数 (filtered.length) の変化でポップオーバーを測り直すトリガ依存
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    measure();
  }, [open, filtered.length, measure]);

  // 開いている間は、祖先のスクロールやウィンドウのリサイズにも追従させる (#1534)。
  // scroll はバブリングしないので capture で拾う。候補リスト自身のスクロールでは
  // 入力欄の位置は変わらないので無視する。
  useEffect(() => {
    if (!open) return;
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && listboxRef.current?.contains(e.target)) return;
      measure();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", measure);
    };
  }, [open, measure]);

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
    setQuery(null);
    setExpanded(false);
    setHighlighted(null);
    inputRef.current?.focus();
  };

  // 行 (memo) へ渡す安定参照。最新の selectOption を ref 経由で呼ぶ。
  const selectOptionRef = useRef(selectOption);
  selectOptionRef.current = selectOption;
  const selectOptionStable = useCallback((opt: ComboSelectOption) => selectOptionRef.current(opt), []);

  const closeAndMaybeRevert = () => {
    setOpen(false);
    setQuery(null);
    setExpanded(false);
    setHighlighted(null);
    if (!freeSolo) setDraft(value);
  };

  const activeOption = open && highlighted !== null ? filtered[highlighted] : undefined;

  return (
    <>
      <chakra.input
        ref={inputRef}
        id={inputId}
        role="combobox"
        aria-expanded={open && (filtered.length > 0 || !!emptyText)}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={
          activeOption || (open && highlighted !== null && highlighted === moreIndex)
            ? optionElementId(listboxId, highlighted as number)
            : undefined
        }
        css={css}
        value={displayValue}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          commitText(e.target.value);
          setQuery(e.target.value);
          setOpen(true);
          setExpanded(false);
          setHighlighted(null);
        }}
        onBlur={closeAndMaybeRevert}
        onKeyDown={(e) => {
          // IME 変換中は候補選択・onEnter・Escape・矢印を処理しない (変換を打ち切らない)
          if (isImeComposing(e)) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!open) {
              setOpen(true);
              setHighlighted(navCount > 0 ? (e.key === "ArrowDown" ? 0 : navCount - 1) : null);
              return;
            }
            if (navCount === 0) return;
            setHighlighted((prev) => {
              const n = navCount;
              if (prev === null) return e.key === "ArrowDown" ? 0 : n - 1;
              return e.key === "ArrowDown" ? (prev + 1) % n : (prev - 1 + n) % n;
            });
            return;
          }
          if (e.key === "Enter") {
            if (open && highlighted !== null && highlighted === moreIndex) {
              e.preventDefault();
              setExpanded(true);
              return;
            }
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
              setQuery(null);
              setHighlighted(null);
            }
          }
          // Tab はブラウザ既定のフォーカス移動に任せる (blur が閉じる処理を行う)。
        }}
      />
      {open &&
        // 候補が無く文言も指定されていなければ、空のポップオーバーは出さない (自由入力の欄で邪魔になる)。
        (filtered.length > 0 || !!emptyText) &&
        createPortal(
          <MotionListbox
            ref={listboxRef}
            id={listboxId}
            role="listbox"
            position="fixed"
            zIndex="var(--z-popover)"
            // モーダル (Chakra Dialog) を開いている間は body に `pointer-events: none`
            // が付く。body 直下へ portal したリストはそれを継承し、ホイールスクロールも
            // クリックも背後のダイアログへ抜けてしまうため、明示的に受け取り直す。
            pointerEvents="auto"
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
              filtered.map((opt, i) => (
                <ComboRow
                  key={`${opt.value}::${i}`}
                  opt={opt}
                  index={i}
                  listboxId={listboxId}
                  isHighlighted={highlighted === i}
                  isSelected={opt.value === value}
                  cssHover={filtered.length > COMBO_CSS_HOVER_THRESHOLD}
                  optionRefs={optionRefs}
                  onHover={setHighlighted}
                  onSelect={selectOptionStable}
                />
              ))
            )}
            {hiddenCount > 0 && (
              <chakra.button
                id={optionElementId(listboxId, moreIndex)}
                ref={(el: HTMLButtonElement | null) => {
                  if (el) optionRefs.current.set(moreIndex, el);
                  else optionRefs.current.delete(moreIndex);
                }}
                role="option"
                aria-selected={false}
                type="button"
                display="block"
                width="100%"
                textAlign="left"
                bg={highlighted === moreIndex ? "var(--bg-hover)" : "transparent"}
                border="none"
                px="2.5"
                py="1.5"
                fontSize="var(--text-sm)"
                color="var(--text-muted)"
                cursor="pointer"
                _hover={{ bg: "var(--bg-hover)", color: "var(--text)" }}
                onClick={() => setExpanded(true)}
              >
                {showMoreText ? showMoreText(hiddenCount) : `+${hiddenCount}`}
              </chakra.button>
            )}
          </MotionListbox>,
          document.body,
        )}
    </>
  );
}
