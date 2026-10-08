// `src-tauri/src/commands/ssh.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { ResolvedSshAlias, KnownHost } from "../tauri";

export const sshCommands = {
  /**
   * List the SSH known_hosts entries (host:port + fingerprint). Backs the
   * Settings known_hosts panel and the host-key mismatch recovery flow (#682).
   */
  listKnownHosts: () =>
    invoke<KnownHost[]>("list_known_hosts").then((r) =>
      parseResponse(schemas.knownHostArray, r, "list_known_hosts"),
    ),
  /**
   * Forget the known_hosts entry for `host:port`, so the next connection
   * re-trusts the server's (possibly rotated) key via TOFU. Resolves to `true`
   * when an entry was actually removed (#682).
   */
  forgetHostKey: (host: string, port: number) =>
    invoke<boolean>("forget_host_key", { host, port }),
  /**
   * Pin `host:port` to exactly `fingerprint`, replacing any existing entry. The
   * host-key mismatch recovery flow passes the fingerprint the user approved in
   * the dialog, then reconnects — so the reconnect is verified against that
   * pinned key and a different (MITM) key is rejected instead of TOFU-accepted
   * (#682 review follow-up).
   */
  trustHostKey: (host: string, port: number, fingerprint: string) =>
    invoke<void>("trust_host_key", { host, port, fingerprint }),
  /**
   * Resolve `HostName` / `Port` / `User` / `IdentityFile` / `ProxyJump` for
   * `alias` from the user's `~/.ssh/config`, for the connection form's "load
   * from SSH config" action (#708). Read-only and best-effort: `null` covers
   * both "no ~/.ssh/config" and "no matching Host block", not just one.
   */
  resolveSshConfigHost: (alias: string) =>
    invoke<ResolvedSshAlias | null>("resolve_ssh_config_host", { alias }).then((r) =>
      r === null ? null : parseResponse(schemas.resolvedSshAlias, r, "resolve_ssh_config_host"),
    ),
};
