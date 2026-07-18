import { chakra, Flex } from "@chakra-ui/react";
import { useT } from "../i18n";
import type { ConnectionProfile } from "../api/tauri";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, PressableButton } from "./ui";
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

  return (
    <Modal width="520px" onClose={onCancel}>
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
            <chakra.pre
              whiteSpace="pre-wrap"
              wordBreak="break-word"
              fontFamily="var(--font-mono)"
              fontSize="xs"
              p="2"
              borderRadius="sm"
              bg="app.surfaceMuted"
            >
              {message}
            </chakra.pre>
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
        <div style={{ flex: 1 }} />
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
          {t("hostKeyMismatchCancel")}
        </Button>
        <PressableButton
          type="button"
          variant="danger"
          disabled={busy}
          onClick={onReTrust}
        >
          {busy ? t("hostKeyMismatchReTrusting") : t("hostKeyMismatchReTrust")}
        </PressableButton>
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
