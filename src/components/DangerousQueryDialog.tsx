import { useRef } from "react";
import { useT } from "../i18n";
import type { DangerFinding, DangerKind } from "../dangerousSql";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button } from "./ui";

interface Props {
  findings: DangerFinding[];
  isProduction: boolean;
  /**
   * True when the dialog was opened solely because the production connection
   * requires approval for any data-modifying statement (not because a specific
   * destructive pattern was detected). Drives a generic message when `findings`
   * is empty.
   */
  writeApproval?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const KIND_LABEL_KEYS: Record<DangerKind, Parameters<ReturnType<typeof useT>>[0]> = {
  deleteNoWhere: "dangerousKindDeleteNoWhere",
  updateNoWhere: "dangerousKindUpdateNoWhere",
  drop: "dangerousKindDrop",
  truncate: "dangerousKindTruncate",
};

export function DangerousQueryDialog({ findings, isProduction, writeApproval, onConfirm, onCancel }: Props) {
  const t = useT();
  // Default focus to Cancel so a stray Enter doesn't run the query.
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <Modal width="520px" onClose={onCancel} initialFocusEl={() => cancelRef.current}>
      <ModalHeader onClose={onCancel} closeLabel={t("dangerousCancel")}>
        {t("dangerousTitle")}
      </ModalHeader>

      <ModalBody className="dangerous-body">
        {isProduction && (
          <div className="dangerous-production-note">{t("dangerousProductionNote")}</div>
        )}
        {findings.length > 0 ? (
          <>
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
          </>
        ) : (
          <p className="dangerous-intro">
            {t(writeApproval ? "dangerousWriteApprovalIntro" : "dangerousIntro")}
          </p>
        )}
      </ModalBody>

      <ModalFooter>
        <div style={{ flex: 1 }} />
        <Button ref={cancelRef} type="button" onClick={onCancel}>
          {t("dangerousCancel")}
        </Button>
        <Button type="button" variant="danger" onClick={onConfirm}>
          {t("dangerousConfirm")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
