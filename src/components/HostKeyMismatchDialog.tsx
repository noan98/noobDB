import { chakra, Flex } from "@chakra-ui/react";
import { useT } from "../i18n";
import type { ConnectionProfile } from "../api/tauri";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, PressableButton } from "./ui";

/**
 * Parse the stored/presented SSH host-key fingerprints out of an
 * `AppError::SshHostKeyMismatch` message so the dialog can show them side by
 * side. Pure and message-format tolerant: returns `null` if either fingerprint
 * can't be found, in which case the caller falls back to showing the raw
 * message. Kept separate from rendering so it can be unit-tested (#682).
 *
 * The backend message reads: `ssh host key mismatch for <host>:<port>: stored
 * fingerprint <expected>, server presented <actual>. ...`.
 */
export function parseHostKeyFingerprints(
  message: string,
): { expected: string; actual: string } | null {
  const m = /stored fingerprint\s+(\S+?),\s+server presented\s+(\S+?)[.\s]/i.exec(message);
  if (!m) return null;
  return { expected: m[1], actual: m[2] };
}

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
