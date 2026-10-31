import { Box } from "@chakra-ui/react";
import { useState } from "react";
import { useT } from "../i18n";
import { GRID_PRESET_NAME_MAX, normalizePresetName } from "./gridViewState";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { FieldLabel, FormSection } from "./modalForm";
import { Button, Input, PressableButton } from "./ui";

interface Props {
  /** 既存のプリセット名 (同名で保存すると上書きになることを知らせる)。 */
  existingNames: readonly string[];
  /** 確定した名前 (整形済み)。空は呼ばれない。 */
  onConfirm: (name: string) => void;
  onClose: () => void;
}

/** 結果グリッドのビューを名前付きで保存するための小さなモーダル (#1942)。 */
export function GridViewPresetNameModal({ existingNames, onConfirm, onClose }: Props) {
  const t = useT();
  const [value, setValue] = useState("");
  const name = normalizePresetName(value);
  const overwrite = name !== "" && existingNames.includes(name);
  const confirm = () => {
    if (name) onConfirm(name);
  };
  return (
    <Modal onSubmit={confirm} submitDisabled={!name} width="440px" onClose={onClose}>
      <ModalHeader onClose={onClose} closeLabel={t("gridPresetCancel")}>
        {t("gridPresetSaveTitle")}
      </ModalHeader>
      <ModalBody>
        <FormSection>
          <FieldLabel htmlFor="grid-preset-name-input">{t("gridPresetNameLabel")}</FieldLabel>
          <Input
            id="grid-preset-name-input"
            value={value}
            autoFocus
            maxLength={GRID_PRESET_NAME_MAX}
            placeholder={t("gridPresetNamePlaceholder")}
            onChange={(e) => setValue(e.target.value)}
          />
          {overwrite && (
            <Box fontSize="var(--text-xs)" color="app.textWarning" role="status">
              {t("gridPresetOverwriteHint")}
            </Box>
          )}
        </FormSection>
      </ModalBody>
      <ModalFooter>
        <Box flex="1" />
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("gridPresetCancel")}
        </Button>
        <PressableButton type="button" variant="primary" disabled={!name} onClick={confirm}>
          {overwrite ? t("gridPresetOverwrite") : t("gridPresetSave")}
        </PressableButton>
      </ModalFooter>
    </Modal>
  );
}
