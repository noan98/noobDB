/**
 * Parse the stored/presented SSH host-key fingerprints (and, when present,
 * the `host:port` the mismatch occurred on) out of an
 * `AppError::SshHostKeyMismatch` message so the mismatch dialog can show them
 * side by side and the re-trust flow can pin the approved (presented) one.
 * Pure and message-format tolerant: returns `null` if either fingerprint can't
 * be found, in which case callers fall back (raw message / plain forget). Kept
 * in its own module so `App.tsx` can import it without pulling the lazy-loaded
 * dialog component into the main bundle (#682).
 *
 * The backend message reads: `ssh host key mismatch for <host>:<port>: stored
 * fingerprint <expected>, server presented <actual>. ...`.
 *
 * `host`/`port` matter for a chained tunnel (#708 multi-hop): a mismatch can
 * occur on the bastion/jump hop rather than the main SSH host, and the error
 * always names the *actual* hop that failed (see `ssh/tunnel.rs`'s
 * `open_one_hop`), never just the profile's configured main hop. Callers that
 * need to re-trust the *right* endpoint should prefer these over a profile's
 * static `ssh.host`/`ssh.port`, falling back to the profile only when parsing
 * fails (unexpected message format).
 */
export function parseHostKeyFingerprints(
  message: string,
): { expected: string; actual: string; host?: string; port?: number } | null {
  const m = /stored fingerprint\s+(\S+?),\s+server presented\s+(\S+?)[.\s]/i.exec(message);
  if (!m) return null;
  const endpoint = /ssh host key mismatch for ([^\s:]+):(\d+):/i.exec(message);
  return {
    expected: m[1],
    actual: m[2],
    ...(endpoint ? { host: endpoint[1], port: Number(endpoint[2]) } : {}),
  };
}
