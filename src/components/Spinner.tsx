import { chakra } from "@chakra-ui/react";

interface Props {
  /** Diameter in px. */
  size?: number;
  className?: string;
}

/**
 * Small indeterminate spinner shared across loading states (schema tree, result
 * waiting, load-more, status bar). The `spinner-rotate` keyframe lives in
 * `App.css`; the global `prefers-reduced-motion` rule freezes it into a static
 * ring. Styling is expressed via Chakra `app.*` tokens so it follows the active
 * theme/accent. `className` is preserved so callers can layer overrides (e.g.
 * `.btn-spinner`, which retints the ring to the button's `currentColor`).
 */
export function Spinner({ size = 16, className }: Props) {
  return (
    <chakra.span
      className={className}
      display="inline-block"
      borderRadius="full"
      borderWidth="2px"
      borderStyle="solid"
      borderColor="app.borderStrong"
      borderTopColor="app.accent"
      animation="spinner-rotate 0.7s linear infinite"
      flexShrink={0}
      verticalAlign="middle"
      style={{ width: size, height: size }}
      role="status"
      aria-label="loading"
    />
  );
}
