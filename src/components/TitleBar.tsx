import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { chakra, Flex, type HTMLChakraProps } from "@chakra-ui/react";
import { useT } from "../i18n";
import { Icon } from "./Icon";
import { BrandMark } from "../brand";
import { ProductionBadge, ProfileColorChip } from "./ProfileBadge";
import { connectionBandColor, type TitleBarConnection } from "./titleBarContext";

export type { TitleBarConnection } from "./titleBarContext";

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
export function TitleBar({ connection }: { connection?: TitleBarConnection | null }) {
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

  // 接続中はタイトルバー下端にアクセントの帯を常時表示する。本番接続は
  // 危険色の帯にして全画面で「本番にいる」ことを一目で示す。色遷移は CSS transition。
  const bandColor = connectionBandColor(connection);

  return (
    <Flex
      data-tauri-drag-region
      align="stretch"
      flexShrink={0}
      h="38px"
      bg="app.surface"
      borderBottom="1px solid"
      borderColor="app.border"
      boxShadow={`inset 0 -2px 0 ${bandColor}`}
      transition="box-shadow var(--dur-med) var(--ease)"
      css={{ userSelect: "none", WebkitUserSelect: "none" }}
    >
      <Flex data-tauri-drag-region align="center" gap="2" flex="1" minW={0} px="3">
        {/* インストール済みアプリアイコンと同じブランドマーク (#619)。マークの
            出所は brand.tsx に一元化し、ここはサイズ指定だけする。 */}
        <BrandMark size={18} />
        <chakra.span
          fontSize="var(--text-sm)"
          fontWeight="600"
          letterSpacing="0.02em"
          color="app.textSecondary"
          flexShrink={0}
        >
          noobDB
        </chakra.span>

        {/* アクティブ接続コンテキスト。Settings/Help など作業画面以外でも常時表示。 */}
        {connection && (
          <Flex align="center" gap="1.5" minW={0} css={{ pointerEvents: "none" }}>
            <chakra.span color="app.borderStrong" flexShrink={0} aria-hidden>
              /
            </chakra.span>
            {/* プロファイルカラーの丸チップ (#663)。ConnectionList / 本番接続確認
                ダイアログと同じ `ProfileColorChip` を共有する。 */}
            <ProfileColorChip color={connection.color} size={9} />
            <chakra.span
              fontSize="var(--text-sm)"
              fontWeight="600"
              color="app.text"
              overflow="hidden"
              textOverflow="ellipsis"
              whiteSpace="nowrap"
              maxW="220px"
              title={connection.name}
            >
              {connection.name}
            </chakra.span>
            {connection.isProduction && <ProductionBadge compact />}
            {/* 自動再接続中はアンビエントなバッジで状態を示す (#600)。帯色も警告色になる。 */}
            {connection.status === "reconnecting" && (
              <chakra.span
                title={t("statusReconnecting")}
                display="inline-flex"
                alignItems="center"
                gap="3px"
                flexShrink={0}
                fontSize="var(--text-2xs)"
                fontWeight={700}
                textTransform="uppercase"
                letterSpacing="0.06em"
                px="1.5"
                py="1px"
                borderRadius="pill"
                bg="app.status.warning"
                color="#fff"
              >
                <Icon name="refresh" size={11} />
                {t("statusReconnecting")}
              </chakra.span>
            )}
          </Flex>
        )}
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
