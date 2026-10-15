//! 匿名化した診断バンドル (#1622)。
//!
//! 不具合報告のためにアプリログへ版情報を付けて書き出す。**秘密情報と接続先は含めない**
//! のが最優先なので、ログ本文は次の順で伏せる (過剰に伏せる側へ倒す)。
//!
//! 1. 機微なキーの値 (`host=` / `user: ` / JSON の `"password":` など。`path=` 系は
//!    空白入りのパスを考慮して次の `key=` か行末まで)
//! 2. 引用符の中身 (`"..."` は `"?"`、シングルクォートの SQL リテラルは `'?'`)
//! 3. ホームディレクトリ配下のユーザ名
//! 4. 認証情報付き URL・`user@host`・IPv4/IPv6・UNC パス・ホスト名らしいトークン・
//!    `ホスト:ポート` (単一ラベルも)。`key=値` は `=` より後ろを値として判定する。
//!
//! パスワード等は元々ログに出さない設計だが、エラー文や外部ライブラリのメッセージに
//! 混ざる可能性への多層防御として行う。

const REDACTED: &str = "<redacted>";

/// 値を伏せるキーに含まれる部分文字列 (小文字で比較)。
const SENSITIVE_KEY_PARTS: &[&str] = &[
    "host", "addr", "user", "pass", "secret", "token", "key", "path", "url", "dsn", "endpoint",
    "server", "database", "dbname", "profile", "name", "email", "cert", "account", "remote",
    "peer", "target",
];

/// パス系のキー (語単位で判定)。
const PATH_KEY_PARTS: &[&str] = &["path", "dir", "file", "cwd", "home"];

/// `key: value` 形式で、散文の語として現れるため値を伏せないキー。
const PROSE_KEYS: &[&str] = &["keyring"];

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
    SENSITIVE_KEY_PARTS.iter().any(|p| k.contains(p))
        || is_path_key(key)
        || k.split(['_', '.', '-']).any(|w| w == "ip")
}

/// パス系のキーか。`profile` / `profile_id` に `file` が部分一致しないよう、`_` `.` `-`
/// 区切りの語単位で見る。
fn is_path_key(key: &str) -> bool {
    key.to_ascii_lowercase()
        .split(['_', '.', '-'])
        .any(|w| PATH_KEY_PARTS.contains(&w))
}

/// 出力済みの文字列の末尾にあるキーを取り出す。JSON の `"key"` (閉じ引用符つき) も扱う。
/// 戻り値は (キー, キーの直前の文字)。
fn trailing_key(out: &str) -> Option<(String, Option<char>)> {
    let mut rev = out.chars().rev().peekable();
    if rev.peek() == Some(&'"') {
        rev.next();
    }
    let mut key: Vec<char> = Vec::new();
    while let Some(&c) = rev.peek() {
        if is_key_char(c) {
            key.push(c);
            rev.next();
        } else {
            break;
        }
    }
    if key.is_empty() {
        return None;
    }
    key.reverse();
    Some((key.into_iter().collect(), rev.next()))
}

/// 引用符 `q` で始まる値の終わり (閉じ引用符の次の位置)。閉じが無ければ行末。
fn quoted_end(chars: &[char], start: usize) -> usize {
    let q = chars[start];
    let mut j = start + 1;
    while j < chars.len() {
        if chars[j] == '\\' {
            j += 2;
            continue;
        }
        if chars[j] == q {
            return j + 1;
        }
        j += 1;
    }
    chars.len()
}

/// 空白の直後に `ident=` が続く位置か (パス値の終端判定)。
fn next_key_follows(chars: &[char], ws: usize) -> bool {
    let mut j = ws;
    while j < chars.len() && chars[j].is_whitespace() {
        j += 1;
    }
    let s = j;
    while j < chars.len() && is_key_char(chars[j]) {
        j += 1;
    }
    j > s && chars.get(j) == Some(&'=')
}

