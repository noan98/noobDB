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
//!   `CREATE|ALTER SERVER … OPTIONS (PASSWORD '…')` / `MASTER_PASSWORD|SOURCE_PASSWORD = '…'`
//! - PostgreSQL: `CREATE|ALTER ROLE|USER|GROUP` 内の `[ENCRYPTED] PASSWORD '…'`
//!   (`USER MAPPING … OPTIONS (password '…')` を含む。`E'…'` とドル引用も)
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
    m: &'a [char],
    mysql: bool,
    pg: bool,
    out: Vec<(usize, usize)>,
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
            return Some((p, self.quote_end(p)));
        }
        if self.pg {
            if matches!(c, 'e' | 'E') && next == Some('\'') {
                return Some((p + 1, self.quote_end(p + 1)));
            }
            if matches!(c, 'u' | 'U') && next == Some('&') && self.m.get(p + 2) == Some(&'\'') {
                return Some((p + 2, self.quote_end(p + 2)));
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

    fn scan(&mut self) {
        let n = self.m.len();
        let mut i = 0;
        while i < n {
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

/// 資格情報リテラルの範囲 (文字オフセットの半開区間 `[開始, 終端)`、昇順・重なりなし)。
pub(crate) fn find_credential_ranges(sql: &str, driver: DriverKind) -> Vec<(usize, usize)> {
    if driver == DriverKind::Sqlite {
        return Vec::new();
    }
    let chars: Vec<char> = sql.chars().collect();
    let masked = mask_for_driver(driver, &chars);
    let mut sc = Scanner {
        m: &masked,
        mysql: driver == DriverKind::Mysql,
        pg: driver == DriverKind::Postgres,
        out: Vec::new(),
    };
    sc.scan();
    sc.out
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
}
