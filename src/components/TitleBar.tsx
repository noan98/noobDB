import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { chakra, Flex, type HTMLChakraProps } from "@chakra-ui/react";
import { useT } from "../i18n";

const appWindow = getCurrentWindow();

/** A window control button (minimize / maximize / close). Mirrors the platform
 *  window buttons; the close button overrides `_hover` with the destructive red. */
function TitleControl(props: HTMLChakraProps<"button">) {
  return (
    <chakra.button
      type="button"
      width="46px"
      display="inline-flex"
      alignItems="center"
      justifyContent="center"
      p={0}
      border="none"
      borderRadius={0}
      bg="transparent"
      color="app.textSecondary"
      cursor="pointer"
      transitionProperty="background, color"
      transitionDuration="var(--dur-fast)"
      transitionTimingFunction="var(--ease)"
      _hover={{ bg: "app.hover", color: "app.text" }}
      {...props}
    />
  );
}

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
    <Flex
      data-tauri-drag-region
      align="stretch"
      flexShrink={0}
      h="38px"
      bg="app.surface"
      borderBottom="1px solid"
      borderColor="app.border"
      css={{ userSelect: "none", WebkitUserSelect: "none" }}
    >
      <Flex data-tauri-drag-region align="center" gap="8px" flex="1" minW={0} px="12px">
        <chakra.svg
          display="block"
          flexShrink={0}
          borderRadius="4px"
          viewBox="0 0 1024 1024"
          width="16px"
          height="16px"
          aria-hidden
        >
          <rect x="0" y="0" width="1024" height="1024" rx="232" fill="#2f7df6" />
          <path d="M282 300 L282 724 A230 84 0 0 0 742 724 L742 300 Z" fill="#ffffff" />
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
        </chakra.svg>
        <chakra.span
          fontSize="var(--text-sm)"
          fontWeight="600"
          letterSpacing="0.02em"
          color="app.textSecondary"
        >
          noobDB
        </chakra.span>
      </Flex>

      <Flex align="stretch">
        <TitleControl
          onClick={() => appWindow.minimize()}
          title={t("titleBarMinimize")}
          aria-label={t("titleBarMinimize")}
        >
          <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden>
            <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </TitleControl>
        <TitleControl
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
        </TitleControl>
        <TitleControl
          onClick={() => appWindow.close()}
          title={t("titleBarClose")}
          aria-label={t("titleBarClose")}
          _hover={{ bg: "#e81123", color: "#ffffff" }}
        >
          <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden>
            <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </TitleControl>
      </Flex>
    </Flex>
  );
}
