//! SQL 文に含まれる資格情報リテラル (パスワード・ハッシュ) の判定と伏せ字化 (#2174)。
//!
//! 「秘密情報は OS keyring のみ」という方針を、エディタから流した
//! `CREATE USER … IDENTIFIED BY '…'` / `ALTER ROLE … PASSWORD '…'` にも行き渡らせる。
//! クエリ履歴・書き込み履歴・フライトレコーダーへ保存する直前に [`redact_credentials`]
//! を通す。**実行される SQL は変えない** (伏せるのは保存・表示のときだけ)。
//!
//! 判定は既存の解析用マスク (`db::mask_for_driver`) の上に載せる。マスク後の文字列は元の
//! SQL と同じ長さで、コメントとリテラルの中身が空白に置き換わっているので、
//! コメントや文字列リテラルやドル引用の中に同じ語があっても対象にならない。キーワードを
//! マスク後の文字列で探し、元の SQL 上の同じ位置にあるリテラルを置き換える。
//!
//! 対象 (3 ドライバの資格情報構文に限る):
//! - MySQL: `IDENTIFIED BY '…'` / `IDENTIFIED BY PASSWORD '…'` /
//!   `IDENTIFIED WITH <plugin> BY|AS '…'` / MariaDB の `IDENTIFIED VIA <plugin> USING …` /
//!   `… REPLACE '…'` (旧パスワード) / 文頭の `SET PASSWORD [FOR …] = '…'` (`PASSWORD('…')` も) /
//!   `CREATE|ALTER SERVER … OPTIONS (PASSWORD '…')` / `MASTER_PASSWORD|SOURCE_PASSWORD = '…'` /
//!   `START REPLICA|SLAVE … PASSWORD = '…'`
//! - PostgreSQL: `CREATE|ALTER ROLE|USER|GROUP` 内の `[ENCRYPTED] PASSWORD '…'`
//!   (`USER MAPPING … OPTIONS (password '…')` を含む。`E'…'` とドル引用も)
//!   と `CREATE|ALTER SUBSCRIPTION … CONNECTION '<接続文字列>'` (#2189。中身に
//!   [`redact_conninfo`] が伏せる `password` / `sslpassword` / URI のパスワードがあるときだけリテラル全体)
//!   加えて接続文字列を取る `dblink(…)` / `dblink_exec(…)` / `dblink_connect[_u](…)` の文字列引数と
//!   `ALTER SYSTEM SET primary_conninfo [=|TO] '…'` (#2245。同じ規則でリテラル全体を伏せる)
//! - MySQL の `START GROUP_REPLICATION … PASSWORD = '…'` も `START REPLICA` と同じ (#2245)
//! - SQLite: 対象なし
//!
//! リテラルの前置 (`E` / `U&` / `N` / `_utf8mb4`) は残し、引用符から終端までを
//! [`REDACTED_LITERAL`] に置き換える。閉じていないリテラルは文末まで (安全側)。
//! TS 側の対応物は `src/sqlCredentials.ts`。両者は共有ゴールデン
//! `src/__tests__/fixtures/credentialRedactVectors.json` で固定する。

use std::borrow::Cow;

use crate::db::{mask_for_driver, DriverKind};

/// 伏せたあとのリテラル。
pub(crate) const REDACTED_LITERAL: &str = "'********'";

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '$' || (c as u32) > 127
}

fn is_ws(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r' | '\u{b}' | '\u{c}')
}

struct Scanner<'a> {
    /// 解析用マスク後の文字列 (元の SQL と同じ長さ)。
    m: &'a [char],
    /// 元の SQL (リテラルの中身を読むときに使う)。
    src: &'a [char],
    mysql: bool,
    pg: bool,
    out: Vec<(usize, usize)>,
    /// SUBSCRIPTION / dblink / primary_conninfo の接続文字列から取り出した秘密の値 ([`credential_secrets`] 用)。
    secrets: Vec<String>,
}

