import { motion } from "motion/react";

interface Props {
  size?: number;
  className?: string;
}

/**
 * A checkmark that draws itself in, used to punctuate a completed action
 * (export saved, dump written, import finished). The circle and tick stroke
 * on via Motion's pathLength; the global MotionConfig `reducedMotion` freezes
 * it to a static check for users who opt out.
 */
export function SuccessCheck({ size = 40, className }: Props) {
  return (
    <svg
      className={className ? `success-check ${className}` : "success-check"}
      width={size}
      height={size}
      viewBox="0 0 52 52"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <motion.circle
        cx="26"
        cy="26"
        r="23"
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      />
      <motion.path
        d="M16 27l7 7 13-14"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.3, delay: 0.25, ease: [0.16, 1, 0.3, 1] }}
      />
    </svg>
  );
}
