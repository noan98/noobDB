import { useRef } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { useT } from "../i18n";
import type { ConnectionProfile } from "../api/tauri";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { CodePreview } from "./modalForm";
import { Button } from "./ui";
import { parseHostKeyFingerprints } from "./hostKeyFingerprints";

// Re-exported for existing importers (tests, App.tsx pins the approved key).
export { parseHostKeyFingerprints };

interface Props {
  /** The profile whose SSH connection hit a host-key mismatch. */
  profile: ConnectionProfile;
  /** The raw backend error message (carries both fingerprints). */
  message: string;
  /** True while forgetting the key + reconnecting is in flight. */
  busy: boolean;
  /** Forget the stored host key and reconnect (parent wires this). */
  onReTrust: () => void;
  onCancel: () => void;
}

/**
 * Recovery dialog shown when an SSH connection is refused because the server's
 * host key no longer matches the one recorded on first use (TOFU mismatch,
 * #682). A rotated server key is a legitimate operational event, but so is a
 * man-in-the-middle attack — so the dialog shows both fingerprints, warns the
 * user to verify the new one out-of-band, and only then offers a one-click
 * "forget & reconnect" that re-trusts the new key.
 */
export function HostKeyMismatchDialog({ profile, message, busy, onReTrust, onCancel }: Props) {
  const t = useT();
  const fps = parseHostKeyFingerprints(message);
  const sshEndpoint = profile.ssh ? `${profile.ssh.host}:${profile.ssh.port}` : "";
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  return (
    <Modal
      // no-submit: ホスト鍵の再信頼は破壊的操作。キャンセルが既定
      width="520px" onClose={onCancel} initialFocusEl={() => cancelRef.current}>
      <ModalHeader onClose={onCancel} closeLabel={t("hostKeyMismatchCancel")}>
        {t("hostKeyMismatchTitle")}
      </ModalHeader>
      <ModalBody>
        <Flex direction="column" gap="3" fontSize="sm">
          <chakra.p>{t("hostKeyMismatchIntro", { endpoint: sshEndpoint })}</chakra.p>
          {fps ? (
            <Flex direction="column" gap="1.5">
              <FingerprintRow label={t("hostKeyMismatchStored")} value={fps.expected} />
              <FingerprintRow label={t("hostKeyMismatchPresented")} value={fps.actual} />
            </Flex>
          ) : (
            <CodePreview wrap>{message}</CodePreview>
          )}
          <chakra.p
            p="2"
            borderRadius="sm"
            bg="app.bgError"
            color="app.textError"
            fontWeight={500}
          >
            {t("hostKeyMismatchWarning")}
          </chakra.p>
        </Flex>
      </ModalBody>
      <ModalFooter>
        {/* ホスト鍵の再信頼は中間者攻撃を受け入れうる破壊的・不可逆な操作なので、
            ModalFooter の「破壊的」パターン (#1114) に従う: 実行は左に非強調、
            右端のキャンセルを primary + 初期フォーカスにして stray Enter で
            再信頼が走らないようにする。 */}
        <Button type="button" variant="dangerOutline" disabled={busy} onClick={onReTrust}>
          {busy ? t("hostKeyMismatchReTrusting") : t("hostKeyMismatchReTrust")}
        </Button>
        <div style={{ flex: 1 }} />
        <Button ref={cancelRef} type="button" variant="primary" onClick={onCancel} disabled={busy}>
          {t("hostKeyMismatchCancel")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

function FingerprintRow({ label, value }: { label: string; value: string }) {
  return (
    <Flex direction="column" gap="0.5">
      <chakra.span fontSize="xs" opacity={0.75}>
        {label}
      </chakra.span>
      <chakra.code
        fontFamily="var(--font-mono)"
        fontSize="xs"
        p="1.5"
        borderRadius="sm"
        bg="app.surfaceMuted"
        wordBreak="break-all"
      >
        {value}
      </chakra.code>
    </Flex>
  );
}
