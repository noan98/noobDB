//! `.sql` スクリプトファイルの**逐次 (ストリーミング) 文分割** (#973)。
//!
//! 大きなダンプ (数百 MB〜GB) をメモリに丸ごと載せずに実行するため、ファイルを
//! チャンク単位で [`ScriptSplitter::push`] へ流し込み、確定した文から順に取り出す。
//! バッファに残るのは「まだ `;` で閉じていない現在の文」だけなので、メモリ使用量は
//! ファイル全体ではなく**最大の 1 文**の大きさで決まる。
//!
//! ## 分割規則はフロントの `src/sqlScript.ts` と同一 (共有ゴールデン)
//!
//! エディタのバッチ実行 (`splitSqlStatements`) とスクリプトランナーで文の切れ目が
//! 食い違うと、「エディタでは 1 文として実行できたものがファイル実行だと壊れる」
//! (あるいはその逆) という事故になる。そこで規則を完全に揃え、
//! `src/__tests__/fixtures/scriptSplitVectors.json` をフロント
//! (`scriptSplitGolden.test.ts`) とバック (`tests/script_split_golden.rs`) の両方が
//! 読んで同じ分割結果になることを CI で固定する。規則:
//!
//! * トップレベルの `;` で区切る。
//! * `'…'` / `"…"` / `` `…` `` の中の `;` では区切らない。二重化 (`''`) は
//!   エスケープ。**`'…'` 内のバックスラッシュをエスケープとして読むのは MySQL
//!   だけ** (`mask_for_driver` / フロント `driverBackslashEscapes` と同じ、#852 /
//!   #1004)。
//! * `-- …` / `# …` 行コメント、`/* … */` ブロックコメントの中では区切らない
//!   (`#` をコメントとみなすのはマスク規約 #J3 と揃えるため)。
//! * PostgreSQL のドル引用 (`$$…$$` / `$tag$…$tag$`) の中では区切らない。直前が
//!   単語文字の `$` は識別子の一部なので開始タグとみなさない。
//! * 空白とコメントしか無い断片は文として数えない。ただし **条件付きコメント
//!   `/*! … */` は実行されるコード**として扱い (マスク規約でも全ドライバで本文を
//!   露出させる)、それだけの断片も文として残す — mysqldump が出力する
//!   `/*!40014 SET FOREIGN_KEY_CHECKS=0 */;` などを落とさないため。フロントの
//!   文分割 (#1074、`maskLiterals` ベース) と同じく、ドライバによらず同じ扱い。
//!
//! バイト単位で走査するが、判定に使う文字はすべて ASCII で、UTF-8 のマルチバイト
//! 文字を構成するバイトは必ず 0x80 以上なので、ASCII 記号と取り違えることはない
//! (フロントの UTF-16 単位の走査と同じ結果になる)。
//!
//! 安全網との関係: この分割は「どこで区切って 1 文ずつドライバへ渡すか」を決める
//! だけで、読み取り専用ガードは分割後の**各文**に対して `is_read_only_sql_for`
//! (スタックされた `;` を検出すると拒否する) で改めて強制する。分割がマスクより
//! 多く区切っても少なく区切っても、ガードは fail-closed のまま。

use super::DriverKind;

/// 分割で確定した 1 文。`sql` は前後の空白を除いた本文 (末尾の `;` なし)、
/// `line` は本文の先頭がファイル内で何行目か (1 始まり)。エラー箇所の報告に使う。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptStatement {
    pub sql: String,
    pub line: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ScanState {
    Normal,
    LineComment,
    BlockComment,
    /// (引用符, バックスラッシュがエスケープか)
    Quoted(u8, bool),
    Dollar(Vec<u8>),
}

/// 1 文として許容する最大バイト数。閉じられていない文字列リテラル等で `;` が
/// 永久に見つからないまま GB 級のファイル全体をバッファへ溜め込む (OOM) のを防ぐ。
/// mysqldump の拡張 INSERT は既定で 1 文あたり ~1 MB 程度なので十分に大きい。
pub const MAX_SCRIPT_STATEMENT_BYTES: usize = 64 * 1024 * 1024;

/// ストリーミング文分割器。[`push`](Self::push) でテキストを追加するたびに、確定
/// した文を返す。入力の終わりで [`finish`](Self::finish) を呼ぶと残りを返す。
pub struct ScriptSplitter {
    mysql: bool,
    /// PostgreSQL か (`E'…'` の `\` エスケープ判定用)。
    postgres: bool,
    /// 現在の (まだ閉じていない) 文のテキスト。
    buf: String,
    /// `buf` 内の走査カーソル (バイト位置)。バックスラッシュエスケープで次チャンクの
    /// 先頭を読み飛ばすときだけ一時的に `buf.len()` を超えうる。
    pos: usize,
    state: ScanState,
    /// `buf[0]` がファイル内で何行目か (1 始まり)。
    line_base: u64,
    max_statement_bytes: usize,
}

