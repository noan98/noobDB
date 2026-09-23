import { useRef, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { useT } from "../i18n";
import type { ProfileImportStrategy } from "../api/tauri";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { ErrorNote, FieldLabel, FormSection } from "./modalForm";
import { Button, Input, PressableButton, Radio } from "./ui";

/**
 * プロファイルインポートの ID 衝突解決ダイアログ。ファイル選択後に開き、
 * 「新規 ID で追加 / スキップ / 上書き」の 3 戦略から 1 つを選んで確定する。
 * 秘密情報がファイルに含まれないこと (接続時に資格情報の再入力が要ること) も明示する。
 *
 * `encrypted` のときは暗号化バックアップ (#710) の取り込みで、同じ衝突解決フローに
 * パスフレーズ入力欄を足す。パスフレーズはこの state にだけ置き、`onConfirm` へ
 * 渡したら親が IPC に載せるだけ (保存しない)。復号失敗 (パスフレーズ誤り / 改ざん)
 * は親が `error` に入れて返し、ダイアログを開いたまま再入力させる。
 */
interface Props {
  onConfirm: (strategy: ProfileImportStrategy, passphrase: string) => Promise<void> | void;
  onCancel: () => void;
  /** 暗号化バックアップの取り込みか (パスフレーズ欄を出す)。 */
  encrypted?: boolean;
  /** 直前の取り込み失敗の説明 (暗号化時のみ使う)。 */
  error?: string | null;
}

const Option = chakra("label", {
  base: {
    display: "flex",
    alignItems: "flex-start",
    gap: "2",
    px: "2.5",
    py: "2",
    borderRadius: "var(--radius-lg)",
    cursor: "pointer",
    borderWidth: "1px",
    borderColor: "app.border",
    _hover: { bg: "app.rowHover" },
  },
});

export function ProfileImportDialog({ onConfirm, onCancel, encrypted = false, error }: Props) {
  const t = useT();
  const [strategy, setStrategy] = useState<ProfileImportStrategy>("rename");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const passphraseRef = useRef<HTMLInputElement>(null);
  const canSubmit = !busy && (!encrypted || passphrase.length > 0);

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await onConfirm(strategy, passphrase);
    } finally {
      setBusy(false);
    }
  };

  const options: { value: ProfileImportStrategy; label: string; desc: string }[] = [
    { value: "rename", label: t("profileImportRename"), desc: t("profileImportRenameDesc") },
    { value: "skip", label: t("profileImportSkip"), desc: t("profileImportSkipDesc") },
    { value: "overwrite", label: t("profileImportOverwrite"), desc: t("profileImportOverwriteDesc") },
  ];

  return (
    <Modal
      // no-submit: 既存プロファイルを上書きしうる取り込みの確認。キャンセルが既定
      width="480px"
      onClose={onCancel}
      initialFocusEl={() => (encrypted ? passphraseRef.current : cancelRef.current)}
    >
      <ModalHeader onClose={onCancel} closeLabel={t("confirmDefaultCancel")}>
        {encrypted ? t("profileBackupImportTitle") : t("profileImportTitle")}
      </ModalHeader>
      <ModalBody>
        <chakra.p fontSize="sm" color="app.textSecondary" mb="3">
          {encrypted ? t("profileBackupImportNote") : t("profileImportNote")}
        </chakra.p>
        {encrypted && (
          <chakra.form
            mb="3"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <FormSection>
              <FieldLabel htmlFor="profile-backup-import-passphrase">
                {t("profileBackupPassphrase")}
              </FieldLabel>
              <Input
                id="profile-backup-import-passphrase"
                ref={passphraseRef}
                type="password"
                autoComplete="current-password"
                spellCheck={false}
                value={passphrase}
                disabled={busy}
                onChange={(e) => setPassphrase(e.target.value)}
              />
            </FormSection>
          </chakra.form>
        )}
        {encrypted && error && <ErrorNote mb="3" role="alert">{error}</ErrorNote>}
        <chakra.div display="flex" flexDirection="column" gap="2">
          {options.map((o) => (
            <Option
              key={o.value}
              borderColor={strategy === o.value ? "app.accent" : "app.border"}
            >
              <Radio
                name="profile-import-strategy"
                checked={strategy === o.value}
                onChange={() => setStrategy(o.value)}
                mt="0.75"
              />
              <chakra.span display="flex" flexDirection="column">
                <chakra.span textStyle="subheading">
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
        <Button ref={cancelRef} type="button" variant="secondary" onClick={onCancel} disabled={busy}>
          {t("confirmDefaultCancel")}
        </Button>
        <PressableButton
          type="button"
          variant="primary"
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {busy ? t("profileBackupImporting") : t("profileImportConfirm")}
        </PressableButton>
      </ModalFooter>
    </Modal>
  );
}
