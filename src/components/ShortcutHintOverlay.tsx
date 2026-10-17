import { useEffect, useMemo, useRef, useState } from "react";
import { Box, chakra, Flex, Grid } from "@chakra-ui/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useT } from "../i18n";
import { transitions, variants } from "../motion";
import { useSettings } from "../settings";
import { classifyFocus, hintContextFor, buildShortcutHints, MAX_HINT_ITEMS } from "../shortcutHint";
import type { HeldModifiers, HintContext } from "../shortcutHint";
import { SHORTCUT_CATEGORY_LABEL, SHORTCUT_CATEGORY_ORDER, resolveShortcutBindings } from "../shortcuts";
import { Kbd } from "./Kbd";

/**
 * 修飾キー (Cmd/Ctrl) 長押しで出すショートカットヒント (which-key 風, #1487)。
 *
 * - 表示専用。keydown / keyup は capture で**聞くだけ**で、`preventDefault` も伝播停止もしない
 *   (既存のショートカット発火・テキスト入力を阻害しない)。
 * - 修飾キーを `delayMs` 押し続けたときだけ出る。待機中に別のキーが押されたら (= 普通の
 *   ショートカット入力) 出さない。離す / Esc / ポインタ操作 / ウィンドウのフォーカス喪失で閉じる。
 * - IME 変換中 (`isComposing` / `keyCode 229` / composition イベント) は反応しない。
 *   CodeMirror 以外のテキスト入力にフォーカスがあるときも出さない。
 * - 一覧は `shortcutHint.ts` が `shortcuts.ts` の単一ソース + 再割り当て反映済みバインドから作る。
 * - 出現 / 消滅は `variants.fade`。`prefers-reduced-motion` では即時 (duration 0)。
 */
interface Props {
  /** ER 図などの全画面サーフェス表示中 / 未接続 (エディタ文脈が無い)。 */
  surface: boolean;
  /** モーダル / 全画面ビューが前面にあるか。真の間は出さない。 */
  isBlocked: () => boolean;
}

const MODIFIER_KEYS = new Set(["Control", "Meta", "Shift", "Alt", "AltGraph", "CapsLock", "OS"]);