/// 1 文が [`MAX_SCRIPT_STATEMENT_BYTES`] を超えたときのエラー。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatementTooLarge {
    pub line: u64,
    pub limit: usize,
}

impl ScriptSplitter {
    pub fn new(driver: DriverKind) -> Self {
        Self::with_limit(driver, MAX_SCRIPT_STATEMENT_BYTES)
    }

    pub fn with_limit(driver: DriverKind, max_statement_bytes: usize) -> Self {
        Self {
            mysql: driver == DriverKind::Mysql,
            postgres: driver == DriverKind::Postgres,
            buf: String::new(),
            pos: 0,
            state: ScanState::Normal,
            line_base: 1,
            max_statement_bytes,
        }
    }

    /// `chunk` を追加し、この時点で確定した文を返す。
    pub fn push(&mut self, chunk: &str) -> Result<Vec<ScriptStatement>, StatementTooLarge> {
        self.buf.push_str(chunk);
        let mut out = Vec::new();
        self.scan(false, &mut out);
        if self.buf.len() > self.max_statement_bytes {
            return Err(StatementTooLarge {
                line: self.line_base,
                limit: self.max_statement_bytes,
            });
        }
        Ok(out)
    }

    /// 入力の終わり。末尾の `;` で閉じていない最後の文も含めて返す。
    pub fn finish(mut self) -> Vec<ScriptStatement> {
        let mut out = Vec::new();
        self.scan(true, &mut out);
        let rest = std::mem::take(&mut self.buf);
        self.push_segment(&rest, &mut out);
        out
    }

    fn scan(&mut self, eof: bool, out: &mut Vec<ScriptStatement>) {
        loop {
            let len = self.buf.len();
            if self.pos >= len {
                return;
            }
            let bytes = self.buf.as_bytes();
            match &self.state {
                ScanState::Normal => {
                    let c = bytes[self.pos];
                    let next = bytes.get(self.pos + 1).copied();
                    if (c == b'-' || c == b'/') && next.is_none() && !eof {
                        // `--` / `/*` の判定に次の 1 バイトが要る。
                        return;
                    }
                    if c == b'-' && next == Some(b'-') {
                        // MySQL は `--` の直後が空白・制御文字・文末のときだけコメント (#1735)。
                        // 直後の 1 バイトが要るので、チャンク境界なら次を待つ。
                        if self.mysql {
                            match bytes.get(self.pos + 2) {
                                None if !eof => return,
                                Some(&d) if !(d.is_ascii_whitespace() || d.is_ascii_control()) => {
                                    self.pos += 1;
                                    continue;
                                }
                                _ => {}
                            }
                        }
                        self.state = ScanState::LineComment;
                        self.pos += 2;
                        continue;
                    }
                    // `#` 行コメントは MySQL だけ (PostgreSQL では XOR / jsonb パス演算子、#1517)。
                    if c == b'#' && self.mysql {
                        self.state = ScanState::LineComment;
                        self.pos += 1;
                        continue;
                    }
                    if c == b'/' && next == Some(b'*') {
                        self.state = ScanState::BlockComment;
                        self.pos += 2;
                        continue;
                    }
                    if c == b'\'' || c == b'"' || c == b'`' {
                        // バックスラッシュがエスケープになるのは MySQL の '…' / "…" と、
                        // PostgreSQL の E'…' (直前が単独の E/e) だけ。
                        let escapes = (self.mysql && c != b'`')
                            || (self.postgres
                                && c == b'\''
                                && self.pos >= 1
                                && matches!(bytes[self.pos - 1], b'e' | b'E')
                                && (self.pos == 1
                                    || !super::is_pg_ident_byte(bytes[self.pos - 2])));
                        self.state = ScanState::Quoted(c, escapes);
                        self.pos += 1;
                        continue;
                    }
                    if c == b'$' && (self.pos == 0 || !is_word_byte(bytes[self.pos - 1])) {
                        match dollar_tag_len(bytes, self.pos, eof) {
                            TagMatch::NeedMore => return,
                            TagMatch::Tag(n) => {
                                let tag = bytes[self.pos..self.pos + n].to_vec();
                                self.state = ScanState::Dollar(tag);
                                self.pos += n;
                                continue;
                            }
                            TagMatch::None => {}
                        }
                    }
                    if c == b';' {
                        let end = self.pos;
                        let seg: String = self.buf[..end].to_string();
                        self.push_segment(&seg, out);
                        self.buf.drain(..=end);
                        self.pos = 0;
                        continue;
                    }
                    self.pos += 1;
                }
                ScanState::LineComment => {
                    match bytes[self.pos..].iter().position(|&b| b == b'\n') {
                        Some(off) => {
                            // 改行自体は通常文字として次の周回で処理する (フロントと同じ)。
                            self.pos += off;
                            self.state = ScanState::Normal;
                        }
                        None => {
                            self.pos = len;
                            return;
                        }
                    }
                }
                ScanState::BlockComment => match find(bytes, self.pos, b"*/") {
                    Some(at) => {
                        self.pos = at + 2;
                        self.state = ScanState::Normal;
                    }
                    None => {
                        // 末尾の `*` が次チャンクの `/` と組になりうるので 1 バイト残す。
                        self.pos = if eof {
                            len
                        } else {
                            self.pos.max(len.saturating_sub(1))
                        };
                        return;
                    }
                },
                ScanState::Quoted(q, escapes) => {
                    let q = *q;
                    let backslash = *escapes;
                    let mut j = self.pos;
                    let mut closed = false;
                    while j < len {
                        let d = bytes[j];
                        if d == q {
                            match bytes.get(j + 1) {
                                // 二重化 (`''`) かどうかは次のバイト次第なので待つ。
                                None if !eof => break,
                                Some(&n) if n == q => {
                                    j += 2;
                                    continue;
                                }
                                _ => {
                                    j += 1;
                                    closed = true;
                                    break;
                                }
                            }
                        }
                        if backslash && d == b'\\' {
                            j += 2;
                            continue;
                        }
                        j += 1;
                    }
                    self.pos = j;
                    if closed {
                        self.state = ScanState::Normal;
                        continue;
                    }
                    // 閉じ引用符の次のバイト待ちか、チャンク末尾まで文字列の内側。
                    return;
                }
                ScanState::Dollar(tag) => match find(bytes, self.pos, tag) {
                    Some(at) => {
                        self.pos = at + tag.len();
                        self.state = ScanState::Normal;
                    }
                    None => {
                        let keep = tag.len().saturating_sub(1);
                        self.pos = if eof {
                            len
                        } else {
                            self.pos.max(len.saturating_sub(keep))
                        };
                        return;
                    }
                },
            }
        }
    }

