import { chakra } from "@chakra-ui/react";

interface Props {
  /** Diameter in px. */
  size?: number;
}

/**
 * Small indeterminate spinner shared across loading states (schema tree, result
 * waiting, load-more, status bar). The `spinner-rotate` keyframe lives in
 * `App.css`; the global `prefers-reduced-motion` rule freezes it into a static
 * ring. Styling is expressed via Chakra `app.*` tokens so it follows the active
 * theme/accent.
 */
export function Spinner({ size = 16 }: Props) {
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
      role="status"
      aria-label="loading"
    />
  );
}
