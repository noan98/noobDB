//! Read-only, best-effort parser for a subset of the OpenSSH client config
//! format (`~/.ssh/config`, #708). Resolves `HostName` / `Port` / `User` /
//! `IdentityFile` / `ProxyJump` for a given `Host` alias so the connection form
//! can prefill fields from an alias the user's system `ssh` client already
//! knows about.
//!
//! This is a one-shot, save-time convenience: resolved values are copied into
//! the connection form (and, on save, the profile). The config file itself is
//! never read again at connect time — there is no runtime dependency on
//! `~/.ssh/config` surviving or staying in sync.
//!
//! Deliberately minimal, matching the "best-effort" spirit of the app's other
//! SQL safety nets (`is_read_only_sql`, `apply_auto_limit`): unrecognized
//! directives are ignored rather than rejected, so a config with directives
//! this parser doesn't understand still resolves the ones it does. Not
//! supported: `Include`, `Match`, wildcard/negated `Host` patterns (only an
//! exact, case-sensitive alias matches), and `~`/env expansion anywhere other
//! than a leading `~/` in `IdentityFile`. A `ProxyJump` value naming more than
//! one hop (`bastion1,bastion2`) only resolves the first — this app caps
//! tunnels at one jump hop (2 SSH hops total) as of #708.

use std::path::PathBuf;

/// The fields this parser can resolve for a `Host` alias.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ResolvedSshHost {
    pub host_name: Option<String>,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub identity_file: Option<String>,
    pub proxy_jump: Option<String>,
}

/// One `[user@]host[:port]` endpoint parsed out of a `ProxyJump` value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProxyJumpTarget {
    pub user: Option<String>,
    pub host: String,
    pub port: Option<u16>,
}

/// Parse `content` (the raw file text) and resolve settings for `alias` from
/// the first `Host` block whose patterns include an exact match for `alias`
/// (OpenSSH's "first obtained value wins" rule — later blocks for the same
/// alias never override a directive already resolved from an earlier one).
/// Wildcard host patterns are not matched — only an exact, case-sensitive
/// alias. Returns `None` when no block matches `alias` at all (as opposed to
/// matching but resolving nothing), so the caller can distinguish "unknown
/// alias" from "known alias, config just doesn't say much".
pub fn resolve_host(content: &str, alias: &str) -> Option<ResolvedSshHost> {
    let mut in_block = false;
    let mut found = false;
    let mut out = ResolvedSshHost::default();
    for raw_line in content.lines() {
        let Some((key, rest)) = split_directive(raw_line) else {
            continue;
        };
        let key_lower = key.to_ascii_lowercase();
        if key_lower == "host" {
            // A new `Host` directive starts a new block; patterns are
            // whitespace-separated, exact match only (no glob support).
            in_block = rest.split_whitespace().any(|pattern| pattern == alias);
            if in_block {
                found = true;
            }
            continue;
        }
        if !in_block {
            continue;
        }
        // "First obtained value wins" — matches real OpenSSH behavior, so a
        // later, more general `Host *` block can't silently override an
        // already-resolved specific setting.
        match key_lower.as_str() {
            "hostname" if out.host_name.is_none() => out.host_name = Some(rest.to_string()),
            "port" if out.port.is_none() => out.port = rest.parse().ok(),
            "user" if out.user.is_none() => out.user = Some(rest.to_string()),
            "identityfile" if out.identity_file.is_none() => {
                out.identity_file = Some(expand_tilde(rest))
            }
            "proxyjump" if out.proxy_jump.is_none() => out.proxy_jump = Some(rest.to_string()),
            _ => {}
        }
    }
    if found {
        Some(out)
    } else {
        None
    }
}

/// Split one config line into `(directive, value)`, skipping blank lines,
/// `#` comments, and anything malformed. OpenSSH accepts either whitespace or
/// a single `=` (optionally surrounded by whitespace) as the separator; both
/// forms are common in the wild, so both are accepted here.
fn split_directive(raw_line: &str) -> Option<(&str, &str)> {
    let line = raw_line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let sep = line.find(|c: char| c.is_whitespace() || c == '=')?;
    let (key, rest) = line.split_at(sep);
    let rest = rest
        .trim_start_matches(|c: char| c.is_whitespace() || c == '=')
        .trim();
    if key.is_empty() || rest.is_empty() {
        return None;
    }
    Some((key, rest))
}