    /// `raw` (区切りの `;` を含まない 1 断片) を文として確定させ、行番号を進める。
    fn push_segment(&mut self, raw: &str, out: &mut Vec<ScriptStatement>) {
        let trimmed = raw.trim_matches(is_js_whitespace);
        if !trimmed.is_empty() && has_executable_sql(trimmed, true, self.mysql) {
            let leading = raw.len() - raw.trim_start_matches(is_js_whitespace).len();
            let lead_lines = count_newlines(&raw[..leading]);
            out.push(ScriptStatement {
                sql: trimmed.to_string(),
                line: self.line_base + lead_lines,
            });
        }
        // 断片の改行 + 区切りの `;` (改行ではない) ぶん行番号を進める。
        self.line_base += count_newlines(raw);
    }
}

/// スクリプト全体を一度に分割する (共有ゴールデンとユニットテスト用)。
pub fn split_script(driver: DriverKind, sql: &str) -> Vec<ScriptStatement> {
    let mut s = ScriptSplitter::with_limit(driver, usize::MAX);
    // with_limit(usize::MAX) なので Err には到達しないが、panic させずに空で返す。
    let mut out = s.push(sql).unwrap_or_default();
    out.extend(s.finish());
    out
}

enum TagMatch {
    NeedMore,
    Tag(usize),
    None,
}

