import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import { Icon } from "./Icon";

export type ToastTone = "success" | "error" | "info";

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
      <div className="toast-viewport" role="region" aria-live="polite" aria-label="notifications">
        <AnimatePresence initial={false}>
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              className={`toast toast-${toast.tone}`}
              role="status"
              layout
              initial={{ opacity: 0, y: 14, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 28, scale: 0.96 }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            >
              {toast.tone !== "info" && (
                <span className="toast-icon" aria-hidden>
                  <Icon name={toast.tone === "success" ? "check" : "warning"} size={16} />
                </span>
              )}
              <span className="toast-message">{toast.message}</span>
              <button
                type="button"
                className="toast-dismiss"
                onClick={() => dismiss(toast.id)}
                aria-label="dismiss"
              >
                <Icon name="close" size={13} />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
