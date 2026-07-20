import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import { Box, chakra } from "@chakra-ui/react";
import { Icon } from "./Icon";
import { transitions } from "../motion";
import { semanticColorToken, type SemanticRole } from "../semanticColors";

export type ToastTone = "success" | "error" | "info";

/** Toast の tone を意味色トークンの role へマップする (#664)。`error` は
 *  `danger` へ正規化する (semanticColors.ts の命名規約を参照)。 */
const TONE_ROLE: Record<ToastTone, SemanticRole> = {
  success: "success",
  error: "danger",
  info: "info",
};

/** Left accent rail + icon tint per tone。`text` 段階は全テーマプリセットで
 *  `--bg` / `--bg-elevated` 基準の AA を満たすことを themeContrast.test.ts が
 *  固定しているため、トーストのサーフェス (app.surface = --bg-elevated) 上でも
 *  安全に使える (#664。以前は app.status.* を参照していたが、こちらは
 *  「意味色」ではなく「接続/処理ステータス」向けの独立した体系のため、状態通知
 *  である Toast には success/warning/danger/info の意味色ファミリーを使う)。 */
const TONE_COLOR: Record<ToastTone, string> = {
  success: semanticColorToken(TONE_ROLE.success, "text"),
  error: semanticColorToken(TONE_ROLE.error, "text"),
  info: semanticColorToken(TONE_ROLE.info, "text"),
};

/** 取り消しなどのアクションボタン 1 つ (#676)。押すとハンドラを実行してトーストを
 *  閉じる。キーボードからも到達できる (通常の button)。 */
export interface ToastAction {
  label: string;
  onAction: () => void;
}

export interface ToastOptions {
  message: string;
  tone?: ToastTone;
  /** Auto-dismiss delay in ms. `0` keeps the toast until dismissed by hand. */
  duration?: number;
  /**
   * 任意のアクション (Undo など、#676)。指定すると本文の右にボタンを描画する。
   * アクション付きトーストは既定の表示時間を長めにして押す余裕を持たせる。
   */
  action?: ToastAction;
}

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
  action?: ToastAction;
}

interface ToastApi {
  notify: (opts: ToastOptions) => void;
  success: (message: string, duration?: number) => void;
  error: (message: string, duration?: number) => void;
  info: (message: string, duration?: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * アプリ全体の一時通知。フッターステータスバー (直近の進捗/クエリ結果を
 * 追跡するもの) とは異なり、エクスポート・インポート・ダンプ・接続・コピーなど
 * 単発操作の完了/失敗を知らせ、自動で消える用途に限定する。
 * モーダル内のバリデーションエラーや実行失敗など**持続的に表示が必要なエラー**
 * には `ErrorNote` (`modalForm.tsx`) を使い、Toast は使わないこと。
 * Motion による enter/exit を持ち、`prefers-reduced-motion` ユーザには
 * ルートの `MotionConfig` により自動的に抑制される。
 */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  // Clear any pending auto-dismiss timers if the provider unmounts so they
  // can't fire setState on a torn-down instance.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((cur) => cur.filter((tt) => tt.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const notify = useCallback(
    (opts: ToastOptions) => {
      const id = nextId++;
      const tone = opts.tone ?? "info";
      // Errors linger longer than confirmations so they can be read; toasts with
      // an action (e.g. Undo, #676) also linger so the user has time to click.
      const duration =
        opts.duration ?? (opts.action ? 8000 : tone === "error" ? 6000 : 3500);
      setToasts((cur) => [...cur, { id, message: opts.message, tone, action: opts.action }]);
      if (duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration),
        );
      }
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      notify,
      success: (message, duration) => notify({ message, tone: "success", duration }),
      error: (message, duration) => notify({ message, tone: "error", duration }),
      info: (message, duration) => notify({ message, tone: "info", duration }),
    }),
    [notify],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <Box
        position="fixed"
        bottom="4"
        right="4"
        zIndex="toast"
        display="flex"
        flexDirection="column"
        gap="2"
        maxW="min(380px, calc(100vw - 2 * var(--space-4)))"
        pointerEvents="none"
        role="region"
        aria-live="polite"
        aria-label="notifications"
      >
        <AnimatePresence initial={false}>
          {toasts.map((toast) => (
            // motion drives the enter/exit; styling lives on the inner Chakra
            // Box so motion's `transition` object isn't swallowed by Chakra's
            // `transition` style prop.
            <motion.div
              key={toast.id}
              layout
              initial={{ opacity: 0, y: 14, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 28, scale: 0.96 }}
              transition={transitions.emphasized}
            >
              <Box
                role="status"
                pointerEvents="auto"
                display="flex"
                alignItems="center"
                gap="2"
                px="3"
                py="2.5"
                borderRadius="md"
                bg="app.surface"
                border="1px solid"
                borderColor="app.border"
                borderLeftWidth="3px"
                borderLeftColor={TONE_COLOR[toast.tone]}
                boxShadow="elevationToast"
                fontSize="sm"
                color="app.text"
              >
                {toast.tone !== "info" && (
                  <chakra.span
                    display="inline-flex"
                    flexShrink={0}
                    color={TONE_COLOR[toast.tone]}
                    aria-hidden
                  >
                    <Icon name={toast.tone === "success" ? "check" : "warning"} size={16} />
                  </chakra.span>
                )}
                <chakra.span flex="1" minW={0} lineHeight="1.4" wordBreak="break-word">
                  {toast.message}
                </chakra.span>
                {toast.action && (
                  <chakra.button
                    type="button"
                    onClick={() => {
                      // Run the action, then dismiss so the toast doesn't linger.
                      toast.action?.onAction();
                      dismiss(toast.id);
                    }}
                    flexShrink={0}
                    display="inline-flex"
                    alignItems="center"
                    px="2"
                    py="1"
                    fontSize="sm"
                    fontWeight={600}
                    color={TONE_COLOR[toast.tone]}
                    bg="transparent"
                    border="1px solid"
                    borderColor="app.border"
                    borderRadius="sm"
                    cursor="pointer"
                    whiteSpace="nowrap"
                    _hover={{ bg: "app.hover" }}
                  >
                    {toast.action.label}
                  </chakra.button>
                )}
                <chakra.button
                  type="button"
                  onClick={() => dismiss(toast.id)}
                  aria-label="dismiss"
                  flexShrink={0}
                  display="inline-flex"
                  alignItems="center"
                  justifyContent="center"
                  p="0.5"
                  minW={0}
                  color="app.textMuted"
                  bg="transparent"
                  border="none"
                  borderRadius="sm"
                  cursor="pointer"
                  _hover={{ color: "app.text", bg: "app.hover" }}
                >
                  <Icon name="close" size={13} />
                </chakra.button>
              </Box>
            </motion.div>
          ))}
        </AnimatePresence>
      </Box>
    </ToastContext.Provider>
  );
}
