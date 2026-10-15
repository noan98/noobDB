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
//! supported: `Match` criteria other than `all` / `host` / `originalhost`
//! (such blocks are treated as not matching), and `~`/env expansion anywhere
//! other than a leading `~/` (#1630 added `Host *` / wildcard and negated
//! patterns, `Include` with simple filename globs, and `Match host|all`). A `ProxyJump` value naming more than
//! one hop (`bastion1,bastion2`) only resolves the first — this app caps
//! tunnels at one jump hop (2 SSH hops total) as of #708.

use std::path::{Path, PathBuf};

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

/// Parse `content` (the raw file text) and resolve settings for `alias`
/// following OpenSSH's "first obtained value wins" rule (#1630):
///
/// - `Host` patterns support `*` / `?` wildcards and `!negation`; a block
///   applies when some positive pattern matches and no negated one does.
///   Matching is case-sensitive like OpenSSH's `Host`.
/// - Directives that appear before the first `Host` / `Match` apply to every
///   host, and a generic `Host *` block placed after a specific one only
///   fills the fields the specific block left unset.
/// - `Match all` and `Match host <patterns>` / `Match originalhost <patterns>`
///   are evaluated; any `Match` using other criteria (`exec`, `user`, ...) is
///   treated as not matching, since it can't be decided without the context
///   OpenSSH has at connect time.
/// - `Include` is *not* followed here (this function only sees `content`);
///   use [`resolve_host_with_includes`] to expand it first.
///
/// Returns `None` when no block names `alias` explicitly (a bare `Host *`
/// alone does not make an alias "known"), so the caller can distinguish
/// "unknown alias" from "known alias, config just doesn't say much".
pub fn resolve_host(content: &str, alias: &str) -> Option<ResolvedSshHost> {
    // Directives before the first Host / Match are global.
    let mut in_block = true;
    let mut found = false;
    let mut out = ResolvedSshHost::default();
    // `ProxyJump none` は「踏み台を使わない」の明示で、最初に得た値として後続ブロックの
    // ProxyJump も打ち消す (値としては `None` のまま)。
    let mut proxy_decided = false;
    for raw_line in content.lines() {
        let Some((key, rest)) = split_directive(raw_line) else {
            continue;
        };
        let key_lower = key.to_ascii_lowercase();
        if key_lower == "host" {
            let (matched, explicit) = host_patterns_match(rest, alias);
            in_block = matched;
            if matched && explicit {
                found = true;
            }
            continue;
        }
        if key_lower == "match" {
            // 条件は host / all だけ評価する。判定できない条件 (exec / user 等) の
            // ブロックは適用しない (誤適用より未適用を選ぶ)。
            in_block = match_condition_holds(rest, alias);
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
            "proxyjump" if !proxy_decided => {
                proxy_decided = true;
                if !rest.eq_ignore_ascii_case("none") {
                    out.proxy_jump = Some(rest.to_string());
                }
            }
            _ => {}
        }
    }
    if found {
        Some(out)
    } else {
        None
    }
}

/// `Host` 行のパターン列が `alias` に適用されるか。戻り値は (適用するか,
/// 明示的な名前 (ワイルドカードだけの `*` ではない肯定パターン) で一致したか)。
fn host_patterns_match(patterns: &str, alias: &str) -> (bool, bool) {
    let mut matched = false;
    let mut explicit = false;
    for pat in patterns.split_whitespace() {
        if let Some(neg) = pat.strip_prefix('!') {
            if glob_match(neg, alias) {
                // 否定パターンに一致したらブロック全体が不適用。
                return (false, false);
            }
        } else if glob_match(pat, alias) {
            matched = true;
            if pat != "*" {
                explicit = true;
            }
        }
    }
    (matched, explicit)
}

/// `Match` 行の条件が成り立つか。`all` と `host` / `originalhost` (パターン列) だけ
/// 評価し、複数条件はすべて成り立つ場合のみ真 (OpenSSH と同じ AND)。それ以外の条件が
/// 1 つでもあれば偽。
fn match_condition_holds(rest: &str, alias: &str) -> bool {
    let tokens: Vec<&str> = rest.split_whitespace().collect();
    if tokens.is_empty() {
        return false;
    }
    let mut i = 0;
    while i < tokens.len() {
        let crit = tokens[i].to_ascii_lowercase();
        match crit.as_str() {
            "all" => i += 1,
            "host" | "originalhost" => {
                let Some(list) = tokens.get(i + 1) else {
                    return false;
                };
                // パターンはカンマ区切り (`host a.example,!b.example`)。
                let joined = list.replace(',', " ");
                let (matched, _) = host_patterns_match(&joined, alias);
                if !matched {
                    return false;
                }
                i += 2;
            }
            _ => return false,
        }
    }
    true
}