impl Scanner<'_> {
    fn skip_ws(&self, mut i: usize) -> usize {
        while i < self.m.len() && is_ws(self.m[i]) {
            i += 1;
        }
        i
    }

    /// `i` から始まる語 (小文字化) とその終端。
    fn word_at(&self, i: usize) -> Option<(String, usize)> {
        let first = *self.m.get(i)?;
        if !(first.is_ascii_alphanumeric() || first == '_' || (first as u32) > 127) {
            return None;
        }
        let mut e = i;
        while e < self.m.len() && is_word(self.m[e]) {
            e += 1;
        }
        let w: String = self.m[i..e].iter().collect::<String>().to_lowercase();
        Some((w, e))
    }

    /// PostgreSQL の連結文字列: 改行を含む空白 (コメントも可) だけで隔てた次の `'…'` は同じ値の続き。
    /// `end` (リテラルの終端) から続く限り範囲を延ばした終端を返す。
    fn pg_continue(&self, mut end: usize) -> usize {
        loop {
            let mut j = end;
            let mut newline = false;
            while j < self.m.len() && is_ws(self.m[j]) {
                newline |= self.m[j] == '\n';
                j += 1;
            }
            if newline && self.m.get(j) == Some(&'\'') {
                end = self.quote_end(j);
            } else {
                return end;
            }
        }
    }

    /// 引用符 `q` で始まるリテラルの終端 (閉じ引用符の次)。閉じていなければ文末。
    fn quote_end(&self, q: usize) -> usize {
        let quote = self.m[q];
        match self.m[q + 1..].iter().position(|&c| c == quote) {
            Some(off) => q + 1 + off + 1,
            None => self.m.len(),
        }
    }

    /// `$tag$` / `$$` の長さ。`$1` のようなパラメータは対象外。
    fn dollar_tag_len(&self, p: usize) -> Option<usize> {
        let mut j = p + 1;
        if let Some(&c) = self.m.get(j) {
            if c.is_ascii_alphabetic() || c == '_' {
                while j < self.m.len() && (self.m[j].is_ascii_alphanumeric() || self.m[j] == '_') {
                    j += 1;
                }
            }
        }
        if self.m.get(j) == Some(&'$') {
            Some(j + 1 - p)
        } else {
            None
        }
    }

    /// `p` にあるリテラルの (開始, 終端)。開始は引用符 (またはドル引用の `$`) の位置。
    fn literal_at(&self, p: usize) -> Option<(usize, usize)> {
        let c = *self.m.get(p)?;
        let next = self.m.get(p + 1).copied();
        if c == '\'' || (c == '"' && self.mysql) {
            let end = self.quote_end(p);
            return Some((
                p,
                if self.pg && c == '\'' {
                    self.pg_continue(end)
                } else {
                    end
                },
            ));
        }
        if self.pg {
            if matches!(c, 'e' | 'E') && next == Some('\'') {
                return Some((p + 1, self.pg_continue(self.quote_end(p + 1))));
            }
            if matches!(c, 'u' | 'U') && next == Some('&') && self.m.get(p + 2) == Some(&'\'') {
                return Some((p + 2, self.pg_continue(self.quote_end(p + 2))));
            }
            if c == '$' {
                let tag_len = self.dollar_tag_len(p)?;
                let tag = &self.m[p..p + tag_len];
                let from = p + tag_len;
                let end = (from..self.m.len())
                    .find(|&j| self.m[j..].starts_with(tag))
                    .map_or(self.m.len(), |j| j + tag_len);
                return Some((p, end));
            }
        }
        if self.mysql {
            if matches!(c, 'n' | 'N') && next == Some('\'') {
                return Some((p + 1, self.quote_end(p + 1)));
            }
            if c == '_' {
                let mut j = p;
                while j < self.m.len() && (self.m[j].is_ascii_alphanumeric() || self.m[j] == '_') {
                    j += 1;
                }
                if matches!(self.m.get(j), Some('\'') | Some('"')) {
                    return Some((j, self.quote_end(j)));
                }
            }
        }
        None
    }

    fn push(&mut self, lit: (usize, usize)) {
        let last_end = self.out.last().map_or(0, |r| r.1);
        if lit.0 >= last_end {
            self.out.push(lit);
        }
    }

    /// `p` にリテラル、または `PASSWORD('…')` / `OLD_PASSWORD('…')` があれば伏せて、その終端を返す。
    fn literal_or_fn(&mut self, p: usize) -> Option<usize> {
        if let Some(lit) = self.literal_at(p) {
            self.push(lit);
            return Some(lit.1);
        }
        let (w, e) = self.word_at(p)?;
        if w != "password" && w != "old_password" {
            return None;
        }
        let q = self.skip_ws(e);
        if self.m.get(q) != Some(&'(') {
            return None;
        }
        let q = self.skip_ws(q + 1);
        let lit = self.literal_at(q)?;
        self.push(lit);
        Some(lit.1)
    }

    /// 直前のリテラルの後ろに `REPLACE '旧パスワード'` が続けば、それも伏せる。
    fn replace_tail(&mut self, after: usize) {
        let p = self.skip_ws(after);
        if let Some((w, e)) = self.word_at(p) {
            if w == "replace" {
                let q = self.skip_ws(e);
                if let Some(lit) = self.literal_at(q) {
                    self.push(lit);
                }
            }
        }
    }

    /// `i` を含む文の先頭 (直前の `;` の次)。
    fn stmt_start(&self, i: usize) -> usize {
        let mut j = i;
        while j > 0 && self.m[j - 1] != ';' {
            j -= 1;
        }
        j
    }

    /// 文頭の語 2 つ (小文字)。
    fn leading_words(&self, i: usize) -> (Option<String>, Option<String>) {
        let s = self.skip_ws(self.stmt_start(i));
        let Some((a, e)) = self.word_at(s) else {
            return (None, None);
        };
        let b = self.word_at(self.skip_ws(e)).map(|(w, _)| w);
        (Some(a), b)
    }

    /// 文頭が `START REPLICA|SLAVE|GROUP_REPLICATION` (その `PASSWORD = '…'` はレプリケーションの資格情報)。
    fn starts_replica(&self, i: usize) -> bool {
        let (a, b) = self.leading_words(i);
        a.as_deref() == Some("start")
            && matches!(
                b.as_deref(),
                Some("replica") | Some("slave") | Some("group_replication")
            )
    }

    fn mysql_identified(&mut self, e: usize) {
        let p = self.skip_ws(e);
        let Some((w, e)) = self.word_at(p) else {
            return;
        };
        match w.as_str() {
            "by" => {
                let mut p = self.skip_ws(e);
                if let Some((w2, e2)) = self.word_at(p) {
                    if w2 == "password" {
                        p = self.skip_ws(e2);
                    }
                }
                if let Some(lit) = self.literal_at(p) {
                    self.push(lit);
                    self.replace_tail(lit.1);
                }
            }
            "with" | "via" => {
                let p = self.skip_ws(e);
                let after_plugin = if let Some((_, e2)) = self.word_at(p) {
                    e2
                } else if let Some(lit) = self.literal_at(p) {
                    lit.1
                } else {
                    return;
                };
                let p = self.skip_ws(after_plugin);
                let Some((w2, e2)) = self.word_at(p) else {
                    return;
                };
                let ok = if w == "with" {
                    w2 == "by" || w2 == "as"
                } else {
                    w2 == "using"
                };
                if !ok {
                    return;
                }
                let p = self.skip_ws(e2);
                if let Some(end) = self.literal_or_fn(p) {
                    self.replace_tail(end);
                }
            }
            _ => {}
        }
    }

    fn mysql_set_password(&mut self, i: usize, e: usize) {
        // 文頭の `SET PASSWORD` だけ (`UPDATE t SET password = …` は対象外)。
        if self.skip_ws(self.stmt_start(i)) != i {
            return;
        }
        let p = self.skip_ws(e);
        let Some((w, e)) = self.word_at(p) else {
            return;
        };
        if w != "password" {
            return;
        }
        let mut j = e;
        while j < self.m.len() && self.m[j] != ';' && self.m[j] != '=' {
            j += 1;
        }
        if self.m.get(j) != Some(&'=') {
            return;
        }
        let p = self.skip_ws(j + 1);
        if let Some(end) = self.literal_or_fn(p) {
            self.replace_tail(end);
        }
    }

    /// `CONNECTION '…'` のリテラル `lit` が伏せ対象なら、その中の秘密の値 (エラー文の置換用。空もありうる) を返す。
    /// 対象外なら `None`。次のどれかで対象にする (安全側):
    /// - `U&'…'` (`\XXXX` でキー名を隠せる) / `E'…'` で中身に `\` がある (`\n` や `\167` でキーを隠せる)
    /// - エスケープを解いた中身に "password" を含む (大文字小文字を問わない)
    /// - [`redact_conninfo`] が値を伏せる / [`conninfo_secret_values`] が値を返す
    /// - URI で最後の `@` の前に `:` がある (パスワードに `/` や `?` が素で入っても漏らさない)
    fn conninfo_literal_secrets(&self, lit: (usize, usize)) -> Option<Vec<String>> {
        let (s, e) = lit;
        let mut decoded = String::new();
        let mut opaque = false;
        if self.m[s] == '$' {
            let Some(tag_len) = self.dollar_tag_len(s) else {
                return Some(Vec::new());
            };
            let closed = e >= s + 2 * tag_len && self.m[e - tag_len..e] == self.m[s..s + tag_len];
            let inner_end = if closed { e - tag_len } else { e };
            if s + tag_len <= inner_end {
                decoded.extend(&self.src[s + tag_len..inner_end]);
            }
        } else {
            let u_amp = s >= 2 && self.m[s - 1] == '&' && matches!(self.m[s - 2], 'u' | 'U');
            let esc = uescape_char(self.m, self.src, e);
            let backslash = s >= 1 && matches!(self.m[s - 1], 'e' | 'E');
            let mut i = s;
            while i < e {
                if self.m[i] != '\'' {
                    i += 1;
                    continue;
                }
                // 連結文字列は各片の中身をつなげる。閉じていなければ文末まで。
                let (inner_end, next) = match (i + 1..e).find(|&j| self.m[j] == '\'') {
                    Some(c) => (c, c + 1),
                    None => (e, e),
                };
                let raw = &self.src[i + 1..inner_end];
                // `U&'…'` は `\XXXX` でキー名を隠せるので、常に伏せ対象にする。
                opaque |= u_amp || (backslash && raw.contains(&'\\'));
                decoded.push_str(&decode_literal_piece(raw, u_amp, backslash, esc));
                i = next;
            }
        }
        let values = conninfo_secret_values(&decoded);
        let lower = decoded.to_ascii_lowercase();
        let t = lower.trim_start();
        let uri_at = (t.starts_with("postgresql://") || t.starts_with("postgres://"))
            && t.find("://").is_some_and(|p| {
                t.rfind('@')
                    .is_some_and(|at| at > p && t[p + 3..at].contains(':'))
            });
        let secret = opaque
            || uri_at
            || lower.contains("password")
            || !values.is_empty()
            || redact_conninfo(&decoded) != decoded;
        secret.then_some(values)
    }

    /// PostgreSQL の `CREATE|ALTER SUBSCRIPTION … CONNECTION '<接続文字列>'` (#2189)。接続文字列に
    /// パスワードがあるときだけ、リテラル全体を伏せる (ホスト名などを残すためにリテラルの内側だけ
    /// 置換すると、引用符のエスケープ次第で崩れるので、他の資格情報と同じくリテラル単位にする)。
    fn pg_subscription_connection(&mut self, i: usize, e: usize) {
        let (a, b) = self.leading_words(i);
        if !matches!(a.as_deref(), Some("create") | Some("alter"))
            || b.as_deref() != Some("subscription")
        {
            return;
        }
        let p = self.skip_ws(e);
        if let Some(lit) = self.literal_at(p) {
            if let Some(values) = self.conninfo_literal_secrets(lit) {
                self.push(lit);
                self.secrets.extend(values);
            }
        }
    }

    /// リテラル `lit` が接続文字列で秘密を含むなら伏せ対象にして、秘密の値を集める。
    fn push_conninfo(&mut self, lit: (usize, usize)) {
        if let Some(values) = self.conninfo_literal_secrets(lit) {
            self.push(lit);
            self.secrets.extend(values);
        }
    }

    /// PostgreSQL の dblink 関数 (`dblink` / `dblink_exec` は第 1 引数、`dblink_connect[_u]` は
    /// 接続名つきなら第 2 引数、なければ第 1 引数) の接続文字列リテラル。`e` は関数名の終端。
    fn pg_dblink_call(&mut self, w: &str, e: usize) {
        let p = self.skip_ws(e);
        if self.m.get(p) != Some(&'(') {
            return;
        }
        let p = self.skip_ws(p + 1);
        let Some(first) = self.literal_at(p) else {
            return;
        };
        if w.starts_with("dblink_connect") {
            let q = self.skip_ws(first.1);
            if self.m.get(q) == Some(&',') {
                if let Some(second) = self.literal_at(self.skip_ws(q + 1)) {
                    self.push_conninfo(second);
                    return;
                }
            }
        }
        self.push_conninfo(first);
    }

    /// PostgreSQL の `ALTER SYSTEM SET primary_conninfo [=|TO] '<接続文字列>'`。`e` は設定名の終端。
    fn pg_primary_conninfo(&mut self, i: usize, e: usize) {
        let (a, b) = self.leading_words(i);
        if a.as_deref() != Some("alter") || b.as_deref() != Some("system") {
            return;
        }
        let mut p = self.skip_ws(e);
        if self.m.get(p) == Some(&'=') {
            p += 1;
        } else if let Some((w, e2)) = self.word_at(p) {
            if w != "to" {
                return;
            }
            p = e2;
        } else {
            return;
        }
        if let Some(lit) = self.literal_at(self.skip_ws(p)) {
            self.push_conninfo(lit);
        }
    }

    fn scan(&mut self) {
        let n = self.m.len();
        let mut i = 0;
        while i < n {
            if self.pg && self.m[i] == '"' {
                // 引用符つきの関数名 (`"dblink_connect"(…)`)。解析用マスクは中身を空白にするので元の SQL から読む。
                if let Some(off) = self.m[i + 1..].iter().position(|&c| c == '"') {
                    let close = i + 1 + off;
                    let name: String = self.src[i + 1..close].iter().collect();
                    if matches!(
                        name.as_str(),
                        "dblink" | "dblink_exec" | "dblink_connect" | "dblink_connect_u"
                    ) {
                        self.pg_dblink_call(&name, close + 1);
                    }
                    i = close + 1;
                    continue;
                }
            }
            if !is_word(self.m[i]) {
                i += 1;
                continue;
            }
            let mut e = i;
            while e < n && is_word(self.m[e]) {
                e += 1;
            }
            let w: String = self.m[i..e].iter().collect::<String>().to_lowercase();
            match w.as_str() {
                "identified" if self.mysql => self.mysql_identified(e),
                "connection" if self.pg => self.pg_subscription_connection(i, e),
                "dblink" | "dblink_exec" | "dblink_connect" | "dblink_connect_u" if self.pg => {
                    self.pg_dblink_call(&w, e)
                }
                "primary_conninfo" if self.pg => self.pg_primary_conninfo(i, e),
                "set" if self.mysql => self.mysql_set_password(i, e),
                "master_password" | "source_password" if self.mysql => {
                    let p = self.skip_ws(e);
                    if self.m.get(p) == Some(&'=') {
                        let p = self.skip_ws(p + 1);
                        if let Some(lit) = self.literal_at(p) {
                            self.push(lit);
                        }
                    }
                }
                "password" if self.mysql && self.starts_replica(i) => {
                    let p = self.skip_ws(e);
                    if self.m.get(p) == Some(&'=') {
                        let p = self.skip_ws(p + 1);
                        if let Some(lit) = self.literal_at(p) {
                            self.push(lit);
                        }
                    }
                }
                "password" => {
                    let (a, b) = self.leading_words(i);
                    let a = a.as_deref();
                    let b = b.as_deref();
                    let in_scope = matches!(a, Some("create") | Some("alter"))
                        && ((self.pg && matches!(b, Some("role") | Some("user") | Some("group")))
                            || (self.mysql && b == Some("server")));
                    if in_scope {
                        let p = self.skip_ws(e);
                        if let Some(lit) = self.literal_at(p) {
                            self.push(lit);
                        }
                    }
                }
                _ => {}
            }
            i = e;
        }
    }
}

