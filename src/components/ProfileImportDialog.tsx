import { useRef, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { useT } from "../i18n";
import type { ProfileImportStrategy } from "../api/tauri";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button } from "./ui";

/**
 * プロファイルインポート (#442) の ID 衝突解決ダイアログ。ファイル選択後に開き、
 * 「新規 ID で追加 / スキップ / 上書き」の 3 戦略から 1 つを選んで確定する。
 * 秘密情報がファイルに含まれないこと (接続時に資格情報の再入力が要ること) も明示する。
 */
interface Props {
  onConfirm: (strategy: ProfileImportStrategy) => void;
  onCancel: () => void;
}

const Option = chakra("label", {
  base: {
    display: "flex",
    alignItems: "flex-start",
    gap: "8px",
    px: "10px",
    py: "8px",
    borderRadius: "8px",
    cursor: "pointer",
    borderWidth: "1px",
    borderColor: "app.border",
    _hover: { bg: "app.rowHover" },
  },
});

export function ProfileImportDialog({ onConfirm, onCancel }: Props) {
  const t = useT();
  const [strategy, setStrategy] = useState<ProfileImportStrategy>("rename");
  const cancelRef = useRef<HTMLButtonElement>(null);

  const options: { value: ProfileImportStrategy; label: string; desc: string }[] = [
    { value: "rename", label: t("profileImportRename"), desc: t("profileImportRenameDesc") },
    { value: "skip", label: t("profileImportSkip"), desc: t("profileImportSkipDesc") },
    { value: "overwrite", label: t("profileImportOverwrite"), desc: t("profileImportOverwriteDesc") },
  ];

  return (
    <Modal width="480px" onClose={onCancel} initialFocusEl={() => cancelRef.current}>
      <ModalHeader onClose={onCancel} closeLabel={t("confirmDefaultCancel")}>
        {t("profileImportTitle")}
      </ModalHeader>
      <ModalBody>
        <chakra.p fontSize="sm" color="app.textSecondary" mb="12px">
          {t("profileImportNote")}
        </chakra.p>
        <chakra.div display="flex" flexDirection="column" gap="8px">
          {options.map((o) => (
            <Option
              key={o.value}
              borderColor={strategy === o.value ? "app.accent" : "app.border"}
            >
              <input
                type="radio"
                name="profile-import-strategy"
                checked={strategy === o.value}
                onChange={() => setStrategy(o.value)}
                style={{ marginTop: "3px" }}
              />
              <chakra.span display="flex" flexDirection="column">
                <chakra.span fontWeight={600} fontSize="sm">
                  {o.label}
                </chakra.span>
                <chakra.span fontSize="xs" color="app.textMuted">
                  {o.desc}
                </chakra.span>
              </chakra.span>
            </Option>
          ))}
        </chakra.div>
      </ModalBody>
      <ModalFooter>
        <div style={{ flex: 1 }} />
        <Button ref={cancelRef} type="button" variant="secondary" onClick={onCancel}>
          {t("confirmDefaultCancel")}
        </Button>
        <Button type="button" variant="primary" onClick={() => onConfirm(strategy)}>
          {t("profileImportConfirm")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
