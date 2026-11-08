import { useRef, type KeyboardEvent } from "react";
import { chakra } from "@chakra-ui/react";
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from "motion/react";
import { transitions, variants } from "../motion";
import { stepChipIndex } from "./enumTypeSql";

/**
 * ENUM の値を並び順どおりに見せるチップ列 (#2158)。
 *
 * - 既存の値は角丸のチップ。クリック / 矢印キーで基準値 (追加の BEFORE / AFTER、名前変更の対象) を選べる
 *   (`radiogroup`。選択は呼び出し側の Select と双方向に同期する)。
 * - 追加では、新しい値を `ghost` の位置に破線枠のゴーストチップとして差し込む。位置を変えると周りのチップが
 *   `layout` で滑って詰め直す。
 * - 名前変更では、対象のチップを旧名から新名へクロスフェードする (`renamed`)。
 *
 * reduced-motion では `MotionConfig` が layout の移動を止め、opacity の補間も `useReducedMotion()` で即時化する。
 */

const Chip = chakra("button", {
  base: {
    display: "inline-flex",
    alignItems: "center",
    px: "2.5",
    py: "0.5",
    borderRadius: "pill",
    border: "1px solid",
    borderColor: "app.border",
    background: "app.surfaceMuted",
    color: "app.text",
    fontFamily: "mono",
    fontSize: "sm",
    lineHeight: "var(--leading-normal)",
    cursor: "pointer",
    transitionProperty: "background, border-color, color",
    transitionDuration: "var(--dur-fast)",
    transitionTimingFunction: "var(--ease)",
    _hover: { background: "app.hover" },
    _focusVisible: { outline: "none", boxShadow: "var(--focus-ring)" },
    "&[aria-checked=true]": { borderColor: "app.accent", background: "app.accentHighlight" },
    _disabled: { cursor: "default", opacity: 0.6 },
  },
});

const GhostChip = chakra("span", {
  base: {
    display: "inline-flex",
    alignItems: "center",
    px: "2.5",
    py: "0.5",
    borderRadius: "pill",
    border: "1px dashed",
    borderColor: "app.accent",
    color: "app.accent",
    fontFamily: "mono",
    fontSize: "sm",
    lineHeight: "var(--leading-normal)",
  },
});

const MotionItem = chakra(
  motion.span,
  {},
  { forwardProps: ["layout", "variants", "initial", "animate", "exit", "transition"] },
);
const MotionLabel = chakra(
  motion.span,
  {},
  { forwardProps: ["variants", "initial", "animate", "exit", "transition"] },
);

interface Props {
  /** 既存の値 (並び順どおり)。 */
  values: readonly string[];
  /** 追加する値の差し込み位置 (`ghostInsertIndex`) と表示ラベル。追加モード以外は null。 */
  ghost: { index: number; label: string } | null;
  /** 名前変更の対象。`to` が空のあいだは旧名のまま。名前変更モード以外は null。 */
  renamed: { from: string; to: string } | null;
  /** 選択中の値 (BEFORE / AFTER の基準、または名前変更の対象)。未選択は null。 */
  selected: string | null;
  onSelect: (value: string) => void;
  disabled?: boolean;
  ariaLabel: string;
}

export function EnumValueChips({ values, ghost, renamed, selected, onSelect, disabled, ariaLabel }: Props) {
  const reduced = useReducedMotion() ?? false;
  const groupRef = useRef<HTMLDivElement>(null);
  const tabbable = selected !== null && values.includes(selected) ? selected : (values[0] ?? null);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = stepChipIndex(values.length, index, e.key);
    if (next === null) return;
    e.preventDefault();
    if (disabled) return;
    onSelect(values[next]);
    groupRef.current?.querySelector<HTMLElement>(`[data-chip-index="${next}"]`)?.focus();
  };

  const items = values.map((v, i) => {
    const isRenamed = renamed !== null && renamed.from === v;
    const showNew = isRenamed && renamed.to !== "";
    return (
      <MotionItem key={`v:${v}`} layout="position" data-chip-kind="existing">
        <Chip
          type="button"
          role="radio"
          aria-checked={selected === v}
          aria-label={v === "" ? undefined : v}
          tabIndex={v === tabbable ? 0 : -1}
          data-chip-index={i}
          disabled={disabled}
          onClick={() => onSelect(v)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {isRenamed ? (
            <AnimatePresence mode="wait" initial={false}>
              <MotionLabel
                key={showNew ? "new" : "old"}
                variants={variants.fade}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={reduced ? { duration: 0 } : transitions.crossfade}
                data-chip-label={showNew ? "new" : "old"}
              >
                {showNew ? renamed.to : v}
              </MotionLabel>
            </AnimatePresence>
          ) : (
            v
          )}
        </Chip>
      </MotionItem>
    );
  });

  if (ghost) {
    const ghostItem = (
      <MotionItem
        key="ghost"
        layout="position"
        variants={variants.fade}
        initial="initial"
        animate="animate"
        exit="exit"
        data-chip-kind="ghost"
      >
        <GhostChip aria-hidden="true">{ghost.label}</GhostChip>
      </MotionItem>
    );
    items.splice(Math.min(Math.max(ghost.index, 0), items.length), 0, ghostItem);
  }

  return (
    <MotionConfig transition={reduced ? { duration: 0 } : transitions.layout}>
      <chakra.div
        ref={groupRef}
        role="radiogroup"
        aria-label={ariaLabel}
        display="flex"
        flexWrap="wrap"
        alignItems="center"
        gap="1.5"
      >
        <AnimatePresence initial={false}>{items}</AnimatePresence>
      </chakra.div>
    </MotionConfig>
  );
}
