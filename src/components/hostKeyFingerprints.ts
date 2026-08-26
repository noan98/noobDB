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
 *
 * **IPv6 hosts (#1053).** The backend never brackets the host (it interpolates
 * `SshConfig`'s plain `host` field directly, see `error.rs`), so an IPv6
 * endpoint renders as `2001:db8::1:22` — a host containing colons immediately
 * followed by the port. A naive `([^\s:]+):(\d+)` can't tell where the host
 * ends and the port begins in that case (it matched fine for IPv4/FQDN/
 * single-label hosts, which never contain `:`, but produced `undefined`
 * host/port for IPv6). Instead of forbidding `:` in the host, the pattern
 * below anchors on the literal text that always follows the port in this
 * message format (`": stored fingerprint"`) and lets the host capture be
 * lazy (`+?`): the regex engine tries the shortest possible host first and
 * only extends past a `:` when what follows doesn't parse as `<port>: stored
 * fingerprint`, so it naturally lands on the *last* `:<digits>:` boundary in
 * the string — which is exactly the host/port separator, however many
 * colons the host itself contains. A bracketed form (`[2001:db8::1]:2222`)
 * is matched explicitly first for robustness even though the backend doesn't
 * currently emit it (RFC 3986 host:port disambiguation is the more common
 * convention elsewhere, and it's unambiguous by construction).
 */
export function parseHostKeyFingerprints(
  message: string,
): { expected: string; actual: string; host?: string; port?: number } | null {
  const m = /stored fingerprint\s+(\S+?),\s+server presented\s+(\S+?)[.\s]/i.exec(message);
  if (!m) return null;
  const endpoint =
    /ssh host key mismatch for (?:\[([^\]]+)\]|(\S+?)):(\d+): stored fingerprint/i.exec(message);
  const host = endpoint?.[1] ?? endpoint?.[2];
  return {
    expected: m[1],
    actual: m[2],
    ...(endpoint && host ? { host, port: Number(endpoint[3]) } : {}),
  };
}
