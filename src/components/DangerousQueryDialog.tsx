import { useRef } from "react";
import { chakra } from "@chakra-ui/react";
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

      <ModalBody display="flex" flexDirection="column" gap="var(--space-3)">
        {isProduction && (
          <chakra.div
            py="2" px="2.5"
            borderRadius="md"
            fontWeight={600}
            color="app.dangerFg"
            bg="app.dangerBg"
          >
            {t("dangerousProductionNote")}
          </chakra.div>
        )}
        {findings.length > 0 ? (
          <>
            <chakra.p m={0} color="app.text">
              {t("dangerousIntro")}
            </chakra.p>
            <chakra.ul
              m={0}
              p={0}
              listStyleType="none"
              display="flex"
              flexDirection="column"
              gap="var(--space-2)"
            >
              {findings.map((f, idx) => (
                <chakra.li
                  key={idx}
                  display="flex"
                  flexDirection="column"
                  gap="0.5"
                  py="2" px="2.5"
                  border="1px solid"
                  borderColor="app.border"
                  borderLeft="3px solid"
                  borderLeftColor="app.dangerBg"
                  borderRadius="md"
                  bg="app.toolbar"
                >
                  <chakra.span fontWeight={600} color="app.text">
                    {t(KIND_LABEL_KEYS[f.kind])}
                  </chakra.span>
                  <chakra.span fontSize="sm" color="app.textMuted" fontFamily="mono">
                    {f.target
                      ? t("dangerousTargetTable", { target: f.target })
                      : t("dangerousTargetUnknown")}
                  </chakra.span>
                </chakra.li>
              ))}
            </chakra.ul>
          </>
        ) : (
          <chakra.p m={0} color="app.text">
            {t(writeApproval ? "dangerousWriteApprovalIntro" : "dangerousIntro")}
          </chakra.p>
        )}
      </ModalBody>

      {/*
        安全側優先レイアウト (#323): 不可逆な「実行」は非強調 (secondary) で左側に
        置き、安全な「キャンセル」を強調色 (primary) で右側 + デフォルトフォーカスに
        する。HIG 各種ガイドラインに倣い、破壊的アクションを視覚的に優位にしない。
      */}
      <ModalFooter>
        <Button type="button" variant="secondary" onClick={onConfirm}>
          {t("dangerousConfirm")}
        </Button>
        <div style={{ flex: 1 }} />
        <Button ref={cancelRef} type="button" variant="primary" onClick={onCancel}>
          {t("dangerousCancel")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
