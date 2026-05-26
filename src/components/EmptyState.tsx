import { Icon, type IconName } from "./Icon";

interface Props {
  /** Optional glyph shown above the title. */
  icon?: IconName;
  title: string;
  /** Optional supporting line under the title. */
  description?: string;
  /** Optional primary call-to-action button. */
  action?: { label: string; onClick: () => void };
  /** Tighter layout for inline use (e.g. inside the result grid body). */
  compact?: boolean;
}

/**
 * Shared empty / onboarding state: an optional icon, a short title, an optional
 * description, and an optional primary action. Used across the connection list,
 * editor pane, snippet/history panels and the result grid so "nothing here yet"
 * reads consistently and points the user at the next step.
 */
export function EmptyState({ icon, title, description, action, compact = false }: Props) {
  return (
    <div className={`empty-state${compact ? " empty-state-compact" : ""}`}>
      {icon && (
        <span className="empty-state-icon" aria-hidden>
          <Icon name={icon} size={compact ? 22 : 32} strokeWidth={1.5} />
        </span>
      )}
      <div className="empty-state-title">{title}</div>
      {description && <div className="empty-state-desc">{description}</div>}
      {action && (
        <button type="button" className="primary empty-state-action" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}
