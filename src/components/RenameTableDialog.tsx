import { useRef, useState } from "react";
import { useT } from "../i18n";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, Input } from "./ui";

/**
 * テーブル名変更ダイアログ (#496)。新しい名前を入力して確定すると
 * `ALTER TABLE ... RENAME TO ...` を実行する (実行は呼び出し側 App が担当)。
 */
interface Props {
  table: string;
  onConfirm: (newName: string) => void;
  onCancel: () => void;
}

export function RenameTableDialog({ table, onConfirm, onCancel }: Props) {
  const t = useT();
  const [name, setName] = useState(table);
  const inputRef = useRef<HTMLInputElement>(null);

  const trimmed = name.trim();
  const valid = trimmed.length > 0 && trimmed !== table;
  const submit = () => {
    if (valid) onConfirm(trimmed);
  };

  return (
    <Modal width="440px" onClose={onCancel} initialFocusEl={() => inputRef.current}>
      <ModalHeader onClose={onCancel} closeLabel={t("createTableClose")}>
        {t("renameTableTitle")}
      </ModalHeader>
      <ModalBody>
        <label style={{ display: "block", marginBottom: "6px", fontSize: "0.85em" }}>
          {t("renameTableLabel", { table })}
        </label>
        <Input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
      </ModalBody>
      <ModalFooter>
        <div style={{ flex: 1 }} />
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t("createTableClose")}
        </Button>
        <Button type="button" variant="primary" disabled={!valid} onClick={submit}>
          {t("renameTableConfirm")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
