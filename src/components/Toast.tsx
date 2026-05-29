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

export type ToastTone = "success" | "error" | "info";

/** Left accent rail + icon tint per tone, bridged to the status color tokens. */
const TONE_COLOR: Record<ToastTone, string> = {
  success: "app.status.success",
  error: "app.status.error",
  info: "app.status.info",
};

export interface ToastOptions {
  message: string;
  tone?: ToastTone;
  /** Auto-dismiss delay in ms. `0` keeps the toast until dismissed by hand. */
  duration?: number;
}

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

interface ToastApi {
  notify: (opts: ToastOptions) => void;
  success: (message: string, duration?: number) => void;
  error: (message: string, duration?: number) => void;
  info: (message: string, duration?: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * Transient, app-wide notifications. Distinct from the footer status bar
 * (which tracks the latest in-progress / query result): toasts confirm
 * one-shot actions like export, import, dump, connect, and copy, then fade
 * out on their own. Motion drives the enter/exit; the global
 * `prefers-reduced-motion` config neutralizes it for users who opt out.
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
      // Errors linger longer than confirmations so they can be read.
      const duration = opts.duration ?? (tone === "error" ? 6000 : 3500);
      setToasts((cur) => [...cur, { id, message: opts.message, tone }]);
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
        bottom="var(--space-4)"
        right="var(--space-4)"
        zIndex={2000}
        display="flex"
        flexDirection="column"
        gap="var(--space-2)"
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
                gap="var(--space-2)"
                px="12px"
                py="10px"
                borderRadius="md"
                bg="app.surface"
                border="1px solid"
                borderColor="app.border"
                borderLeftWidth="3px"
                borderLeftColor={TONE_COLOR[toast.tone]}
                boxShadow="lg"
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
                <chakra.button
                  type="button"
                  onClick={() => dismiss(toast.id)}
                  aria-label="dismiss"
                  flexShrink={0}
                  display="inline-flex"
                  alignItems="center"
                  justifyContent="center"
                  p="2px"
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