export function ShortcutHintOverlay({ surface, isBlocked }: Props) {
  const t = useT();
  const settings = useSettings();
  const reducedMotion = useReducedMotion() ?? false;
  const bindings = useMemo(
    () => resolveShortcutBindings(settings.shortcutOverrides),
    [settings.shortcutOverrides],
  );
  const [shown, setShown] = useState<{ context: HintContext; held: HeldModifiers } | null>(null);

  // リスナは一度だけ張り、最新の props は ref 越しに読む (タイマー再起動を避ける)。
  const surfaceRef = useRef(surface);
  surfaceRef.current = surface;
  const blockedRef = useRef(isBlocked);
  blockedRef.current = isBlocked;

  const { shortcutHintEnabled: enabled, shortcutHintDelayMs: delayMs } = settings;
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let composing = false;
    let visible = false;
    let held: HeldModifiers = { shift: false, alt: false };

    const contextNow = (): HintContext | null => {
      const kind = classifyFocus(document.activeElement);
      if (kind === "text") return null;
      return hintContextFor(kind, surfaceRef.current);
    };
    const cancel = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const hide = () => {
      cancel();
      held = { shift: false, alt: false };
      if (visible) {
        visible = false;
        setShown(null);
      }
    };
    const show = () => {
      timer = null;
      if (composing || blockedRef.current() || !document.hasFocus()) return;
      // ref に載らないダイアログ (個別の Dialog など) が開いていれば出さない。
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const context = contextNow();
      if (context === null) return;
      visible = true;
      setShown({ context, held });
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229 || e.key === "Process") {
        hide();
        return;
      }
      if (e.key === "Control" || e.key === "Meta") {
        // 長押しの自動リピートでは再起動しない。
        if (e.repeat || visible || timer !== null) return;
        held = { shift: e.shiftKey, alt: e.altKey };
        timer = setTimeout(show, delayMs);
        return;
      }
      // AltGr (Windows では Ctrl+Alt として届く) は文字入力なので出さない。
      if (e.key === "AltGraph" || e.getModifierState?.("AltGraph")) {
        hide();
        return;
      }
      if (e.key === "Shift" || e.key === "Alt") {
        held = { shift: e.shiftKey, alt: e.altKey };
        if (visible) {
          const context = contextNow();
          if (context === null) hide();
          else setShown({ context, held });
        }
        return;
      }
      if (MODIFIER_KEYS.has(e.key)) return;
      // 実キーが押された = 普通のショートカット入力 / Esc。待機中なら出さず、表示中なら閉じる。
      hide();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Control" || e.key === "Meta") {
        if (!e.ctrlKey && !e.metaKey) hide();
        return;
      }
      if (e.key === "Shift" || e.key === "Alt") {
        held = { shift: e.shiftKey, alt: e.altKey };
        if (visible) {
          const context = contextNow();
          if (context !== null) setShown({ context, held });
        }
      }
    };
    const onCompositionStart = () => {
      composing = true;
      hide();
    };
    const onCompositionEnd = () => {
      composing = false;
    };
    const onFocusIn = () => {
      if (!visible) return;
      const context = contextNow();
      if (context === null) hide();
      else setShown({ context, held });
    };
    // keyup を取りこぼした (他ウィンドウで離した等) ときのフォールバック。
    const onPointerMove = (e: PointerEvent) => {
      if (!e.ctrlKey && !e.metaKey) hide();
    };
    const onBlur = () => {
      composing = false;
      hide();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") hide();
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerdown", hide, true);
    window.addEventListener("wheel", hide, { capture: true, passive: true });
    document.addEventListener("compositionstart", onCompositionStart, true);
    document.addEventListener("compositionend", onCompositionEnd, true);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      hide();
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerdown", hide, true);
      window.removeEventListener("wheel", hide, true);
      document.removeEventListener("compositionstart", onCompositionStart, true);
      document.removeEventListener("compositionend", onCompositionEnd, true);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, delayMs]);

  const items = useMemo(
    () => (shown ? buildShortcutHints(shown.context, bindings, shown.held, t) : []),
    [shown, bindings, t],
  );
  const visibleItems = items.slice(0, MAX_HINT_ITEMS);
  const hiddenCount = items.length - visibleItems.length;

  return (
    <AnimatePresence initial={false}>
      {shown && items.length > 0 && (
        <motion.div
          key="shortcut-hint"
          // 画面下部の中央。操作を妨げないようポインタを素通しにする。
          style={{
            position: "fixed",
            left: 0,
            right: 0,
            bottom: "var(--space-4)",
            zIndex: "var(--z-popover)",
            display: "flex",
            justifyContent: "center",
            pointerEvents: "none",
            paddingInline: "var(--space-4)",
          }}
          initial={variants.fade.initial}
          animate={variants.fade.animate}
          exit={variants.fade.exit}
          transition={reducedMotion ? { duration: 0 } : transitions.fade}
        >
          <Box
            data-testid="shortcut-hint-overlay"
            aria-hidden="true"
            w="min(960px, 100%)"
            px="4"
            py="3"
            borderRadius="md"
            bg="app.surface"
            borderWidth="1px"
            borderColor="app.border"
            boxShadow="elevationPopover"
            color="app.text"
            fontSize="sm"
          >
            <Flex direction="column" gap="2.5">
              {SHORTCUT_CATEGORY_ORDER.map((category) => {
                const group = visibleItems.filter((i) => i.category === category);
                if (group.length === 0) return null;
                return (
                  <Box key={category} minW="0">
                    <Box pb="1" textStyle="overline">
                      {t(SHORTCUT_CATEGORY_LABEL[category])}
                    </Box>
                    <Grid templateColumns="repeat(auto-fill, minmax(220px, 1fr))" columnGap="5" rowGap="1">
                      {group.map((i) => (
                        <Flex key={i.key} align="center" justify="space-between" gap="2" minW="0">
                          {/* 説明文は長いので 1 行に収めて切り詰める (全文はチートシートで読める)。 */}
                          <chakra.span color="app.textSecondary" truncate>
                            {i.label}
                          </chakra.span>
                          <Kbd flexShrink={0} splitCombo>
                            {i.keys}
                          </Kbd>
                        </Flex>
                      ))}
                    </Grid>
                  </Box>
                );
              })}
            </Flex>
            {hiddenCount > 0 && (
              <Box pt="2" textStyle="caption">
                {t("shortcutHintMore", { count: hiddenCount })}
              </Box>
            )}
          </Box>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
