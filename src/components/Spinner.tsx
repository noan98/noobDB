interface Props {
  /** Diameter in px. */
  size?: number;
  className?: string;
}

/**
 * Small indeterminate spinner shared across loading states (schema tree, result
 * waiting, load-more, status bar). Pure CSS rotation; the global
 * `prefers-reduced-motion` rule freezes it into a static ring.
 */
export function Spinner({ size = 16, className }: Props) {
  return (
    <span
      className={`spinner${className ? " " + className : ""}`}
      style={{ width: size, height: size }}
      role="status"
      aria-label="loading"
    />
  );
}
