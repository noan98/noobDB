import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useT } from "../i18n";

const appWindow = getCurrentWindow();

/**
 * Custom window chrome shown in place of the native title bar
 * (`decorations: false`). The bar itself is a Tauri drag region; the controls
 * on the right mirror the platform window buttons. Window actions require the
 * matching `core:window:*` permissions in `capabilities/default.json`.
 */
export function TitleBar() {
  const t = useT();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    appWindow.isMaximized().then(setMaximized).catch(() => {});
    appWindow
      .onResized(() => {
        appWindow.isMaximized().then(setMaximized).catch(() => {});
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => unlisten?.();
  }, []);

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-brand" data-tauri-drag-region>
        <svg
          className="titlebar-logo"
          viewBox="0 0 1024 1024"
          width="16"
          height="16"
          aria-hidden
        >
          <rect x="0" y="0" width="1024" height="1024" rx="232" fill="#2f7df6" />
          <path
            d="M282 300 L282 724 A230 84 0 0 0 742 724 L742 300 Z"
            fill="#ffffff"
          />
          <ellipse cx="512" cy="300" rx="230" ry="84" fill="#ffffff" />
          <g fill="#1e3a8a">
            <circle cx="438" cy="556" r="30" />
            <circle cx="586" cy="556" r="30" />
          </g>
          <path
            d="M430 628 Q512 696 594 628"
            fill="none"
            stroke="#1e3a8a"
            strokeWidth="26"
            strokeLinecap="round"
          />
        </svg>
        <span className="titlebar-title">noobDB</span>
      </div>

      <div className="titlebar-controls">
        <button
          type="button"
          className="titlebar-btn"
          onClick={() => appWindow.minimize()}
          title={t("titleBarMinimize")}
          aria-label={t("titleBarMinimize")}
        >
          <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden>
            <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
        <button
          type="button"
          className="titlebar-btn"
          onClick={() => appWindow.toggleMaximize()}
          title={maximized ? t("titleBarRestore") : t("titleBarMaximize")}
          aria-label={maximized ? t("titleBarRestore") : t("titleBarMaximize")}
        >
          {maximized ? (
            <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden>
              <path
                d="M2.5 2.5h5v5h-5z M2.5 0.5h7v7"
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden>
              <rect
                x="0.5"
                y="0.5"
                width="9"
                height="9"
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
              />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="titlebar-btn titlebar-close"
          onClick={() => appWindow.close()}
          title={t("titleBarClose")}
          aria-label={t("titleBarClose")}
        >
          <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden>
            <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
      </div>
    </div>
  );
}
