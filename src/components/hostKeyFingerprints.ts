/**
 * Parse the stored/presented SSH host-key fingerprints out of an
 * `AppError::SshHostKeyMismatch` message so the mismatch dialog can show them
 * side by side and the re-trust flow can pin the approved (presented) one.
 * Pure and message-format tolerant: returns `null` if either fingerprint can't
 * be found, in which case callers fall back (raw message / plain forget). Kept
 * in its own module so `App.tsx` can import it without pulling the lazy-loaded
 * dialog component into the main bundle (#682).
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