/// `*` (任意長) と `?` (1 文字) だけのシンプルな glob 照合。
fn glob_match(pattern: &str, text: &str) -> bool {
    fn go(p: &[char], t: &[char]) -> bool {
        match p.first() {
            None => t.is_empty(),
            Some('*') => (0..=t.len()).any(|k| go(&p[1..], &t[k..])),
            Some('?') => !t.is_empty() && go(&p[1..], &t[1..]),
            Some(c) => t.first() == Some(c) && go(&p[1..], &t[1..]),
        }
    }
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    go(&p, &t)
}

/// `Include` の再帰上限 (OpenSSH は 16)。循環や深い入れ子で暴走しないための保険。
const MAX_INCLUDE_DEPTH: usize = 8;
/// 読み込む設定ファイル 1 つあたりの上限。
const MAX_CONFIG_BYTES: u64 = 1024 * 1024;

/// `content` の `Include` 行を `base_dir` 基準で展開した 1 本のテキストにする。
/// 相対パスは `base_dir` (通常は `~/.ssh`) 起点、`~/` はホーム、ファイル名部分の
/// `*` / `?` は辞書順に展開する。読めないファイルは黙って飛ばす (best-effort)。
pub fn expand_includes(content: &str, base_dir: &Path) -> String {
    let mut out = String::new();
    expand_into(content, base_dir, 0, &mut out);
    out
}

fn expand_into(content: &str, base_dir: &Path, depth: usize, out: &mut String) {
    for line in content.lines() {
        let is_include = split_directive(line)
            .filter(|(k, _)| k.eq_ignore_ascii_case("include"))
            .map(|(_, rest)| rest.to_string());
        let Some(arg) = is_include else {
            out.push_str(line);
            out.push('\n');
            continue;
        };
        if depth >= MAX_INCLUDE_DEPTH {
            continue;
        }
        for token in arg.split_whitespace() {
            for file in include_targets(token, base_dir) {
                let Some(text) = read_limited(&file) else {
                    continue;
                };
                expand_into(&text, base_dir, depth + 1, out);
            }
        }
    }
}