/// `bytes[i] == b'$'` のとき、ドル引用の開始タグ (`$$` / `$tag$`) の長さを返す。
/// タグは識別子風で数字始まり不可 (`$1` はプレースホルダ)。フロントの
/// `matchDollarTag` と同じ判定。
fn dollar_tag_len(bytes: &[u8], i: usize, eof: bool) -> TagMatch {
    let len = bytes.len();
    let mut j = i + 1;
    if j >= len {
        return if eof {
            TagMatch::None
        } else {
            TagMatch::NeedMore
        };
    }
    if bytes[j].is_ascii_digit() {
        return TagMatch::None;
    }
    while j < len && is_word_byte(bytes[j]) {
        j += 1;
    }
    if j >= len {
        return if eof {
            TagMatch::None
        } else {
            TagMatch::NeedMore
        };
    }
    if bytes[j] == b'$' {
        TagMatch::Tag(j + 1 - i)
    } else {
        TagMatch::None
    }
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn find(hay: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || from >= hay.len() {
        return None;
    }
    hay[from..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

fn count_newlines(s: &str) -> u64 {
    s.bytes().filter(|&b| b == b'\n').count() as u64
}

/// JS の `String.prototype.trim` が除去する空白と同じ集合 (フロントとの一致用)。
/// Rust の `char::is_whitespace` との差は U+0085 (JS は空白扱いしない) と
/// U+FEFF (JS は空白扱いする) の 2 つ。
fn is_js_whitespace(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// コメントを除いて実行可能な SQL が残るか。フロントの `hasExecutableSql` と同じく
/// ブロックコメント → `--` 行コメント → `#` 行コメントの順に除去してから判定する
/// (文字列リテラルは考慮しない正規表現相当の近似 — 完全一致のため同じ近似を採る)。
/// MySQL では `/*! … */` を除去しない (実行されるコードのため)。
fn has_executable_sql(fragment: &str, mysql: bool, hash_comment: bool) -> bool {
    let no_block = strip_block_comments(fragment, mysql);
    let no_dash = strip_line_comments(&no_block, "--");
    // `#` 行コメントは MySQL だけ (#1517)。
    let no_hash = if hash_comment {
        strip_line_comments(&no_dash, "#")
    } else {
        no_dash
    };
    !no_hash.trim_matches(is_js_whitespace).is_empty()
}

/// `/\*[\s\S]*?\*\//g` (MySQL は `/\/\*(?!!)[\s\S]*?\*\//g`) による置換と同じ結果。
fn strip_block_comments(s: &str, keep_version_comments: bool) -> String {
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut copied = 0usize;
    let mut i = 0usize;
    while i + 1 < b.len() {
        if b[i] == b'/' && b[i + 1] == b'*' {
            if keep_version_comments && b.get(i + 2) == Some(&b'!') {
                i += 1;
                continue;
            }
            match find(b, i + 2, b"*/") {
                Some(close) => {
                    out.push_str(&s[copied..i]);
                    i = close + 2;
                    copied = i;
                    continue;
                }
                // 閉じていない `/*` は正規表現にマッチしないのでそのまま残る。
                None => break,
            }
        }
        i += 1;
    }
    out.push_str(&s[copied..]);
    out
}

/// `/<marker>[^\n\r]*/g` による置換と同じ結果。
fn strip_line_comments(s: &str, marker: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(at) = rest.find(marker) {
        out.push_str(&rest[..at]);
        let after = &rest[at..];
        let end = after.find(['\n', '\r']).unwrap_or(after.len());
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

/// スクリプト中のトランザクション制御文。ランナーはこれらを生の SQL として
/// プール接続へ流さず、明示トランザクションのプリミティブ
/// (`Connection::begin_transaction` / `finish_transaction`) へ読み替える —
/// プールの別々の接続で `BEGIN` と `COMMIT` を実行すると、トランザクションを
/// 開いたままの接続がプールへ戻ってしまうため。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TxControl {
    Begin,
    Commit,
    Rollback,
}

/// `sql` (分割済みの 1 文) がトランザクション制御文なら種別を返す。
///
/// 認識するのは「それだけで完結する」形のみ: `BEGIN` / `BEGIN TRANSACTION|TRAN|WORK`
/// / `BEGIN DEFERRED|IMMEDIATE|EXCLUSIVE [TRANSACTION]` (SQLite) / `START
/// TRANSACTION …` / `COMMIT [WORK|TRANSACTION|TRAN]` / `END [TRANSACTION|WORK]`
/// (PostgreSQL/SQLite) / `ROLLBACK [WORK|TRANSACTION|TRAN]`。`ROLLBACK TO
/// SAVEPOINT` や MSSQL の `BEGIN TRY` / `BEGIN … END` ブロックは対象外 (そのまま
/// 通常の文として実行される)。コメントは除去してから判定する。
#[cfg(test)]
pub fn classify_tx_control(driver: DriverKind, sql: &str) -> Option<TxControl> {
    classify_tx_statement(driver, sql).map(|(ctl, _)| ctl)
}

/// `classify_tx_control` に加え、開始文に付いた分離レベル / READ ONLY を
/// [`TxOptions`] として返す (PostgreSQL の `BEGIN ISOLATION LEVEL SERIALIZABLE` や
/// MySQL の `START TRANSACTION READ ONLY` など)。開始文なのに解釈できない語が残る
/// ときは `Err` (fail-closed: 生の SQL としてプールへ流さず、呼び出し側がエラーにする)。
/// `BEGIN SELECT 1` のように開始文でないものだけ `None`。
pub fn classify_tx_statement(
    driver: DriverKind,
    sql: &str,
) -> Option<(TxControl, Result<crate::db::tx_options::TxOptions, String>)> {
    use crate::db::tx_options::TxOptions;
    // 先頭語がトランザクション制御語でなければ、全文のマスク走査 (数 MB の INSERT でも
    // 文字配列化される) を省いて None を返す。先頭が英字のときだけ判定し、コメント・
    // 引用符で始まる文は従来どおりマスク後に判定する。
    let trimmed = sql.trim_start();
    if trimmed.starts_with(|c: char| c.is_ascii_alphabetic()) {
        let word_len = trimmed
            .bytes()
            .take_while(|b| b.is_ascii_alphabetic())
            .count();
        let word = &trimmed[..word_len];
        let is_tx_word = ["begin", "start", "commit", "end", "rollback"]
            .iter()
            .any(|w| word.eq_ignore_ascii_case(w));
        if !is_tx_word {
            return None;
        }
    }
    let orig: Vec<char> = sql.chars().collect();
    let masked: String = super::mask_for_driver(driver, &orig).into_iter().collect();
    let lower = masked.to_ascii_lowercase();
    let words: Vec<&str> = lower
        .split(|c: char| c.is_whitespace() || c == ';' || c == ',')
        .filter(|w| !w.is_empty())
        .collect();
    let first = *words.first()?;
    let rest = &words[1..];
    let only = |allowed: &[&str]| rest.len() <= 1 && rest.iter().all(|w| allowed.contains(w));
    let plain =
        |ctl: bool, ctl_kind: TxControl| ctl.then_some((ctl_kind, Ok(TxOptions::default())));
    match first {
        "begin" => {
            let (mode, tail) = match rest.first() {
                Some(&("deferred" | "immediate" | "exclusive")) => (true, &rest[1..]),
                _ => (false, rest),
            };
            let tail = match tail.first() {
                Some(&("transaction" | "tran" | "work")) => &tail[1..],
                _ => tail,
            };
            if mode && tail.is_empty() {
                return Some((TxControl::Begin, Ok(TxOptions::default())));
            }
            // 後ろに続くのがトランザクションのモード語でなければ開始文ではない。
            if let Some(w) = tail.first() {
                if !matches!(*w, "isolation" | "read" | "deferrable" | "not" | "with") {
                    return None;
                }
            }
            Some((TxControl::Begin, parse_tx_modes(driver, tail)))
        }
        "start" => {
            if rest.first() != Some(&"transaction") {
                return None;
            }
            Some((TxControl::Begin, parse_tx_modes(driver, &rest[1..])))
        }
        "commit" => plain(only(&["work", "transaction", "tran"]), TxControl::Commit),
        // `END` は COMMIT の同義語だが PostgreSQL / SQLite の構文。MySQL では
        // 単独の `END` は構文エラーなので、制御文に読み替えずサーバへ流してエラーで止める。
        "end" if driver != DriverKind::Mysql => {
            plain(only(&["work", "transaction"]), TxControl::Commit)
        }
        "rollback" => plain(only(&["work", "transaction", "tran"]), TxControl::Rollback),
        _ => None,
    }
}

/// 開始文の後ろに付く `ISOLATION LEVEL ...` / `READ ONLY` / `READ WRITE` を解釈する。
/// `DEFERRABLE` / `NOT DEFERRABLE` は読み飛ばす。解釈できない語が残れば `Err`。
fn parse_tx_modes(
    driver: DriverKind,
    words: &[&str],
) -> Result<crate::db::tx_options::TxOptions, String> {
    use crate::db::tx_options::{TxIsolation, TxOptions};
    let mut opts = TxOptions::default();
    let mut i = 0;
    while i < words.len() {
        match &words[i..] {
            ["isolation", "level", "read", "uncommitted", ..] => {
                opts.isolation = Some(TxIsolation::ReadUncommitted);
                i += 4;
            }
            ["isolation", "level", "read", "committed", ..] => {
                opts.isolation = Some(TxIsolation::ReadCommitted);
                i += 4;
            }
            ["isolation", "level", "repeatable", "read", ..] => {
                opts.isolation = Some(TxIsolation::RepeatableRead);
                i += 4;
            }
            ["isolation", "level", "serializable", ..] => {
                opts.isolation = Some(TxIsolation::Serializable);
                i += 3;
            }
            ["read", "only", ..] => {
                opts.read_only = true;
                i += 2;
            }
            ["read", "write", ..] => {
                opts.read_only = false;
                i += 2;
            }
            // MySQL の `WITH CONSISTENT SNAPSHOT` は従来どおり受理する (オプションは
            // 反映しないが、生の SQL としてプールへ流れて境界が崩れるよりは安全)。
            ["with", "consistent", "snapshot", ..] if driver == DriverKind::Mysql => {
                i += 3;
            }
            ["not", "deferrable", ..] if driver == DriverKind::Postgres => {
                i += 2;
            }
            ["deferrable", ..] if driver == DriverKind::Postgres => {
                i += 1;
            }
            other => return Err(format!("unsupported transaction mode near `{}`", other[0])),
        }
    }
    Ok(opts)
}

/// `USE <db>` 文なら切り替え先のデータベース名を返す (MySQL のみ)。
/// プール接続で逐次実行するとき、後続の文に同じ DB コンテキストを渡し続けるために
/// 使う。引用符 (`` ` `` / `"`) は外す。
pub fn parse_use_database(driver: DriverKind, sql: &str) -> Option<String> {
    if driver != DriverKind::Mysql {
        return None;
    }
    // 先頭・末尾のコメント (`/* … */` / `-- …` / `# …`) は読み飛ばす
    // (`USE shop /* 本番 */;` を取りこぼすと後続文が旧 DB に戻される)。
    let cleaned = strip_use_comments(sql);
    let body = cleaned
        .trim()
        .trim_end_matches(|c: char| c == ';' || c.is_whitespace());
    let mut it = body.splitn(2, char::is_whitespace);
    let kw = it.next()?;
    if !kw.eq_ignore_ascii_case("use") {
        return None;
    }
    let name = it.next()?.trim();
    if name.is_empty() || (name.contains(char::is_whitespace) && !is_quoted(name)) {
        return None;
    }
    let unquoted = if is_quoted(name) {
        &name[1..name.len() - 1]
    } else {
        name
    };
    if unquoted.is_empty() {
        return None;
    }
    Some(unquoted.to_string())
}

/// `USE` 文の解析用に、引用符の外にあるコメントを空白 1 つに置き換える
/// (MySQL: `-- ` / `#` 行コメントと `/* */`)。引用符の中身はそのまま残す。
fn strip_use_comments(sql: &str) -> String {
    let c: Vec<char> = sql.chars().collect();
    let n = c.len();
    let mut out = String::with_capacity(sql.len());
    let mut i = 0;
    while i < n {
        let ch = c[i];
        let dash = ch == '-'
            && i + 1 < n
            && c[i + 1] == '-'
            && (i + 2 >= n || c[i + 2].is_whitespace() || c[i + 2].is_control());
        if dash || ch == '#' {
            while i < n && c[i] != '\n' {
                i += 1;
            }
            out.push(' ');
            continue;
        }
        if ch == '/' && i + 1 < n && c[i + 1] == '*' {
            i += 2;
            while i < n && !(c[i] == '*' && i + 1 < n && c[i + 1] == '/') {
                i += 1;
            }
            i = (i + 2).min(n);
            out.push(' ');
            continue;
        }
        if ch == '`' || ch == '"' {
            out.push(ch);
            i += 1;
            while i < n {
                out.push(c[i]);
                i += 1;
                if c[i - 1] == ch {
                    break;
                }
            }
            continue;
        }
        out.push(ch);
        i += 1;
    }
    out
}

fn is_quoted(s: &str) -> bool {
    s.len() >= 2
        && ((s.starts_with('`') && s.ends_with('`'))
            || (s.starts_with('"') && s.ends_with('"'))
            || (s.starts_with('[') && s.ends_with(']')))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sqls(v: Vec<ScriptStatement>) -> Vec<String> {
        v.into_iter().map(|s| s.sql).collect()
    }

    /// どこでチャンクを切っても一括分割と同じ結果になること (境界を 1 バイト刻みで
    /// 全探索する)。
    fn assert_chunk_invariant(driver: DriverKind, sql: &str) {
        let whole = split_script(driver, sql);
        let bytes = sql.as_bytes();
        for size in 1..=8 {
            let mut s = ScriptSplitter::new(driver);
            let mut got = Vec::new();
            let mut start = 0;
            while start < bytes.len() {
                let mut end = (start + size).min(bytes.len());
                while !sql.is_char_boundary(end) {
                    end += 1;
                }
                got.extend(s.push(&sql[start..end]).unwrap());
                start = end;
            }
            got.extend(s.finish());
            assert_eq!(got, whole, "chunk size {size} for {sql:?}");
        }
    }

    #[test]
    fn splits_and_tracks_lines() {
        let got = split_script(DriverKind::Sqlite, "SELECT 1;\n\n  SELECT 2;\nSELECT\n3");
        assert_eq!(
            got,
            vec![
                ScriptStatement {
                    sql: "SELECT 1".into(),
                    line: 1
                },
                ScriptStatement {
                    sql: "SELECT 2".into(),
                    line: 3
                },
                ScriptStatement {
                    sql: "SELECT\n3".into(),
                    line: 4
                },
            ]
        );
    }

    #[test]
    fn chunk_boundaries_do_not_change_the_split() {
        let cases = [
            "SELECT 'a;''b'; SELECT 2",
            "SELECT 1 -- x; y\n; SELECT 2 /* a; */; SELECT $$ ; $$; SELECT $tag$ x;$ $tag$;",
            "INSERT INTO t VALUES ('日本語;テキスト'); SELECT `c;d`; SELECT \"e;f\"",
            "SELECT '\\'; DROP TABLE t; --'; SELECT 3",
            "/*!40014 SET FOREIGN_KEY_CHECKS=0 */;\nCREATE TABLE a(x int);",
            "SELECT a$b$ FROM t; SELECT $1; SELECT 1 # c;\n; SELECT 2",
            "SELECT 1--1; SELECT 2; SELECT 3-- x; SELECT 4\n; SELECT 5--",
        ];
        for sql in cases {
            for driver in [DriverKind::Mysql, DriverKind::Postgres, DriverKind::Sqlite] {
                assert_chunk_invariant(driver, sql);
            }
        }
    }

    #[test]
    fn mysql_dash_comment_needs_trailing_space_1735() {
        let texts = |driver| sqls(split_script(driver, "SELECT 1--1; DROP TABLE t"));
        assert_eq!(texts(DriverKind::Mysql), ["SELECT 1--1", "DROP TABLE t"]);
        assert_eq!(texts(DriverKind::Postgres).len(), 1);
        assert_eq!(texts(DriverKind::Sqlite).len(), 1);
    }

    #[test]
    fn mysql_backslash_escape_only_for_mysql() {
        let sql = "SELECT '\\'; DROP TABLE t; --'; SELECT 3";
        assert_eq!(
            sqls(split_script(DriverKind::Mysql, sql)),
            vec!["SELECT '\\'; DROP TABLE t; --'", "SELECT 3"]
        );
        assert_eq!(
            sqls(split_script(DriverKind::Postgres, sql)),
            vec!["SELECT '\\'", "DROP TABLE t"]
        );
    }

    #[test]
    fn version_comments_are_kept_as_statements_for_every_driver() {
        // マスク規約 (#1074) と同じく、ドライバによらず `/*! … */` は実行コード扱い。
        let sql = "/*!40014 SET FOREIGN_KEY_CHECKS=0 */;\n/* plain */;\nSELECT 1";
        for driver in [DriverKind::Mysql, DriverKind::Postgres] {
            assert_eq!(
                sqls(split_script(driver, sql)),
                vec!["/*!40014 SET FOREIGN_KEY_CHECKS=0 */", "SELECT 1"]
            );
        }
    }

    #[test]
    fn statement_size_limit_is_enforced() {
        let mut s = ScriptSplitter::with_limit(DriverKind::Sqlite, 16);
        assert!(s.push("SELECT 1;").is_ok());
        let err = s.push("SELECT 'unterminated string that").unwrap_err();
        assert_eq!(err.limit, 16);
    }

    #[test]
    fn classify_tx_statement_parses_options() {
        use crate::db::tx_options::{TxIsolation, TxOptions};
        let d = DriverKind::Postgres;
        assert_eq!(
            classify_tx_statement(d, "BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY"),
            Some((
                TxControl::Begin,
                Ok(TxOptions {
                    isolation: Some(TxIsolation::RepeatableRead),
                    read_only: true
                })
            ))
        );
        assert_eq!(
            classify_tx_statement(d, "begin transaction read only"),
            Some((
                TxControl::Begin,
                Ok(TxOptions {
                    isolation: None,
                    read_only: true
                })
            ))
        );
        assert_eq!(
            classify_tx_statement(DriverKind::Mysql, "START TRANSACTION READ WRITE"),
            Some((TxControl::Begin, Ok(TxOptions::default())))
        );
        // DEFERRABLE は読み飛ばし、解釈できない語は Err (生 SQL にしない)。
        assert_eq!(
            classify_tx_statement(
                d,
                "START TRANSACTION ISOLATION LEVEL SERIALIZABLE, READ ONLY, DEFERRABLE"
            ),
            Some((
                TxControl::Begin,
                Ok(TxOptions {
                    isolation: Some(TxIsolation::Serializable),
                    read_only: true
                })
            ))
        );
        assert!(matches!(
            classify_tx_statement(d, "BEGIN ISOLATION LEVEL FOO"),
            Some((TxControl::Begin, Err(_)))
        ));
        assert!(matches!(
            classify_tx_statement(d, "START TRANSACTION bogus"),
            Some((TxControl::Begin, Err(_)))
        ));
        assert_eq!(classify_tx_statement(d, "BEGIN SELECT 1"), None);
        // DEFERRABLE は PostgreSQL だけ、WITH CONSISTENT SNAPSHOT は MySQL だけ。
        for other in [DriverKind::Mysql, DriverKind::Sqlite] {
            assert!(matches!(
                classify_tx_statement(other, "START TRANSACTION DEFERRABLE"),
                Some((TxControl::Begin, Err(_)))
            ));
        }
        assert!(matches!(
            classify_tx_statement(d, "START TRANSACTION WITH CONSISTENT SNAPSHOT"),
            Some((TxControl::Begin, Err(_)))
        ));
        assert!(matches!(
            classify_tx_statement(
                DriverKind::Mysql,
                "START TRANSACTION WITH CONSISTENT SNAPSHOT"
            ),
            Some((TxControl::Begin, Ok(_)))
        ));
    }

    #[test]
    fn classifies_transaction_control() {
        use TxControl::*;
        let d = DriverKind::Sqlite;
        assert_eq!(classify_tx_control(d, "BEGIN"), Some(Begin));
        assert_eq!(classify_tx_control(d, "BEGIN TRANSACTION"), Some(Begin));
        assert_eq!(classify_tx_control(d, "begin immediate"), Some(Begin));
        assert_eq!(
            classify_tx_control(d, "BEGIN EXCLUSIVE TRANSACTION"),
            Some(Begin)
        );
        assert_eq!(
            classify_tx_control(d, "START TRANSACTION READ WRITE"),
            Some(Begin)
        );
        assert_eq!(classify_tx_control(d, "COMMIT"), Some(Commit));
        // 分離レベル / READ ONLY 付きの開始文 (PostgreSQL / MySQL) も開始文として扱う。
        assert_eq!(
            classify_tx_control(d, "BEGIN ISOLATION LEVEL SERIALIZABLE;"),
            Some(Begin)
        );
        assert_eq!(classify_tx_control(d, "BEGIN READ ONLY"), Some(Begin));
        assert_eq!(classify_tx_control(d, "BEGIN DEFERRABLE"), Some(Begin));
        assert_eq!(classify_tx_control(d, "BEGIN SELECT 1"), None);
        assert_eq!(classify_tx_control(d, "END"), Some(Commit));
        assert_eq!(classify_tx_control(d, "COMMIT -- done"), Some(Commit));
        assert_eq!(classify_tx_control(d, "ROLLBACK WORK"), Some(Rollback));
        assert_eq!(classify_tx_control(d, "ROLLBACK TO SAVEPOINT s1"), None);
        assert_eq!(classify_tx_control(d, "SELECT 1"), None);
        assert_eq!(classify_tx_control(d, "'BEGIN'"), None);
    }

    #[test]
    fn parses_use_database() {
        assert_eq!(
            parse_use_database(DriverKind::Mysql, "USE `my db`"),
            Some("my db".into())
        );
        assert_eq!(
            parse_use_database(DriverKind::Mysql, "use shop"),
            Some("shop".into())
        );
        assert_eq!(parse_use_database(DriverKind::Postgres, "USE shop"), None);
        assert_eq!(parse_use_database(DriverKind::Mysql, "USER x"), None);
    }

    #[test]
    fn use_database_ignores_comments_1601() {
        let d = DriverKind::Mysql;
        for sql in [
            "USE shop /* 本番 */",
            "USE shop /* a */;",
            "USE shop -- 本番",
            "USE shop # note",
            "/* x */ USE shop",
            "USE `shop` /* c */ ;",
        ] {
            assert_eq!(parse_use_database(d, sql), Some("shop".into()), "{sql}");
        }
        // 引用符の中の `--` / `/*` は名前の一部。
        assert_eq!(
            parse_use_database(d, "USE `a--b/*c*/`"),
            Some("a--b/*c*/".into())
        );
        assert_eq!(parse_use_database(d, "USE shop other"), None);
    }

    #[test]
    fn end_is_not_commit_on_mysql_1601() {
        assert_eq!(classify_tx_control(DriverKind::Mysql, "END"), None);
        assert_eq!(
            classify_tx_control(DriverKind::Postgres, "END"),
            Some(TxControl::Commit)
        );
        assert_eq!(
            classify_tx_control(DriverKind::Sqlite, "END TRANSACTION"),
            Some(TxControl::Commit)
        );
    }

    #[test]
    fn mysql_double_quote_backslash_escape_1601() {
        let sql = r#"INSERT INTO t VALUES ("a\"b; c"); SELECT 1;"#;
        assert_eq!(
            sqls(split_script(DriverKind::Mysql, sql)),
            vec![r#"INSERT INTO t VALUES ("a\"b; c")"#, "SELECT 1"]
        );
        assert_chunk_invariant(DriverKind::Mysql, sql);
        // PostgreSQL では "…" は識別子で `\` はただの文字。
        assert_eq!(
            sqls(split_script(
                DriverKind::Postgres,
                r#"SELECT "a\"; SELECT 2;"#
            ))
            .len(),
            2
        );
    }

    #[test]
    fn postgres_e_string_backslash_escape_1601() {
        let sql = r"INSERT INTO t VALUES (E'it\'s; ok'); SELECT 1;";
        assert_eq!(
            sqls(split_script(DriverKind::Postgres, sql)),
            vec![r"INSERT INTO t VALUES (E'it\'s; ok')", "SELECT 1"]
        );
        assert_chunk_invariant(DriverKind::Postgres, sql);
        // 通常の '…' では `\` はただの文字なので `'a\'` で閉じる。
        assert_eq!(
            sqls(split_script(
                DriverKind::Postgres,
                r"SELECT 'a\'; SELECT 2;"
            ))
            .len(),
            2
        );
        // 単語の一部の e は E 文字列の接頭辞ではない。
        assert_eq!(
            sqls(split_script(
                DriverKind::Postgres,
                r"SELECT name'a\'; SELECT 2;"
            ))
            .len(),
            2
        );
    }
}