/// Expand a leading `~/` against `$HOME` (`%USERPROFILE%` on Windows). Any
/// other form (bare `~`, `~user/...`, no tilde at all) is returned unchanged —
/// this mirrors the app's existing "best effort, never fail loudly" stance
/// rather than trying to fully replicate shell tilde expansion.
fn expand_tilde(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = home_dir() {
            return home.join(rest).to_string_lossy().into_owned();
        }
    }
    path.to_string()
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Parse a `ProxyJump` directive's value into its first hop. OpenSSH allows a
/// comma-separated chain of jumps (`ProxyJump bastion1,bastion2`) for
/// arbitrarily deep nesting; this app caps tunnels at one jump hop (#708), so
/// only the first entry is resolved — later entries are silently ignored
/// rather than rejected, consistent with this parser's best-effort stance.
pub fn parse_proxy_jump(value: &str) -> Option<ProxyJumpTarget> {
    let first = value.split(',').next()?.trim();
    if first.is_empty() {
        return None;
    }
    let (user, host_port) = match first.split_once('@') {
        Some((u, rest)) if !u.is_empty() => (Some(u.to_string()), rest),
        _ => (None, first),
    };
    if host_port.is_empty() {
        return None;
    }
    let (host, port) = match host_port.rsplit_once(':') {
        Some((h, p)) if !h.is_empty() && !p.is_empty() => (h.to_string(), p.parse().ok()),
        _ => (host_port.to_string(), None),
    };
    Some(ProxyJumpTarget { user, host, port })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_hostname_port_user_and_identity_file() {
        let content = "\
Host bastion
  HostName bastion.example.com
  Port 2222
  User ops
  IdentityFile ~/.ssh/id_bastion
";
        let resolved = resolve_host(content, "bastion").expect("alias matches");
        assert_eq!(resolved.host_name.as_deref(), Some("bastion.example.com"));
        assert_eq!(resolved.port, Some(2222));
        assert_eq!(resolved.user.as_deref(), Some("ops"));
        // Tilde expansion needs $HOME; just assert it no longer starts with "~/".
        assert!(!resolved.identity_file.unwrap().starts_with("~/"));
    }

    #[test]
    fn unknown_alias_returns_none() {
        let content = "Host bastion\n  HostName bastion.example.com\n";
        assert!(resolve_host(content, "nope").is_none());
    }

    #[test]
    fn known_alias_with_no_directives_returns_some_default() {
        let content = "Host empty\nHost bastion\n  HostName bastion.example.com\n";
        let resolved = resolve_host(content, "empty").expect("alias matches, even if empty");
        assert_eq!(resolved, ResolvedSshHost::default());
    }

    #[test]
    fn multiple_space_separated_patterns_all_match() {
        let content = "Host bastion prod-bastion\n  HostName bastion.example.com\n";
        assert!(resolve_host(content, "prod-bastion").is_some());
    }

    #[test]
    fn wildcard_patterns_are_not_matched() {
        // This parser intentionally doesn't implement glob matching.
        let content = "Host bastion*\n  HostName bastion.example.com\n";
        assert!(resolve_host(content, "bastion1").is_none());
    }

    #[test]
    fn first_obtained_value_wins_over_a_later_block_for_the_same_alias() {
        // Both blocks list `target` explicitly (this parser does not match
        // wildcard `Host *` patterns — see `wildcard_patterns_are_not_matched`
        // below), so this exercises "first obtained value wins" the way this
        // parser can actually encounter it: two literal blocks for the same
        // alias.
        let content = "\
Host target
  HostName target.internal
  User specific

Host target
  User generic
  Port 2200
";
        let resolved = resolve_host(content, "target").unwrap();
        // `User` was already resolved in the first block, so the second
        // block's `User generic` must not override it — but `Port`, unset so
        // far, is still picked up from it.
        assert_eq!(resolved.user.as_deref(), Some("specific"));
        assert_eq!(resolved.port, Some(2200));
    }

    #[test]
    fn comments_and_blank_lines_and_equals_separator_are_tolerated() {
        let content = "\
# a comment
Host bastion
  # nested comment
  HostName=bastion.example.com

  Port = 2222
";
        let resolved = resolve_host(content, "bastion").unwrap();
        assert_eq!(resolved.host_name.as_deref(), Some("bastion.example.com"));
        assert_eq!(resolved.port, Some(2222));
    }

    #[test]
    fn proxy_jump_resolves_host_and_ssh_config_carries_it() {
        let content = "\
Host target
  HostName target.internal
  ProxyJump ops@bastion.example.com:2222
";
        let resolved = resolve_host(content, "target").unwrap();
        assert_eq!(
            resolved.proxy_jump.as_deref(),
            Some("ops@bastion.example.com:2222")
        );
    }

    #[test]
    fn unrecognized_directives_are_ignored_not_rejected() {
        let content = "\
Host bastion
  HostName bastion.example.com
  ForwardAgent yes
  ServerAliveInterval 30
  Compression yes
";
        let resolved = resolve_host(content, "bastion").unwrap();
        assert_eq!(resolved.host_name.as_deref(), Some("bastion.example.com"));
    }

    #[test]
    fn parse_proxy_jump_splits_user_host_port() {
        assert_eq!(
            parse_proxy_jump("ops@bastion.example.com:2222"),
            Some(ProxyJumpTarget {
                user: Some("ops".into()),
                host: "bastion.example.com".into(),
                port: Some(2222),
            })
        );
    }

    #[test]
    fn parse_proxy_jump_without_user_or_port() {
        assert_eq!(
            parse_proxy_jump("bastion.example.com"),
            Some(ProxyJumpTarget {
                user: None,
                host: "bastion.example.com".into(),
                port: None,
            })
        );
    }

    #[test]
    fn parse_proxy_jump_only_resolves_the_first_hop_of_a_chain() {
        // Multi-jump ProxyJump chains beyond one hop are out of scope (#708
        // caps tunnels at 2 hops total); only the first entry is used.
        assert_eq!(
            parse_proxy_jump("bastion1.example.com,bastion2.example.com"),
            Some(ProxyJumpTarget {
                user: None,
                host: "bastion1.example.com".into(),
                port: None,
            })
        );
    }

    #[test]
    fn parse_proxy_jump_rejects_empty_value() {
        assert_eq!(parse_proxy_jump(""), None);
        assert_eq!(parse_proxy_jump("  "), None);
    }
}
