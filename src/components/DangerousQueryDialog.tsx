import { useEffect, useRef } from "react";
import { useT } from "../i18n";
import type { DangerFinding, DangerKind } from "../dangerousSql";

interface Props {
  findings: DangerFinding[];
  isProduction: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const KIND_LABEL_KEYS: Record<DangerKind, Parameters<ReturnType<typeof useT>>[0]> = {
  deleteNoWhere: "dangerousKindDeleteNoWhere",
  updateNoWhere: "dangerousKindUpdateNoWhere",
  drop: "dangerousKindDrop",
  truncate: "dangerousKindTruncate",
};

export function DangerousQueryDialog({ findings, isProduction, onConfirm, onCancel }: Props) {
  const t = useT();
  // Default focus to Cancel so a stray Enter doesn't run the query.
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      onClick={onCancel}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <div className="modal dangerous-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>{t("dangerousTitle")}</h2>
          <button className="icon" onClick={onCancel} aria-label={t("dangerousCancel")} title={t("dangerousCancel")}>
            ✕
          </button>
        </header>

        <div className="modal-body dangerous-body">
          {isProduction && (
            <div className="dangerous-production-note">{t("dangerousProductionNote")}</div>
          )}
          <p className="dangerous-intro">{t("dangerousIntro")}</p>
          <ul className="dangerous-list">
            {findings.map((f, idx) => (
              <li key={idx} className="dangerous-item">
                <span className="dangerous-kind">{t(KIND_LABEL_KEYS[f.kind])}</span>
                <span className="dangerous-target">
                  {f.target
                    ? t("dangerousTargetTable", { target: f.target })
                    : t("dangerousTargetUnknown")}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="modal-footer">
          <div style={{ flex: 1 }} />
          <button ref={cancelRef} onClick={onCancel}>
            {t("dangerousCancel")}
          </button>
          <button className="danger" onClick={onConfirm}>
            {t("dangerousConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
