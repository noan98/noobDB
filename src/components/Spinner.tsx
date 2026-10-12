import { chakra } from "@chakra-ui/react";
import { useT } from "../i18n";

interface Props {
  /** Diameter in px. */
  size?: number;
  /**
   * ボタンのラベルなど、隣に読み上げられる文言がある装飾用途では true。
   * role / aria-label を外して aria-hidden にする (読み上げが二重になるため, #1529)。
   */
  decorative?: boolean;
}

/**
 * Small indeterminate spinner shared across loading states (schema tree, result
 * waiting, load-more, status bar). The `spinner-rotate` keyframe lives in
 * `App.css`; the global `prefers-reduced-motion` rule freezes it into a static
 * ring. Styling is expressed via Chakra `app.*` tokens so it follows the active
 * theme/accent.
 */
export function Spinner({ size = 16, decorative = false }: Props) {
  const t = useT();
  return (
    <chakra.span
      display="inline-block"
      borderRadius="full"
      borderWidth="2px"
      borderStyle="solid"
      borderColor="app.borderStrong"
      borderTopColor="app.accent"
      animation="spinner-rotate var(--dur-spin) linear infinite"
      flexShrink={0}
      verticalAlign="middle"
      style={{ width: size, height: size }}
      role={decorative ? undefined : "status"}
      aria-label={decorative ? undefined : t("spinnerLoadingAria")}
      aria-hidden={decorative ? true : undefined}
    />
  );
}