/// `key=value` / `key: value` / JSON `"key":"value"` の機微な値を伏せる。
fn redact_key_values(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let is_colon = c == ':';
        if c == '=' || is_colon {
            // `::` (Rust のパス) は区切りではない。
            if is_colon && (chars.get(i + 1) == Some(&':') || (i > 0 && chars[i - 1] == ':')) {
                out.push(c);
                i += 1;
                continue;
            }
            let key = trailing_key(&out);
            // 値の開始位置 (コロン形式は直後の空白を読み飛ばす)。
            let mut v = i + 1;
            if is_colon {
                while v < chars.len() && (chars[v] == ' ' || chars[v] == '\t') {
                    v += 1;
                }
            }
            let sensitive = match &key {
                Some((k, before)) => {
                    is_sensitive_key(k)
                        && (!is_colon
                            || (*before != Some(':')
                                && !PROSE_KEYS.contains(&k.to_ascii_lowercase().as_str())))
                }
                None => false,
            };
            if sensitive && v < chars.len() {
                // `=` 形式の引用なしの値は空白を含みうる (`name=Acme Nightly Export`,
                // 空白入りのパス) ので、次の ` key=` か行末まで伏せる。
                let end = if chars[v] == '"' || chars[v] == '\'' {
                    quoted_end(&chars, v)
                } else if !is_colon {
                    let mut j = v;
                    while j < chars.len() {
                        if chars[j].is_whitespace() && next_key_follows(&chars, j) {
                            break;
                        }
                        j += 1;
                    }
                    j
                } else {
                    let mut j = v;
                    while j < chars.len()
                        && !chars[j].is_whitespace()
                        && !(is_colon && matches!(chars[j], ',' | '}' | ')'))
                    {
                        j += 1;
                    }
                    j
                };
                out.push(c);
                if is_colon && v > i + 1 {
                    out.push(' ');
                }
                out.push_str(REDACTED);
                i = end;
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

/// 引用符の中身を伏せる。`"..."` は `"?"`、シングルクォートの SQL リテラルは `'?'`。
/// 出現順に 1 本で走査するので、一方の引用符の中にあるもう一方は外側に含まれる。
/// 英数字の直後のシングルクォート (`don't`) は開始とみなさない。`''` はリテラル内の
/// エスケープ。閉じが無ければそのまま残す。
fn redact_quotes(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '"' {
            let end = quoted_end(&chars, i);
            if end <= chars.len() && end > i + 1 && chars[end - 1] == '"' {
                out.push_str("\"?\"");
                i = end;
                continue;
            }
        } else if c == '\''
            && !(i > 0 && (chars[i - 1].is_alphanumeric() || chars[i - 1] == '\''))
            && chars[i + 1..].contains(&'\'')
        {
            let mut j = i + 1;
            while j < chars.len() {
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
            // ユーザ名は空白を含みうる (`C:\Users\Alice Smith\...`) ので、次の区切りまで。
            // 区切りが無ければ空白・引用符まで。
            let end = tail
                .find(['/', '\\'])
                .or_else(|| tail.find(|c: char| c.is_whitespace() || c == '"' || c == '\''))
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

/// 英字を 1 つ以上含む単一ラベル (`bastion`, `jumpbox`, `db-1`)。`ホスト:ポート` の
/// ホスト側の判定に使う (数字だけの `10:30` のような時刻は除く)。
fn is_single_label_host(s: &str) -> bool {
    !s.is_empty()
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        && s.chars().any(|c| c.is_ascii_alphabetic())
}

/// 末尾の `:ポート` を分ける。ポートが 1〜65535 の数字なら (ホスト部, true)。
fn split_port(s: &str) -> (&str, bool) {
    match s.rsplit_once(':') {
        Some((h, p))
            if !h.contains(':')
                && !p.is_empty()
                && p.len() <= 5
                && p.chars().all(|c| c.is_ascii_digit())
                && p.parse::<u32>().is_ok_and(|n| (1..=65535).contains(&n)) =>
        {
            (h, true)
        }
        _ => (s, false),
    }
}

/// 1 トークン (空白区切り) の前後の句読点を除いた中身を判定して伏せる。
/// `key=値` は最後の `=` より後ろを値として判定する (`remote=10.0.0.7:5432`)。
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
    let (prefix, value) = match core_trim.rfind('=') {
        Some(p) => (&core_trim[..=p], &core_trim[p + 1..]),
        None => ("", core_trim),
    };
    if value.is_empty() {
        return token.to_string();
    }
    let (host_part, has_port) = split_port(value);
    let sensitive = value.contains("://")
        || value.contains('@')
        || value.starts_with("\\\\")
        || is_ipv4(host_part)
        || is_ipv6ish(&value.replace(['[', ']'], ""))
        || is_hostname_like(host_part)
        || (has_port && is_single_label_host(host_part));
    if sensitive {
        format!("{lead}{prefix}{REDACTED}{punct}{trail}")
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
    redact_tokens(&redact_home_paths(&redact_quotes(&redact_key_values(line))))
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
    /// keyring の状態を 1 語で表した文字列 (`available` / `unavailable (理由コード)` /
    /// `unchecked`)。診断バンドルの作成では keyring に書き込まず、キャッシュ済みの値だけを使う。
    pub keyring: String,
    pub perf_enabled: bool,
}

impl BundleMeta {
    pub fn current(keyring: &str) -> Self {
        Self {
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            // build.rs が Cargo.lock から埋め込む。取れなかったときだけ "unknown"。
            sqlx_version: option_env!("NOOBDB_SQLX_VERSION")
                .unwrap_or("unknown")
                .to_string(),
            libsqlite3_version: option_env!("NOOBDB_LIBSQLITE3_VERSION")
                .unwrap_or("unknown")
                .to_string(),
            keyring: keyring.to_string(),
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
    out.push_str(&format!("keyring: {}\n", meta.keyring));
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
            keyring: "unavailable (storage_unavailable)".into(),
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
        let m = BundleMeta::current("unchecked");
        assert!(!m.sqlx_version.is_empty());
        // build.rs が Cargo.lock から埋め込む。"unknown" は読めなかったときだけ。
        assert_ne!(m.sqlx_version, "unknown");
        assert_ne!(m.libsqlite3_version, "unknown");
        assert_eq!(m.keyring, "unchecked");
    }

    // ---- Opus レビュー指摘の回帰 (#1622) ----

    #[test]
    fn key_value_judges_only_the_value_after_the_last_equals() {
        let out = redact_log_line(
            "ssh tunnel listening ssh_host=bastion local_port=1 remote=10.0.0.7:5432",
        );
        assert!(leaks(&out, &["bastion", "10.0.0.7"]).is_empty(), "{out}");
        assert!(out.contains("local_port=1"), "{out}");
        let out = redact_log_line("forwarding remote=db.internal:5432 ok");
        assert!(leaks(&out, &["db.internal"]).is_empty(), "{out}");
        // 非機微キーでも値が IP / ホストなら伏せる (トークン判定が `=` の後ろを見る)。
        let out = redact_log_line("connect via=10.1.2.3:22 lport=1");
        assert!(leaks(&out, &["10.1.2.3"]).is_empty(), "{out}");
        assert!(out.contains("lport=1"), "{out}");
    }

    #[test]
    fn double_quoted_contents_become_question_marks() {
        for (line, needle) in [
            (
                r#"FATAL: password authentication failed for user "alice""#,
                "alice",
            ),
            (r#"FATAL: database "acme_prod" does not exist"#, "acme_prod"),
            (r#"ERROR: role "bob" does not exist"#, "bob"),
            (
                r#"could not translate host name "pg-internal" to address"#,
                "pg-internal",
            ),
        ] {
            let out = redact_log_line(line);
            assert!(!out.contains(needle), "{out}");
            assert!(out.contains("\"?\""), "{out}");
        }
    }

    #[test]
    fn colon_and_json_forms_are_judged_by_the_key() {
        let out =
            redact_log_line(r#"DEBUG Profile { host: "dbserver", user: "admin", port: 3306 }"#);
        assert!(leaks(&out, &["dbserver", "admin"]).is_empty(), "{out}");
        assert!(out.contains("port: 3306"), "{out}");
        let out = redact_log_line(
            r#"payload {"host":"db.local","user":"admin","password":"pw","port":1}"#,
        );
        assert!(
            leaks(&out, &["db.local", "admin", "\"pw\""]).is_empty(),
            "{out}"
        );
        assert!(!out.contains("pw"), "{out}");
        // 散文の `keyring:` や Rust のモジュールパスは巻き込まない。
        let out =
            redact_log_line("ERROR noobdb_lib::profiles::secrets: keyring: failed to set secret");
        assert!(out.contains("keyring: failed to set secret"), "{out}");
    }

    #[test]
    fn single_label_host_with_port_is_redacted() {
        let out = redact_log_line("jump via jumpbox:22 then bastion:22, retry in 10:30");
        assert!(leaks(&out, &["jumpbox", "bastion"]).is_empty(), "{out}");
        assert!(out.contains("10:30"), "{out}");
    }

    #[test]
    fn path_values_with_spaces_are_redacted_up_to_the_next_key() {
        let out = redact_log_line(
            "open path=/Users/alice/Library/Application Support/noobDB/x.db mode=ro",
        );
        assert!(
            leaks(&out, &["alice", "Application Support", "x.db"]).is_empty(),
            "{out}"
        );
        assert!(out.contains("mode=ro"), "{out}");
        let out = redact_log_line("start data_dir=/opt/My Data/noobdb");
        assert!(!out.contains("My Data"), "{out}");
    }

    #[test]
    fn unc_paths_are_redacted() {
        let out = redact_log_line(r"open \\fileserver\share\noobdb\x.db failed");
        assert!(leaks(&out, &["fileserver", "share"]).is_empty(), "{out}");
        assert!(out.contains("failed"), "{out}");
    }

    #[test]
    fn bundle_reports_unchecked_keyring_without_probing() {
        let meta = BundleMeta::current("unchecked");
        let b = build_bundle("", &meta, &[]);
        assert!(b.contains("keyring: unchecked"), "{b}");
    }

    #[test]
    fn reviewer_sample_lines_do_not_leak() {
        let cases: [(&str, &[&str]); 4] = [
            (
                "2026-10-15T01:00:00Z  INFO noobdb_lib::ssh::tunnel: ssh tunnel listening ssh_host=bastion local_port=50123 remote=10.0.0.7:5432",
                &["bastion", "10.0.0.7"],
            ),
            (
                "INFO ssh tunnel listening ssh_host=bastion local_port=1 remote=db.internal:5432",
                &["bastion", "db.internal"],
            ),
            (
                "ERROR ssh: password auth error user=deploy error=failed to connect to jumpbox:22",
                &["deploy", "jumpbox"],
            ),
            (
                "ERROR schema_drift: failed to open database path=/Users/alice/Library/Application Support/noobDB/x.db error=boom",
                &["alice", "Application Support", "x.db"],
            ),
        ];
        for (line, needles) in cases {
            let out = redact_log_line(line);
            assert!(leaks(&out, needles).is_empty(), "{out}");
        }
    }

    #[test]
    fn unquoted_equals_values_with_spaces_are_fully_redacted() {
        let out = redact_log_line("INFO export started name=Acme Nightly Export rows=10");
        assert!(
            leaks(&out, &["Acme", "Nightly", "Export"]).is_empty(),
            "{out}"
        );
        assert!(out.contains("rows=10"), "{out}");
    }

    #[test]
    fn path_key_match_is_by_word_not_substring() {
        // `profile` / `profile_id` に `file` が部分一致してパス扱いにならない。
        assert!(!is_path_key("profile"));
        assert!(!is_path_key("profile_id"));
        assert!(is_path_key("data_dir"));
        assert!(is_path_key("file"));
        let out = redact_log_line("DEBUG loaded profile_id=abc123 mode=ro");
        assert!(out.contains("mode=ro"), "{out}");
    }

    #[test]
    fn home_path_user_names_with_spaces_are_redacted() {
        let out = redact_log_line(r"open C:\Users\Alice Smith\AppData\x.db failed");
        assert!(leaks(&out, &["Alice", "Smith"]).is_empty(), "{out}");
        assert!(out.contains("AppData"), "{out}");
        let out = redact_log_line("see /home/bob");
        assert!(!out.contains("bob"), "{out}");
    }
}