fn read_limited(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_CONFIG_BYTES {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

/// `Include` の 1 トークンが指すファイル一覧 (glob はファイル名部分のみ)。
fn include_targets(token: &str, base_dir: &Path) -> Vec<PathBuf> {
    let expanded = expand_tilde(token.trim_matches('"'));
    let path = PathBuf::from(&expanded);
    let path = if path.is_absolute() {
        path
    } else {
        base_dir.join(path)
    };
    let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
        return Vec::new();
    };
    if !name.contains(['*', '?']) {
        return vec![path];
    }
    let Some(dir) = path.parent() else {
        return Vec::new();
    };
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut hits: Vec<PathBuf> = rd
        .filter_map(|e| e.ok())
        .filter(|e| glob_match(&name, &e.file_name().to_string_lossy()))
        .map(|e| e.path())
        .collect();
    hits.sort();
    hits
}

/// [`expand_includes`] で `Include` を辿ってから [`resolve_host`] する (#1630)。
pub fn resolve_host_with_includes(
    content: &str,
    alias: &str,
    base_dir: &Path,
) -> Option<ResolvedSshHost> {
    resolve_host(&expand_includes(content, base_dir), alias)
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
    let (host, port) = if let Some(rest) = host_port.strip_prefix('[') {
        // `[2001:db8::1]:2222` — 角括弧内がホスト、`]` の後ろの `:port` がポート。
        let (h, after) = rest.split_once(']')?;
        if h.is_empty() {
            return None;
        }
        let port = after.strip_prefix(':').filter(|p| !p.is_empty());
        (h.to_string(), port.and_then(|p| p.parse().ok()))
    } else if host_port.matches(':').count() >= 2 {
        // 括弧の無い裸の IPv6 (`2001:db8::1`) はポート無しとして扱う。
        (host_port.to_string(), None)
    } else {
        match host_port.rsplit_once(':') {
            Some((h, p)) if !h.is_empty() && !p.is_empty() => (h.to_string(), p.parse().ok()),
            _ => (host_port.to_string(), None),
        }
    };
    Some(ProxyJumpTarget { user, host, port })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Match ブロックの中身は直前の Host に紐付けない (#1593)。
    #[test]
    fn match_block_body_is_not_attributed_to_previous_host() {
        let content =
            "Host prod\n  HostName 10.0.0.5\nMatch host other.example\n  User admin\n  Port 2200\n";
        let r = resolve_host(content, "prod").unwrap();
        assert_eq!(r.host_name.as_deref(), Some("10.0.0.5"));
        assert_eq!(r.user, None);
        assert_eq!(r.port, None);
    }

    // ProxyJump none は踏み台なし。後続ブロックの ProxyJump にも上書きされない。
    #[test]
    fn proxy_jump_none_means_no_jump_host() {
        let content =
            "Host db\n  HostName 10.0.0.9\n  ProxyJump None\nHost db\n  ProxyJump bastion\n";
        let r = resolve_host(content, "db").unwrap();
        assert_eq!(r.proxy_jump, None);
    }

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
    fn wildcard_patterns_match_like_openssh() {
        let content = "Host bastion*\n  HostName bastion.example.com\n";
        let r = resolve_host(content, "bastion1").unwrap();
        assert_eq!(r.host_name.as_deref(), Some("bastion.example.com"));
        assert!(resolve_host(content, "other").is_none());
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

    #[test]
    fn proxy_jump_handles_ipv6() {
        let bare = parse_proxy_jump("2001:db8::1").unwrap();
        assert_eq!(bare.host, "2001:db8::1");
        assert_eq!(bare.port, None);
        let bracketed = parse_proxy_jump("ops@[2001:db8::1]:2222").unwrap();
        assert_eq!(bracketed.user.as_deref(), Some("ops"));
        assert_eq!(bracketed.host, "2001:db8::1");
        assert_eq!(bracketed.port, Some(2222));
        let bracketed_no_port = parse_proxy_jump("[::1]").unwrap();
        assert_eq!(bracketed_no_port.host, "::1");
        assert_eq!(bracketed_no_port.port, None);
    }

    // #1630: Host * は後ろから適用され、具体的なブロックの値は上書きしない。
    #[test]
    fn host_star_fills_only_unset_fields() {
        let content = "\
Host db
  HostName 10.0.0.5
  User alice
Host *
  User common
  Port 2200
  IdentityFile /keys/common
  ProxyJump jump.example.com
";
        let r = resolve_host(content, "db").unwrap();
        assert_eq!(r.host_name.as_deref(), Some("10.0.0.5"));
        assert_eq!(r.user.as_deref(), Some("alice"));
        assert_eq!(r.port, Some(2200));
        assert_eq!(r.identity_file.as_deref(), Some("/keys/common"));
        assert_eq!(r.proxy_jump.as_deref(), Some("jump.example.com"));
    }

    // Host * だけでは alias を「既知」にしない。
    #[test]
    fn host_star_alone_does_not_make_alias_known() {
        assert!(resolve_host("Host *\n  User x\n", "anything").is_none());
    }

    // ファイル先頭 (Host 前) の指定は全ホスト共通。
    #[test]
    fn global_directives_before_first_host_apply() {
        let content = "User globaluser\nHost a\n  HostName a.example\n";
        let r = resolve_host(content, "a").unwrap();
        assert_eq!(r.user.as_deref(), Some("globaluser"));
    }

    #[test]
    fn negated_pattern_excludes_block() {
        let content = "Host *.example.com !secret.example.com\n  User ops\nHost secret.example.com\n  HostName 1.2.3.4\n";
        assert_eq!(
            resolve_host(content, "web.example.com")
                .unwrap()
                .user
                .as_deref(),
            Some("ops")
        );
        let r = resolve_host(content, "secret.example.com").unwrap();
        assert_eq!(r.user, None);
    }

    #[test]
    fn match_host_and_all_are_evaluated_others_are_not() {
        let content = "\
Host t
  HostName t.example
Match host t,u
  User matched
Match user bob
  Port 2201
Match all
  IdentityFile /keys/all
";
        let r = resolve_host(content, "t").unwrap();
        assert_eq!(r.user.as_deref(), Some("matched"));
        assert_eq!(r.port, None);
        assert_eq!(r.identity_file.as_deref(), Some("/keys/all"));
        // 条件に合わない host では適用されない。
        let r2 = resolve_host("Host x\n  HostName x\nMatch host t\n  User no\n", "x").unwrap();
        assert_eq!(r2.user, None);
    }

    #[test]
    fn include_is_expanded_relative_to_base_dir_with_globs() {
        let dir = std::env::temp_dir().join(format!("noobdb-cfg-{}", std::process::id()));
        let conf_d = dir.join("conf.d");
        std::fs::create_dir_all(&conf_d).unwrap();
        std::fs::write(conf_d.join("a.conf"), "Host inc\n  HostName inc.example\n").unwrap();
        std::fs::write(conf_d.join("b.conf"), "Host *\n  User fromb\n").unwrap();
        std::fs::write(conf_d.join("skip.txt"), "Host inc\n  User wrong\n").unwrap();
        let content = "Include conf.d/*.conf\nInclude missing.conf\n";
        let r = resolve_host_with_includes(content, "inc", &dir).unwrap();
        assert_eq!(r.host_name.as_deref(), Some("inc.example"));
        assert_eq!(r.user.as_deref(), Some("fromb"));
        // Include を辿らない resolve_host では見つからない。
        assert!(resolve_host(content, "inc").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn include_cycle_terminates() {
        let dir = std::env::temp_dir().join(format!("noobdb-cfg-cycle-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("loop"), "Include loop\nHost l\n  User u\n").unwrap();
        let r = resolve_host_with_includes("Include loop\n", "l", &dir).unwrap();
        assert_eq!(r.user.as_deref(), Some("u"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