fn scan_ranges(sql: &str, driver: DriverKind) -> (Vec<(usize, usize)>, Vec<char>, Vec<String>) {
    let chars: Vec<char> = sql.chars().collect();
    let masked = mask_for_driver(driver, &chars);
    let mut sc = Scanner {
        m: &masked,
        src: &chars,
        mysql: driver == DriverKind::Mysql,
        pg: driver == DriverKind::Postgres,
        out: Vec::new(),
        secrets: Vec::new(),
    };
    sc.scan();
    let (out, secrets) = (sc.out, sc.secrets);
    (out, masked, secrets)
}

/// 資格情報リテラルの範囲 (文字オフセットの半開区間 `[開始, 終端)`、昇順・重なりなし)。
pub(crate) fn find_credential_ranges(sql: &str, driver: DriverKind) -> Vec<(usize, usize)> {
    if driver == DriverKind::Sqlite {
        return Vec::new();
    }
    scan_ranges(sql, driver).0
}

/// 誤置換を避けるため、これより短い値はエラー文の置換対象にしない (文字数)。
/// 1〜3 文字の値 (`a` など) を置換すると、エラー文の別の箇所まで潰れて原因が読めなくなる。
const MIN_SECRET_CHARS: usize = 4;

/// `raw` (引用符の内側) のエスケープを解いたもの。
fn unescape_literal(raw: &[char], quote: char, backslash: bool) -> String {
    let mut out = String::new();
    let mut i = 0;
    while i < raw.len() {
        let c = raw[i];
        if backslash && c == '\\' && i + 1 < raw.len() {
            out.push(raw[i + 1]);
            i += 2;
        } else if c == quote && raw.get(i + 1) == Some(&quote) {
            out.push(quote);
            i += 2;
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

/// 16 進 `n` 桁ちょうどを読む。
fn hex_at(raw: &[char], start: usize, n: usize) -> Option<u32> {
    let digits = raw.get(start..start.checked_add(n)?)?;
    digits
        .iter()
        .try_fold(0u32, |acc, c| Some(acc * 16 + c.to_digit(16)?))
}

/// サロゲートペアの上位 `hi` と下位 `lo` を 1 文字にする。ペアでなければ `None`。
fn combine_surrogates(hi: u32, lo: u32) -> Option<char> {
    if (0xD800..0xDC00).contains(&hi) && (0xDC00..0xE000).contains(&lo) {
        char::from_u32(0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00))
    } else {
        None
    }
}

/// PostgreSQL の `E'…'` の中身 (引用符の内側) を、サーバ (libpq が受け取る文字列) と同じにデコードする。
/// `\b \f \n \r \t`、8 進 `\o`〜`\ooo`、`\xh`〜`\xhh`、`\uXXXX` / `\UXXXXXXXX` (サロゲートペア可)、
/// それ以外の `\c` は `c`。`''` は `'`。8 進・`\x` はバイト値で、全体を UTF-8 として読む (不正なバイトは U+FFFD)。
fn decode_pg_e(raw: &[char]) -> String {
    let mut out: Vec<u8> = Vec::new();
    let push = |out: &mut Vec<u8>, c: char| {
        let mut b = [0u8; 4];
        out.extend_from_slice(c.encode_utf8(&mut b).as_bytes());
    };
    let mut i = 0;
    while i < raw.len() {
        let c = raw[i];
        if c == '\'' && raw.get(i + 1) == Some(&'\'') {
            out.push(b'\'');
            i += 2;
            continue;
        }
        if c != '\\' || i + 1 >= raw.len() {
            push(&mut out, c);
            i += 1;
            continue;
        }
        let d = raw[i + 1];
        i += 2;
        match d {
            'b' => out.push(8),
            'f' => out.push(12),
            'n' => out.push(b'\n'),
            'r' => out.push(b'\r'),
            't' => out.push(b'\t'),
            '0'..='7' => {
                let mut v = d.to_digit(8).unwrap_or(0);
                let mut used = 1;
                while used < 3 {
                    match raw.get(i).and_then(|c| c.to_digit(8)) {
                        Some(o) => {
                            v = v * 8 + o;
                            i += 1;
                            used += 1;
                        }
                        None => break,
                    }
                }
                out.push((v & 0xFF) as u8);
            }
            'x' => {
                let mut v = 0u32;
                let mut used = 0;
                while used < 2 {
                    match raw.get(i).and_then(|c| c.to_digit(16)) {
                        Some(h) => {
                            v = v * 16 + h;
                            i += 1;
                            used += 1;
                        }
                        None => break,
                    }
                }
                if used == 0 {
                    out.push(b'x');
                } else {
                    out.push(v as u8);
                }
            }
            'u' | 'U' => {
                let n = if d == 'u' { 4 } else { 8 };
                let Some(code) = hex_at(raw, i, n) else {
                    push(&mut out, d);
                    continue;
                };
                i += n;
                let mut ch = char::from_u32(code);
                if ch.is_none() && d == 'u' {
                    // 下位サロゲートが `\uXXXX` で続くペア。
                    if raw.get(i) == Some(&'\\') && raw.get(i + 1) == Some(&'u') {
                        if let Some(lo) = hex_at(raw, i + 2, 4) {
                            ch = combine_surrogates(code, lo);
                            if ch.is_some() {
                                i += 6;
                            }
                        }
                    }
                }
                push(&mut out, ch.unwrap_or('\u{FFFD}'));
            }
            other => push(&mut out, other),
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// PostgreSQL の `U&'…'` の中身 (`''` は解いたもの) を `esc` (既定 `\`、`UESCAPE` で変更) でデコードする。
/// `esc` + 4 桁 16 進、`esc` + `+` + 6 桁 16 進 (サロゲートペア可)、`esc esc` は `esc` 自身。
fn decode_pg_u(raw: &[char], esc: char) -> String {
    let mut out = String::new();
    let mut i = 0;
    let read = |at: usize| -> Option<(u32, usize)> {
        if raw.get(at) != Some(&esc) {
            return None;
        }
        if raw.get(at + 1) == Some(&'+') {
            hex_at(raw, at + 2, 6).map(|v| (v, at + 8))
        } else {
            hex_at(raw, at + 1, 4).map(|v| (v, at + 5))
        }
    };
    while i < raw.len() {
        if raw[i] == esc && raw.get(i + 1) == Some(&esc) {
            out.push(esc);
            i += 2;
        } else if let Some((code, next)) = read(i) {
            i = next;
            let mut ch = char::from_u32(code);
            if ch.is_none() {
                if let Some((lo, n2)) = read(i) {
                    ch = combine_surrogates(code, lo);
                    if ch.is_some() {
                        i = n2;
                    }
                }
            }
            out.push(ch.unwrap_or('\u{FFFD}'));
        } else {
            out.push(raw[i]);
            i += 1;
        }
    }
    out
}

/// リテラルの終端 `e` の後ろに `UESCAPE '<1 文字>'` があればその文字、なければ `\`。
fn uescape_char(m: &[char], src: &[char], e: usize) -> char {
    let skip = |mut i: usize| {
        while i < m.len() && is_ws(m[i]) {
            i += 1;
        }
        i
    };
    let p = skip(e);
    let word_end = (p..m.len())
        .find(|&j| !m[j].is_ascii_alphabetic())
        .unwrap_or(m.len());
    let word: String = m[p..word_end].iter().collect();
    if !word.eq_ignore_ascii_case("uescape") {
        return '\\';
    }
    let q = skip(word_end);
    match (m.get(q), src.get(q + 1), m.get(q + 2)) {
        (Some('\''), Some(&c), Some('\'')) => c,
        _ => '\\',
    }
}

/// 連結文字列の 1 片 `raw` (引用符の内側) をデコードする。`u_amp` は `U&'…'`、`backslash` は `E'…'` / MySQL。
fn decode_literal_piece(raw: &[char], u_amp: bool, backslash: bool, esc: char) -> String {
    if u_amp {
        decode_pg_u(
            &unescape_literal(raw, '\'', false)
                .chars()
                .collect::<Vec<_>>(),
            esc,
        )
    } else if backslash {
        decode_pg_e(raw)
    } else {
        unescape_literal(raw, '\'', false)
    }
}

/// SQL 中の資格情報リテラルの**中身**。元の表記とエスケープを解いた値の両方 (長い順)。
/// サーバのエラー文が SQL 断片を引用したときの置換に使う。
pub(crate) fn credential_secrets(sql: &str, driver: DriverKind) -> Vec<String> {
    if driver == DriverKind::Sqlite {
        return Vec::new();
    }
    let (ranges, m, extra) = scan_ranges(sql, driver);
    let chars: Vec<char> = sql.chars().collect();
    let mut found: Vec<String> = extra;
    for (s, e) in ranges {
        if m[s] == '$' {
            let tag_len = m[s + 1..]
                .iter()
                .position(|&c| c == '$')
                .map_or(1, |o| o + 2);
            let closed = e >= s + 2 * tag_len && m[e - tag_len..e] == m[s..s + tag_len];
            let inner_end = if closed { e - tag_len } else { e };
            if s + tag_len <= inner_end {
                found.push(chars[s + tag_len..inner_end].iter().collect());
            }
            continue;
        }
        let e_string =
            s >= 1 && matches!(chars[s - 1], 'e' | 'E') && driver == DriverKind::Postgres;
        let backslash = driver == DriverKind::Mysql || e_string;
        let mut i = s;
        while i < e {
            if m[i] != '\'' && m[i] != '"' {
                i += 1;
                continue;
            }
            let q = m[i];
            let (inner_end, next) = match (i + 1..e).find(|&j| m[j] == q) {
                Some(c) => (c, c + 1),
                None => (e, e),
            };
            let raw = &chars[i + 1..inner_end];
            found.push(raw.iter().collect());
            found.push(unescape_literal(raw, q, backslash));
            if driver == DriverKind::Postgres && q == '\'' {
                if e_string {
                    found.push(decode_pg_e(raw));
                } else if s >= 2 && m[s - 1] == '&' && matches!(m[s - 2], 'u' | 'U') {
                    found.push(decode_literal_piece(
                        raw,
                        true,
                        false,
                        uescape_char(&m, &chars, e),
                    ));
                }
            }
            i = next;
        }
    }
    found.retain(|v| v.chars().count() >= MIN_SECRET_CHARS);
    found.sort_by_key(|v| std::cmp::Reverse(v.chars().count()));
    found.dedup();
    found
}

/// サーバのエラー文から資格情報を伏せる (#2174)。エラー文は SQL 断片を引用する
/// (`near 'IDENTIFIED BY 'secret'' at line 1`) ので、キーワード走査では伏せられない。
/// 元の SQL の資格情報リテラルの中身がエラー文に現れたら、すべて `********` に置き換える。
pub(crate) fn redact_error_text(error: &str, sql: &str, driver: DriverKind) -> String {
    let mut out = error.to_string();
    for secret in credential_secrets(sql, driver) {
        out = out.replace(&secret, "********");
    }
    redact_credentials(&out, driver).into_owned()
}

/// 資格情報リテラルを [`REDACTED_LITERAL`] に置き換えた SQL。対象がなければ入力を借用で返す。
pub(crate) fn redact_credentials(sql: &str, driver: DriverKind) -> Cow<'_, str> {
    let ranges = find_credential_ranges(sql, driver);
    if ranges.is_empty() {
        return Cow::Borrowed(sql);
    }
    let chars: Vec<char> = sql.chars().collect();
    let mut out = String::with_capacity(sql.len());
    let mut at = 0;
    for (s, e) in ranges {
        out.extend(&chars[at..s]);
        out.push_str(REDACTED_LITERAL);
        at = e;
    }
    out.extend(&chars[at..]);
    Cow::Owned(out)
}

/// 接続文字列に含まれるパスワードとして伏せるキーワード (小文字)。`sslpassword` は TLS クライアント鍵の
/// パスフレーズ。パスファイルへの**パス** (`passfile`) は秘密ではないので対象外。
const CONNINFO_SECRET_KEYS: [&str; 2] = ["password", "sslpassword"];

/// PostgreSQL の接続文字列 (libpq の `key=value ...` 形式、または `postgresql://` の URI) から
/// パスワードを伏せる (#2181)。`pg_subscription.subconninfo` を画面に出す前にバックエンドで通す。
/// 値は引用符つき (`password='a b\'c'`、`\` のエスケープ) も裸の値も扱い、`password` / `sslpassword` の値を
/// `'********'` (URI は `********`) に置き換える。解釈できない残りに "password" が含まれていれば、
/// 漏らさないよう残り全体を伏せる (安全側)。
pub(crate) fn redact_conninfo(conninfo: &str) -> String {
    let t = conninfo.trim_start();
    let lower = t.to_ascii_lowercase();
    if lower.starts_with("postgresql://") || lower.starts_with("postgres://") {
        return redact_conninfo_uri(conninfo);
    }
    let chars: Vec<char> = conninfo.chars().collect();
    let mut out = String::with_capacity(conninfo.len());
    let mut i = 0;
    while i < chars.len() {
        if is_ws(chars[i]) {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && chars[i] != '=' && !is_ws(chars[i]) {
            i += 1;
        }
        let key: String = chars[start..i].iter().collect();
        if looks_like_userinfo(&key) {
            // `postgresql:/u:secret@h` や先頭が U+FEFF の URI は libpq が key=value として読み、エラー文は
            // 全体を引用する。`user:パスワード@` のような語は残り全体を伏せる (安全側)。
            out.push_str(REDACTED_LITERAL);
            return out;
        }
        let mut j = i;
        while j < chars.len() && is_ws(chars[j]) {
            j += 1;
        }
        if chars.get(j) != Some(&'=') {
            // `key=value` の形でない。パスワードの語を含むなら残り全体を伏せる。
            let rest: String = chars[start..].iter().collect();
            if rest.to_ascii_lowercase().contains("password") {
                out.push_str(REDACTED_LITERAL);
            } else {
                out.push_str(&rest);
            }
            return out;
        }
        j += 1;
        while j < chars.len() && is_ws(chars[j]) {
            j += 1;
        }
        // 値の範囲 [j, end)。
        let mut end = j;
        if chars.get(j) == Some(&'\'') {
            end += 1;
            while end < chars.len() {
                match chars[end] {
                    '\\' => end += 2,
                    '\'' => {
                        end += 1;
                        break;
                    }
                    _ => end += 1,
                }
            }
            end = end.min(chars.len());
        } else {
            while end < chars.len() && !is_ws(chars[end]) {
                end += if chars[end] == '\\' { 2 } else { 1 };
            }
            end = end.min(chars.len());
        }
        if CONNINFO_SECRET_KEYS.contains(&key.to_ascii_lowercase().as_str()) {
            out.push_str(&key.to_ascii_lowercase());
            out.push('=');
            out.push_str(REDACTED_LITERAL);
        } else {
            out.extend(&chars[start..end]);
        }
        i = end;
    }
    out
}

/// 接続文字列の中のパスワードの**値** (エラー文の置換用、#2189)。PostgreSQL は接続文字列のエラーに値の一部を
/// 引用する (`invalid percent-encoded token: "p%zz"`) ので、元の表記とデコード後の両方を返す。
/// - key=value: `password` / `sslpassword` の値 (引用符を外したもの・`\` を解いたもの)。裸の値が空白で切れて
///   `missing "=" after "secret"` になる場合に備え、直後から次の `key=` までの `=` を持たない語も含める。
/// - URI: `user:パスワード@` のパスワード (生とパーセントデコード後)、クエリの `password` / `sslpassword` の値。
pub(crate) fn conninfo_secret_values(conninfo: &str) -> Vec<String> {
    let t = conninfo.trim_start();
    let mut out: Vec<String> = Vec::new();
    let lower = t.to_ascii_lowercase();
    if lower.starts_with("postgresql://") || lower.starts_with("postgres://") {
        let rest = &t[t.find("://").map_or(0, |p| p + 3)..];
        if let Some(at) = rest.rfind('@') {
            if let Some(colon) = rest[..at].find(':') {
                let pw = &rest[colon + 1..at];
                // libpq は `/` の手前までで `@` を探すので、素の `/` を含むパスワードは前半が
                // host:port として引用される。`/` で分けた各片も秘密値にする。
                for v in [pw.to_string(), percent_decode(pw)] {
                    out.extend(v.split('/').map(str::to_string));
                    out.push(v);
                }
            }
        }
        if let Some((_, q)) = rest.split_once('?') {
            for kv in q.split('&') {
                if let Some((k, v)) = kv.split_once('=') {
                    if CONNINFO_SECRET_KEYS
                        .contains(&percent_decode(k).to_ascii_lowercase().as_str())
                    {
                        out.push(v.to_string());
                        out.push(percent_decode(v));
                    }
                }
            }
        }
        return out;
    }
    let chars: Vec<char> = conninfo.chars().collect();
    let n = chars.len();
    let mut i = 0;
    while i < n {
        if is_ws(chars[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < n && chars[i] != '=' && !is_ws(chars[i]) {
            i += 1;
        }
        let key: String = chars[start..i].iter().collect();
        if looks_like_userinfo(&key) {
            out.extend(userinfo_word_secrets(&chars[start..]));
            break;
        }
        let mut j = i;
        while j < n && is_ws(chars[j]) {
            j += 1;
        }
        if chars.get(j) != Some(&'=') {
            break;
        }
        j += 1;
        while j < n && is_ws(chars[j]) {
            j += 1;
        }
        let quoted = chars.get(j) == Some(&'\'');
        let (raw_start, raw_end, end) = if quoted {
            let mut e = j + 1;
            let mut close = None;
            while e < n {
                match chars[e] {
                    '\\' => e += 2,
                    '\'' => {
                        close = Some(e);
                        e += 1;
                        break;
                    }
                    _ => e += 1,
                }
            }
            let e = e.min(n);
            (j + 1, close.unwrap_or(e), e)
        } else {
            let mut e = j;
            while e < n && !is_ws(chars[e]) {
                e += if chars[e] == '\\' { 2 } else { 1 };
            }
            let e = e.min(n);
            (j, e, e)
        };
        i = end;
        if CONNINFO_SECRET_KEYS.contains(&key.to_ascii_lowercase().as_str()) {
            let raw = &chars[raw_start..raw_end];
            out.push(raw.iter().collect());
            out.push(unescape_literal(raw, '\'', true));
            // 空白で切れた値の続き、または引用符が途中で閉じた値の残り (`'ab''cd'` など):
            // 次の `key=` (または `key =`) が現れるまでの語。
            loop {
                let mut a = i;
                while a < n && is_ws(chars[a]) {
                    a += 1;
                }
                let mut b = a;
                while b < n && !is_ws(chars[b]) {
                    b += 1;
                }
                let mut c = b;
                while c < n && is_ws(chars[c]) {
                    c += 1;
                }
                if a == b || chars[a..b].contains(&'=') || chars.get(c) == Some(&'=') {
                    break;
                }
                out.push(chars[a..b].iter().collect());
                i = b;
            }
        }
    }
    out
}

/// URI のクエリのキーのパーセントデコード (`pass%77ord` → `password`)。不正な `%` はそのまま残す。
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let hex = |c: u8| (c as char).to_digit(16);
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match (
            b[i],
            b.get(i + 1).and_then(|c| hex(*c)),
            b.get(i + 2).and_then(|c| hex(*c)),
        ) {
            (b'%', Some(h), Some(l)) => {
                out.push((h * 16 + l) as u8);
                i += 3;
            }
            _ => {
                out.push(b[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// key の位置にある語が URI 風 (`user:パスワード@host…`) か。libpq のキーワードは `:` を含まないので、
/// key の位置 (`=` か空白まで) に `:` があれば URI の打ち間違いと見なす。パスワードに `=` や空白があっても
/// `:` までは key 側に入るので取りこぼさない (安全側)。
fn looks_like_userinfo(word: &str) -> bool {
    word.contains(':')
}

/// URI 風の語 (`rest` はその語の先頭から文末まで) をエラー文で引用されうる形の候補にする。
/// 候補は語全体・残り全体・最初/最後の `:` 以降・最後の `:` から `@` まで (それぞれ生とパーセントデコード後、
/// `/` 分割) と、残りの語 (上限あり) に絞る。`:` の数に比例して候補が増えると二乗時間になるので、数は定数。
fn userinfo_word_secrets(rest: &[char]) -> Vec<String> {
    const MAX_WORDS: usize = 32;
    let text: String = rest.iter().collect();
    let key_end = text
        .find(|c: char| c == '=' || is_ws(c))
        .unwrap_or(text.len());
    let key = &text[..key_end];
    let mut base: Vec<&str> = vec![key, text.trim_end_matches(is_ws)];
    if let (Some(first), Some(last)) = (key.find(':'), key.rfind(':')) {
        base.push(&key[first + 1..]);
        base.push(&key[last + 1..]);
        if let Some(at) = key.rfind('@').filter(|&at| at > last) {
            base.push(&key[last + 1..at]);
        }
    }
    base.extend(
        text[key_end..]
            .split(is_ws)
            .filter(|w| !w.is_empty())
            .take(MAX_WORDS),
    );
    let mut out: Vec<String> = Vec::new();
    for v in base {
        for v in [v.to_string(), percent_decode(v)] {
            out.extend(v.split('/').filter(|p| !p.is_empty()).map(str::to_string));
            out.push(v);
        }
    }
    out.retain(|v| !v.is_empty());
    out
}

/// [`redact_conninfo`] の URI 形式: `user:パスワード@` と `?password=...` / `&sslpassword=...` を伏せる。
/// ユーザー情報は「スキームの後の最初の `/` より前にある最後の `@`」で決め、その後で `?` のクエリを分ける
/// (パスワードに素の `?` があっても取りこぼさない)。
fn redact_conninfo_uri(uri: &str) -> String {
    let scheme_end = uri.find("://").map_or(0, |p| p + 3);
    let authority_end = uri[scheme_end..]
        .find('/')
        .map_or(uri.len(), |p| p + scheme_end);
    let mut prefix = uri[..scheme_end].to_string();
    let mut rest_start = scheme_end;
    // ユーザー情報の区切りは最後の `@` (パスワードの `@` は通常パーセントエンコードされるが念のため)。
    // authority にユーザー情報がなくても、スキーム以降の最後の `@` の前に `:` があれば伏せる (`u:p/xyz@h` など、安全側)。
    // ただしフォールバックでは、`h:5432/db?application_name=me@corp` のようにポート (数字だけ) の `:` は
    // ユーザー情報の区切りと見なさない (正常な URI の表示を崩さない)。
    let fallback_at = || {
        let at = uri[scheme_end..].rfind('@')? + scheme_end;
        let colon = uri[scheme_end..at].find(':')? + scheme_end;
        let after = &uri[colon + 1..at];
        let port = after.find(['/', '?']).map_or(after, |p| &after[..p]);
        (port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit())).then_some(at)
    };
    if let Some(at) = uri[scheme_end..authority_end]
        .rfind('@')
        .map(|p| p + scheme_end)
        .or_else(fallback_at)
    {
        if let Some(colon) = uri[scheme_end..at].find(':').map(|p| p + scheme_end) {
            prefix = format!("{}:********", &uri[..colon]);
            rest_start = at;
        }
    }
    let (head, query) = match uri[rest_start..].split_once('?') {
        Some((h, q)) => (h, Some(q)),
        None => (&uri[rest_start..], None),
    };
    let redact_params = |q: &str| -> String {
        q.split('&')
            .map(|kv| match kv.split_once('=') {
                Some((k, _))
                    if CONNINFO_SECRET_KEYS
                        .contains(&percent_decode(k).to_ascii_lowercase().as_str()) =>
                {
                    format!("{k}=********")
                }
                _ => kv.to_string(),
            })
            .collect::<Vec<_>>()
            .join("&")
    };
    // クエリの値に `@` があると (`h?application_name=a@b&password=x`)、ユーザー情報の区切りが元の `?` より
    // 後ろに来て `?` が伏せ字に呑まれる。そのときは残り (`@b&password=x`) もクエリの続きとして扱い、
    // `&` の後ろの password / sslpassword を伏せる (安全側)。
    let head = if uri[scheme_end..rest_start].contains('?') {
        match head.split_once('&') {
            Some((first, more)) => format!("{prefix}{first}&{}", redact_params(more)),
            None => format!("{prefix}{head}"),
        }
    } else {
        format!("{prefix}{head}")
    };
    match query {
        None => head,
        Some(q) => format!("{head}?{}", redact_params(q)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_mysql_identified_by() {
        let out = redact_credentials(
            "ALTER USER 'app'@'%' IDENTIFIED BY 'S3cret!';",
            DriverKind::Mysql,
        );
        assert_eq!(out, "ALTER USER 'app'@'%' IDENTIFIED BY '********';");
    }

    #[test]
    fn untouched_input_is_borrowed() {
        assert!(matches!(
            redact_credentials("SELECT 1", DriverKind::Mysql),
            Cow::Borrowed(_)
        ));
    }

    #[test]
    fn sqlite_is_never_redacted() {
        let sql = "ALTER USER u IDENTIFIED BY 'x'";
        assert_eq!(redact_credentials(sql, DriverKind::Sqlite), sql);
    }

    #[test]
    fn redaction_is_idempotent() {
        let once =
            redact_credentials("CREATE ROLE r PASSWORD 'abc'", DriverKind::Postgres).into_owned();
        assert_eq!(redact_credentials(&once, DriverKind::Postgres), once);
    }

    #[test]
    fn conninfo_password_is_redacted_in_every_value_form() {
        // 裸の値・引用符つき (空白・エスケープ入り)・= の前後の空白・大文字のキー。
        assert_eq!(
            redact_conninfo("host=db.example port=5432 user=repl password=s3cret dbname=app"),
            "host=db.example port=5432 user=repl password='********' dbname=app"
        );
        assert_eq!(
            redact_conninfo(r"host=h password='a b\'c\\d' dbname=x"),
            "host=h password='********' dbname=x"
        );
        assert_eq!(
            redact_conninfo("host=h PASSWORD = 'p w' sslpassword=zz"),
            "host=h password='********' sslpassword='********'"
        );
        // パスワードが無ければそのまま。passfile (パス) は伏せない。
        assert_eq!(
            redact_conninfo("host=h passfile=/home/u/.pgpass sslmode=require"),
            "host=h passfile=/home/u/.pgpass sslmode=require"
        );
        // 値の文字列中に password という語があっても、キーが password でなければ触らない。
        assert_eq!(
            redact_conninfo("application_name='my password app' host=h"),
            "application_name='my password app' host=h"
        );
    }

    #[test]
    fn conninfo_uri_and_malformed_input_never_leak() {
        assert_eq!(
            redact_conninfo("postgresql://repl:s3cret@db:5432/app?sslmode=require&password=zzz"),
            "postgresql://repl:********@db:5432/app?sslmode=require&password=********"
        );
        // クエリのキーがパーセントエンコードされていても伏せる。
        assert_eq!(
            redact_conninfo("postgresql://h/app?pass%77ord=zzz&SSLPASS%57ORD=yy&x=1"),
            "postgresql://h/app?pass%77ord=********&SSLPASS%57ORD=********&x=1"
        );
        assert_eq!(
            redact_conninfo("postgres://repl@db/app"),
            "postgres://repl@db/app"
        );
        // 閉じていない引用符・形式が壊れた残りでも、パスワードの値を出さない。
        let broken = redact_conninfo("host=h password='abc");
        assert!(!broken.contains("abc"), "{broken}");
        let garbled = redact_conninfo("host=h password");
        assert!(!garbled.to_lowercase().contains("password") || garbled.contains("********"));
        assert_eq!(redact_conninfo(""), "");
        // 伏せたあとの再実行で変わらない。
        let once = redact_conninfo("host=h password=abc");
        assert_eq!(redact_conninfo(&once), once);
    }

    #[test]
    fn conninfo_uri_password_with_question_mark_is_redacted() {
        assert_eq!(
            redact_conninfo("postgresql://u:p?x@h/db"),
            "postgresql://u:********@h/db"
        );
        assert_eq!(
            redact_conninfo("postgresql://u:p?x@h/db?sslmode=require&password=zz"),
            "postgresql://u:********@h/db?sslmode=require&password=********"
        );
        assert_eq!(
            redact_conninfo("postgresql://u:a@b?c@h"),
            "postgresql://u:********@h"
        );
    }

    #[test]
    fn conninfo_userinfo_like_word_is_redacted() {
        assert_eq!(
            redact_conninfo("\u{feff}postgresql://u:secret1@h/db"),
            "'********'"
        );
        assert_eq!(
            redact_conninfo("host=a postgresql:/u:secret1@h"),
            "host=a '********'"
        );
        assert_eq!(redact_conninfo("host=db user=repl"), "host=db user=repl");
        let v = conninfo_secret_values("postgresql:/u:secret1@h");
        assert!(v.iter().any(|s| s == "secret1"));
    }

    #[test]
    fn pg_literal_decoders_match_the_server() {
        let c = |s: &str| s.chars().collect::<Vec<_>>();
        assert_eq!(
            decode_pg_e(&c("a\\nb\\x41\\101\\u0042\\q''")),
            "a\nbAAB".to_string() + "q'"
        );
        assert_eq!(decode_pg_e(&c("\\uD83D\\uDE00")), "\u{1F600}");
        assert_eq!(decode_pg_e(&c("\\xC3\\xA9")), "\u{e9}");
        assert_eq!(decode_pg_u(&c("\\0061\\+000062\\\\"), '\\'), "ab\\");
        assert_eq!(decode_pg_u(&c("!0061!!"), '!'), "a!");
        assert_eq!(decode_pg_u(&c("\\D83D\\DE00"), '\\'), "\u{1F600}");
    }

    #[test]
    fn userinfo_like_word_with_equals_or_space_in_password_is_redacted() {
        for w in [
            "postgresql:/u:pa55==@h",
            "\u{feff}postgresql://u:ab=cd@h/db",
            "postgresql:/u:my secret@h",
        ] {
            assert_eq!(redact_conninfo(w), "'********'", "{w}");
        }
        let v = conninfo_secret_values("postgresql:/u:pa55==@h");
        assert!(v.iter().any(|s| s == "postgresql:/u:pa55"));
        assert!(v.iter().any(|s| s == "pa55"));
    }

    #[test]
    fn userinfo_word_candidates_do_not_grow_with_colons() {
        let big = format!("host=a {}@h", ":".repeat(20000));
        assert!(conninfo_secret_values(&big).len() <= 200);
        let many_words = format!("x:y {}", "w ".repeat(5000));
        assert!(conninfo_secret_values(&many_words).len() <= 200);
    }

    #[test]
    fn conninfo_uri_slash_in_password_is_redacted() {
        assert_eq!(
            redact_conninfo("postgresql://u:p/xyz1@h/db"),
            "postgresql://u:********@h/db"
        );
    }

    #[test]
    fn conninfo_uri_port_colon_with_at_in_query_is_not_userinfo() {
        // クエリの `@` とポートの `:` をユーザー情報と取り違えて表示を崩さない。
        assert_eq!(
            redact_conninfo("postgresql://h:5432/db?application_name=me@corp"),
            "postgresql://h:5432/db?application_name=me@corp"
        );
    }

    #[test]
    fn conninfo_uri_query_password_survives_at_in_earlier_query_value() {
        // クエリの値の `@` でユーザー情報の区切りが `?` より後ろになっても、後ろの password を漏らさない。
        assert_eq!(
            redact_conninfo("postgresql://u:secret@host?application_name=a@b&password=topsecret"),
            "postgresql://u:********@b&password=********"
        );
        assert_eq!(
            redact_conninfo(
                "postgresql://u:secret@host?application_name=a@b&sslpassword=k&x=1?password=p"
            ),
            "postgresql://u:********@b&sslpassword=********&x=1?password=********"
        );
    }
}
