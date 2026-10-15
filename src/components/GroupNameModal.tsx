import { Box } from "@chakra-ui/react";
import { useState } from "react";
import { useT } from "../i18n";
import { normalizeGroupName } from "../profileGroup";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { FieldLabel, FormSection } from "./modalForm";
import { Button, Input, PressableButton } from "./ui";

interface Props {
  /** 移す接続の件数 (見出しの文言に使う)。 */
  count: number;
  /** 既存のグループ名 (入力の候補。新しい名前も自由に入れられる)。 */
  existingGroups: readonly string[];
  /** 確定したグループ名 (空白を除き済み)。空は呼ばれない。 */
  onConfirm: (group: string) => void;
  onClose: () => void;
}

/**
 * 接続を移す先の**新しいグループ名**を入力する小さなモーダル (#1630)。既存グループへの移動と
 * 未分類へ戻す操作はメニューの項目で直接行えるので、ここは「新規グループ名の入力」専用。
 */
export function GroupNameModal({ count, existingGroups, onConfirm, onClose }: Props) {
  const t = useT();
  const [value, setValue] = useState("");
  const name = normalizeGroupName(value);
  const confirm = () => {
    if (name) onConfirm(name);
  };
  return (
    <Modal onSubmit={confirm} submitDisabled={!name} width="440px" onClose={onClose}>
      <ModalHeader onClose={onClose} closeLabel={t("groupNameCancel")}>
        {t("groupNameTitle", { count })}
      </ModalHeader>
      <ModalBody>
        <FormSection>
          <FieldLabel htmlFor="group-name-input">{t("groupNameLabel")}</FieldLabel>
          <Input
            id="group-name-input"
            value={value}
            autoFocus
            list="group-name-options"
            placeholder={t("groupNamePlaceholder")}
            onChange={(e) => setValue(e.target.value)}
          />
          <datalist id="group-name-options">
            {existingGroups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </FormSection>
      </ModalBody>
      <ModalFooter>
        <Box flex="1" />
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("groupNameCancel")}
        </Button>
        <PressableButton type="button" variant="primary" disabled={!name} onClick={confirm}>
          {t("groupNameMove")}
        </PressableButton>
      </ModalFooter>
    </Modal>
  );
}
