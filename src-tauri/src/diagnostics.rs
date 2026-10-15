//! 匿名化した診断バンドル (#1622)。
//!
//! 不具合報告のためにアプリログへ版情報を付けて書き出す。**秘密情報と接続先は含めない**
//! のが最優先なので、ログ本文は次の順で伏せる (過剰に伏せる側へ倒す)。
//!
//! 1. 機微なキーの値 (`host=` / `user=` / `password=` / `path=` / `url=` など)
//! 2. シングルクォートの SQL リテラル → `'?'`
//! 3. ホームディレクトリ配下のユーザ名
//! 4. 認証情報付き URL・`user@host`・IPv4/IPv6・ホスト名らしいトークン
//!
//! パスワード等は元々ログに出さない設計だが、エラー文や外部ライブラリのメッセージに
//! 混ざる可能性への多層防御として行う。

const REDACTED: &str = "<redacted>";

/// 値を伏せるキーに含まれる部分文字列 (小文字で比較)。
const SENSITIVE_KEY_PARTS: &[&str] = &[
    "host", "addr", "user", "pass", "secret", "token", "key", "path", "url", "dsn", "endpoint",
    "server", "database", "dbname", "profile", "name", "email", "cert", "account",
];

/// ホスト名と誤認しないファイル拡張子 / 典型的な末尾ラベル。
const NON_HOST_SUFFIXES: &[&str] = &[
    "rs", "ts", "tsx", "js", "jsx", "json", "log", "txt", "toml", "md", "sql", "csv", "db",
    "sqlite", "so", "dll", "lock", "html", "css", "png", "yaml", "yml", "zip", "gz", "bak", "pem",
    "crt", "key", "exe", "dylib", "tmp", "lib", "a", "o", "h", "c", "cpp", "py", "sh", "conf",
    "cfg", "ini", "xml", "svg", "ico", "map", "wasm",
];

fn is_key_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-'
}

fn is_sensitive_key(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    // `ip` は `description` や `skip` を巻き込まないよう、区切られた語としてだけ見る。
    SENSITIVE_KEY_PARTS.iter().any(|p| k.contains(p)) || k.split(['_', '.', '-']).any(|w| w == "ip")
}

