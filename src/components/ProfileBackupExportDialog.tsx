import { useRef, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { useT, type I18nKey } from "../i18n";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { FieldError, FieldLabel, FormSection } from "./modalForm";
import { Button, Input, PressableButton } from "./ui";
import {
  MIN_BACKUP_PASSPHRASE_LENGTH,
  passphraseStrength,
  validateBackupPassphrase,
  type PassphraseStrength,
} from "./profileBackup";

/**
 * 暗号化バックアップ (#710) のパスフレーズ入力ダイアログ。確認用の 2 回入力と
 * 強度の目安・取り扱いの注意を表示し、確定するとパスフレーズを `onConfirm` に渡す
 * (保存先の選択と書き出しは親が行う)。
 *
 * パスフレーズはこのコンポーネントの state にだけ置き、localStorage 等には書かない。
 * `onConfirm` が解決するまで操作を無効化する (鍵導出に 1 秒弱かかるため)。
 */
interface Props {
  /** 対象プロファイル数 (説明文に出す)。 */
  profileCount: number;
  onConfirm: (passphrase: string) => Promise<void> | void;
  onCancel: () => void;
}

const STRENGTH_KEY: Record<PassphraseStrength, I18nKey> = {
  weak: "profileBackupStrengthWeak",
  fair: "profileBackupStrengthFair",
  strong: "profileBackupStrengthStrong",
};

const STRENGTH_COLOR: Record<PassphraseStrength, string> = {
  weak: "app.textError",
  fair: "app.textWarning",
  strong: "app.textSuccess",
};

export function ProfileBackupExportDialog({ profileCount, onConfirm, onCancel }: Props) {
  const t = useT();
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);

  const error = validateBackupPassphrase(passphrase, confirmation);
  const strength = passphraseStrength(passphrase);
  // 確認欄が未入力のうちは「一致しない」を出さない (打鍵中に赤くしない)。
  const shownError =
    error === "tooShort" && (touched || passphrase.length > 0)
      ? t("profileBackupPassphraseTooShort", { min: MIN_BACKUP_PASSPHRASE_LENGTH })
      : error === "mismatch" && (touched || confirmation.length > 0)
        ? t("profileBackupPassphraseMismatch")
        : null;

  const submit = async () => {
    setTouched(true);
    if (error || busy) return;
    setBusy(true);
    try {
      await onConfirm(passphrase);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      width="520px"
      onClose={onCancel}
      initialFocusEl={() => firstRef.current}
      onSubmit={() => void submit()}
      submitDisabled={busy || error !== null}
    >
      <ModalHeader onClose={onCancel} closeLabel={t("confirmDefaultCancel")}>
        {t("profileBackupExportTitle")}
      </ModalHeader>
      <ModalBody>
        <chakra.form
          display="flex"
          flexDirection="column"
          gap="3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <chakra.p fontSize="sm" color="app.textSecondary">
            {t("profileBackupExportNote", { count: profileCount })}
          </chakra.p>
          <FormSection>
            <FieldLabel htmlFor="profile-backup-passphrase">
              {t("profileBackupPassphrase")}
            </FieldLabel>
            <Input
              id="profile-backup-passphrase"
              ref={firstRef}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={passphrase}
              disabled={busy}
              onChange={(e) => setPassphrase(e.target.value)}
            />
            {passphrase.length > 0 && (
              <chakra.span
                fontSize="xs"
                color={STRENGTH_COLOR[strength]}
                data-testid="profile-backup-strength"
              >
                {t("profileBackupStrength", { level: t(STRENGTH_KEY[strength]) })}
              </chakra.span>
            )}
          </FormSection>
          <FormSection>
            <FieldLabel htmlFor="profile-backup-passphrase-confirm">
              {t("profileBackupPassphraseConfirm")}
            </FieldLabel>
            <Input
              id="profile-backup-passphrase-confirm"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={confirmation}
              disabled={busy}
              onChange={(e) => setConfirmation(e.target.value)}
            />
            {shownError && <FieldError>{shownError}</FieldError>}
          </FormSection>
          <chakra.p fontSize="xs" color="app.textWarning">
            {t("profileBackupWarning")}
          </chakra.p>
          {/* Enter キーでの送信用 (フッターのボタンはフォーム外にある)。 */}
          <chakra.button type="submit" display="none" aria-hidden tabIndex={-1} />
        </chakra.form>
      </ModalBody>
      <ModalFooter>
        <div style={{ flex: 1 }} />
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
          {t("confirmDefaultCancel")}
        </Button>
        <PressableButton
          type="button"
          variant="primary"
          disabled={busy || error !== null}
          onClick={() => void submit()}
        >
          {busy ? t("profileBackupExporting") : t("profileBackupExportConfirm")}
        </PressableButton>
      </ModalFooter>
    </Modal>
  );
}
