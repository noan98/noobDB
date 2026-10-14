import { useState } from "react";
import { chakra } from "@chakra-ui/react";
import type { TextEncodingId } from "../api/tauri";
import { useT } from "../i18n";
import { parseTextEncodingId } from "../sqlFileIO";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { FieldLabel, FormSection } from "./modalForm";
import { TextEncodingSelect } from "./TextEncodingSelect";
import { Button, PressableButton } from "./ui";

interface Props {
  /** `open` は読み込み (自動判定を含む)、`save` は保存。 */
  mode: "open" | "save";
  /** 保存の初期値 (タブが覚えている文字コード)。 */
  initial?: TextEncodingId;
  /** `null` は自動判定 (`open` のみ)。 */
  onConfirm: (encoding: TextEncodingId | null) => void;
  onClose: () => void;
}

/**
 * SQL ファイルを開く・保存するときの文字コードを選ぶ小さなモーダル (#1535)。ネイティブの
 * ファイルダイアログには文字コードの選択欄を足せないため、ファイルを選ぶ前にここで決める。
 * 通常の「SQL ファイルを開く」「名前を付けて保存」は自動判定 / タブが覚えている文字コードで
 * 動くので、このモーダルは上書きしたいときだけ出す (コマンドパレットから)。
 */
export function SqlFileEncodingModal({ mode, initial, onConfirm, onClose }: Props) {
  const t = useT();
  const [value, setValue] = useState<string>(mode === "open" ? "" : (initial ?? "utf-8"));
  const confirm = () => onConfirm(parseTextEncodingId(value));
  return (
    <Modal onSubmit={confirm} width="480px" onClose={onClose}>
      <ModalHeader onClose={onClose} closeLabel={t("sqlFileEncodingCancel")}>
        {mode === "open" ? t("sqlFileEncodingOpenTitle") : t("sqlFileEncodingSaveTitle")}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="4">
        <chakra.div fontSize="sm" color="app.textMuted" lineHeight="normal">
          {t("sqlFileEncodingNote")}
        </chakra.div>
        <FormSection>
          <FieldLabel htmlFor="sql-file-encoding">{t("sqlFileEncodingLabel")}</FieldLabel>
          <TextEncodingSelect
            id="sql-file-encoding"
            allowAuto={mode === "open"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </FormSection>
      </ModalBody>
      <ModalFooter>
        <div style={{ flex: 1 }} />
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("sqlFileEncodingCancel")}
        </Button>
        <PressableButton type="button" variant="primary" onClick={confirm}>
          {mode === "open" ? t("sqlFileEncodingOpen") : t("sqlFileEncodingSave")}
        </PressableButton>
      </ModalFooter>
    </Modal>
  );
}