/// `key=value` 形式の機微な値を伏せる。値は `"..."` (エスケープ対応) か次の空白まで。
fn redact_key_values(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '=' {
            // 直前のキー部分 (すでに out に出力済み) を取り出す。
            let key: String = {
                let mut k: Vec<char> = out.chars().rev().take_while(|c| is_key_char(*c)).collect();
                k.reverse();
                k.into_iter().collect()
            };
            out.push('=');
            i += 1;
            if !key.is_empty() && is_sensitive_key(&key) && i < chars.len() {
                // 値の範囲を決める。
                if chars[i] == '"' {
                    let mut j = i + 1;
                    while j < chars.len() {
                        if chars[j] == '\\' {
                            j += 2;
                            continue;
                        }
                        if chars[j] == '"' {
                            j += 1;
                            break;
                        }
                        j += 1;
                    }
                    i = j.min(chars.len());
                } else {
                    while i < chars.len() && !chars[i].is_whitespace() {
                        i += 1;
                    }
                }
                out.push_str(REDACTED);
            }
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// シングルクォートの文字列リテラルを `'?'` に置き換える。英数字の直後のクォート
/// (`don't` のような省略形) は開始とみなさない。`''` は同じリテラル内のエスケープ。
fn redact_literals(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let opens = c == '\''
            && !(i > 0 && (chars[i - 1].is_alphanumeric() || chars[i - 1] == '\''))
            // 閉じクォートがあるときだけリテラルとみなす (行末までに無ければそのまま)。
            && chars[i + 1..].contains(&'\'');
        if opens {
            let mut j = i + 1;
            loop {
                if j >= chars.len() {
                    break;
                }
                if chars[j] == '\'' {
                    if chars.get(j + 1) == Some(&'\'') {
                        j += 2;
                        continue;
                    }
                    break;
                }
                j += 1;
            }
            out.push_str("'?'");
            i = (j + 1).min(chars.len());
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

/// `/home/<name>` / `/Users/<name>` / `C:\Users\<name>` のユーザ名を伏せる。
fn redact_home_paths(line: &str) -> String {
    let mut s = line.to_string();
    for marker in ["/home/", "/Users/", "\\Users\\", "/users/"] {
        let mut out = String::with_capacity(s.len());
        let mut rest = s.as_str();
        while let Some(pos) = rest.find(marker) {
            let (head, tail) = rest.split_at(pos + marker.len());
            out.push_str(head);
            let end = tail
                .find(|c: char| c == '/' || c == '\\' || c.is_whitespace() || c == '"' || c == '\'')
                .unwrap_or(tail.len());
            out.push_str(REDACTED);
            rest = &tail[end..];
        }
        out.push_str(rest);
        s = out;
    }
    s
}

fn is_ipv4(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    parts.len() == 4
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 3 && p.chars().all(|c| c.is_ascii_digit()))
}

/// 2 個以上のコロンと 16 進だけで構成されるトークン (IPv6 らしい)。`::` を含む
/// Rust のパス (`noobdb_lib::db`) は英字 g-z を含むので除外される。
fn is_ipv6ish(s: &str) -> bool {
    s.matches(':').count() >= 2
        && s.chars()
            .all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.')
        && s.chars().any(|c| c.is_ascii_hexdigit())
}

fn is_hostname_like(s: &str) -> bool {
    let labels: Vec<&str> = s.split('.').collect();
    if labels.len() < 2 {
        return false;
    }
    let ok_label = |l: &&str| {
        !l.is_empty()
            && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            && !l.starts_with('-')
            && !l.ends_with('-')
    };
    if !labels.iter().all(ok_label) {
        return false;
    }
    let tld = labels[labels.len() - 1].to_ascii_lowercase();
    tld.len() >= 2
        && tld.chars().all(|c| c.is_ascii_alphabetic())
        && !NON_HOST_SUFFIXES.contains(&tld.as_str())
}

/// 1 トークン (空白区切り) の前後の句読点を除いた中身を判定して伏せる。
fn redact_token(token: &str) -> String {
    const EDGE: &[char] = &[
        '(', ')', '[', ']', '{', '}', ',', ';', '"', '\'', '<', '>', '`',
    ];
    let start = token.len() - token.trim_start_matches(EDGE).len();
    let trimmed_end = token.trim_end_matches(EDGE);
    let end = trimmed_end.len().max(start);
    let (lead, core, trail) = (&token[..start], &token[start..end], &token[end..]);
    if core.is_empty() || core == REDACTED {
        return token.to_string();
    }
    // 末尾の `.` `:` は文末の句読点として外して判定する。
    let core_trim = core.trim_end_matches(['.', ':']);
    let punct = &core[core_trim.len()..];
    // ポート (`host:3306`) を外して判定する。
    let no_port = match core_trim.rsplit_once(':') {
        Some((h, p))
            if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) && !h.contains(':') =>
        {
            h
        }
        _ => core_trim,
    };
    let sensitive = core_trim.contains("://")
        || core_trim.contains('@')
        || is_ipv4(no_port)
        || is_ipv6ish(&core_trim.replace(['[', ']'], ""))
        || is_hostname_like(no_port);
    if sensitive {
        format!("{lead}{REDACTED}{punct}{trail}")
    } else {
        token.to_string()
    }
}

fn redact_tokens(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut cur = String::new();
    for c in line.chars() {
        if c.is_whitespace() {
            if !cur.is_empty() {
                out.push_str(&redact_token(&cur));
                cur.clear();
            }
            out.push(c);
        } else {
            cur.push(c);
        }
    }
    if !cur.is_empty() {
        out.push_str(&redact_token(&cur));
    }
    out
}

/// ログ 1 行分を匿名化する。
pub fn redact_log_line(line: &str) -> String {
    redact_tokens(&redact_home_paths(&redact_literals(&redact_key_values(
        line,
    ))))
}

/// ログ全体を行ごとに匿名化する。
pub fn redact_log_text(text: &str) -> String {
    text.lines()
        .map(redact_log_line)
        .collect::<Vec<_>>()
        .join("\n")
}

/// バンドルに載せる環境情報。いずれも秘密・接続先を含まない。
pub struct BundleMeta {
    pub app_version: String,
    pub os: String,
    pub arch: String,
    pub sqlx_version: String,
    pub libsqlite3_version: String,
    /// `None` なら正常。
    pub keyring_available: bool,
    pub keyring_reason: Option<String>,
    pub perf_enabled: bool,
}

impl BundleMeta {
    pub fn current(keyring_available: bool, keyring_reason: Option<&str>) -> Self {
        Self {
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            sqlx_version: option_env!("NOOBDB_SQLX_VERSION")
                .unwrap_or("unknown")
                .to_string(),
            libsqlite3_version: option_env!("NOOBDB_LIBSQLITE3_VERSION")
                .unwrap_or("unknown")
                .to_string(),
            keyring_available,
            keyring_reason: keyring_reason.map(str::to_string),
            perf_enabled: crate::perf::perf_enabled(),
        }
    }
}

/// 診断バンドル本文 (プレーンテキスト) を組み立てる。
pub fn build_bundle(log_text: &str, meta: &BundleMeta, perf: &[crate::perf::PerfSample]) -> String {
    let mut out = String::new();
    out.push_str("# noobDB diagnostic bundle\n");
    out.push_str("# Anonymized: hosts, users, paths, secrets and SQL literals are removed.\n\n");
    out.push_str(&format!("app_version: {}\n", meta.app_version));
    out.push_str(&format!("os: {} ({})\n", meta.os, meta.arch));
    out.push_str("supported_drivers: mysql, postgres, sqlite\n");
    out.push_str(&format!("sqlx: {}\n", meta.sqlx_version));
    out.push_str(&format!("libsqlite3-sys: {}\n", meta.libsqlite3_version));
    out.push_str(&format!(
        "keyring: {}{}\n",
        if meta.keyring_available {
            "available"
        } else {
            "unavailable"
        },
        meta.keyring_reason
            .as_deref()
            .map(|r| format!(" ({r})"))
            .unwrap_or_default()
    ));
    out.push_str(&format!(
        "perf_measurement: {}\n",
        if meta.perf_enabled { "on" } else { "off" }
    ));
    if !perf.is_empty() {
        out.push_str("\n## recent perf samples (newest first)\n");
        for s in perf {
            out.push_str(&format!(
                "{} kind={} sql_execute_ms={} emit_ms={} payload_bytes_approx={} rows={} columns={}\n",
                s.at_ms,
                s.kind,
                s.sql_execute_ms.map(|v| format!("{v:.1}")).unwrap_or_else(|| "-".into()),
                s.emit_ms.map(|v| format!("{v:.1}")).unwrap_or_else(|| "-".into()),
                s.payload_bytes_approx.map(|v| v.to_string()).unwrap_or_else(|| "-".into()),
                s.rows,
                s.columns
            ));
        }
    }
    out.push_str("\n## log (anonymized)\n");
    out.push_str(&redact_log_text(log_text));
    out.push('\n');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leaks(s: &str, needles: &[&str]) -> Vec<String> {
        needles
            .iter()
            .filter(|n| s.contains(**n))
            .map(|n| n.to_string())
            .collect()
    }

    #[test]
    fn key_values_of_sensitive_keys_are_redacted() {
        let line = r#"INFO connect host=db.internal.example.com port=3306 user=admin password=hunter2 ssh_host="bastion.corp.local" db_name=app"#;
        let out = redact_log_line(line);
        assert!(
            leaks(
                &out,
                &["db.internal", "admin", "hunter2", "bastion", "corp.local"]
            )
            .is_empty(),
            "{out}"
        );
        assert!(out.contains("port=3306"));
        assert!(out.contains("host=<redacted>"));
    }

    #[test]
    fn quoted_value_with_spaces_and_escapes_is_fully_removed() {
        let out = redact_log_line(r#"WARN passphrase="my \"secret\" phrase" ok=1"#);
        assert!(!out.contains("secret"), "{out}");
        assert!(!out.contains("my "), "{out}");
        assert!(out.contains("ok=1"));
    }

    #[test]
    fn sql_literals_are_masked_but_apostrophes_are_not() {
        let out = redact_log_line("ERROR query failed: INSERT INTO t VALUES ('alice@example.com', 'it''s a secret') can't connect");
        assert!(!out.contains("alice"), "{out}");
        assert!(!out.contains("secret"), "{out}");
        assert!(out.contains("'?'"));
        assert!(out.contains("can't connect"));
    }

    #[test]
    fn ips_urls_emails_and_hosts_in_free_text_are_redacted() {
        let line = "ERROR failed to connect to 10.0.3.21:5432 via postgres://u:p@pg.example.org/db for bob@corp.io (host db1.prod.example.net.)";
        let out = redact_log_line(line);
        assert!(
            leaks(
                &out,
                &[
                    "10.0.3.21",
                    "postgres://",
                    "pg.example",
                    "bob@",
                    "corp.io",
                    "db1.prod",
                    "u:p"
                ]
            )
            .is_empty(),
            "{out}"
        );
    }

    #[test]
    fn ipv6_is_redacted_and_rust_paths_are_kept() {
        let out = redact_log_line("DEBUG noobdb_lib::db::mysql: peer [2001:db8::1]:3306 ready in 12.5ms at src/db/mod.rs:42");
        assert!(!out.contains("2001:db8"), "{out}");
        assert!(out.contains("noobdb_lib::db::mysql"), "{out}");
        assert!(out.contains("12.5ms"), "{out}");
        assert!(out.contains("mod.rs:42"), "{out}");
    }

    #[test]
    fn home_directories_lose_the_user_name() {
        let out = redact_log_line(
            r"open /home/alice/.local/share/noobDB/profiles.json and C:\Users\Bob\AppData\x /Users/carol/Library",
        );
        assert!(leaks(&out, &["alice", "Bob", "carol"]).is_empty(), "{out}");
        assert!(out.contains("profiles.json"));
    }

    #[test]
    fn bundle_contains_versions_and_never_the_secrets() {
        let meta = BundleMeta {
            app_version: "1.2.3".into(),
            os: "linux".into(),
            arch: "x86_64".into(),
            sqlx_version: "0.9.0".into(),
            libsqlite3_version: "0.30.1".into(),
            keyring_available: false,
            keyring_reason: Some("storage_unavailable".into()),
            perf_enabled: true,
        };
        let log = "INFO connect host=secret-db.example.com user=root password=pw123\nERROR bad 192.168.1.9";
        let b = build_bundle(log, &meta, &[]);
        assert!(b.contains("app_version: 1.2.3"));
        assert!(b.contains("sqlx: 0.9.0"));
        assert!(b.contains("libsqlite3-sys: 0.30.1"));
        assert!(b.contains("keyring: unavailable (storage_unavailable)"));
        assert!(
            leaks(&b, &["secret-db", "pw123", "192.168", "root"]).is_empty(),
            "{b}"
        );
    }

    #[test]
    fn current_meta_has_embedded_versions() {
        let m = BundleMeta::current(true, None);
        assert!(!m.sqlx_version.is_empty());
        assert!(!m.libsqlite3_version.is_empty());
    }
}
