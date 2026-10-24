//! `.sql` スクリプトの**事前確認 (ドライラン)** の集計 (#1535)。
//!
//! 大きなダンプは GB 級になりうるので、全文をメモリに載せない。[`ScriptSplitter`]
//! (`db::script`) が確定した文を 1 文ずつ [`ScriptAnalyzer::push`] へ渡し、ここでは
//! 次の**有限個の情報だけ**を保持する。
//!
//! * 文の総数・種別ごとの件数 (読み取り / 書き込み / DDL / トランザクション制御)
//! * 先頭 [`HEAD_LIMIT`] 文の一覧 (プレビュー用。個別除外のチェックボックスの対象)
//! * 危険な文 (WHERE なしの DELETE / UPDATE、DROP、TRUNCATE、ALTER TABLE の DROP COLUMN / CONSTRAINT) の件数と、先頭
//!   [`LIST_LIMIT`] 件の一覧
//! * トランザクション制御文 (BEGIN / COMMIT / ROLLBACK) の位置の先頭 [`LIST_LIMIT`] 件
//! * 読み取り専用セッションで拒否される文の件数
//!
//! 判定は実行時と**同じ関数**を文ごとに流用する: 読み取り専用は
//! `is_read_only_sql_for` (実行時の `ensure_allowed_for_session` が使うもの)、
//! トランザクション制御は `classify_tx_statement`、スキーマ変更は `sql_may_change_schema`。
//! 危険文の判定 [`classify_dangerous`] はフロントの `src/dangerousSql.ts`
//! (`analyzeDangerousSql`) の Rust 実装で、共有ゴールデン
//! (`src/__tests__/fixtures/dangerousSqlVectors.json`) で一致を固定している。

use std::collections::HashMap;

use serde::Serialize;

use super::script::{classify_tx_statement, ScriptStatement, TxControl};
use super::{is_read_only_sql_for, mask_for_driver, sql_may_change_schema, DriverKind};

/// 先頭から一覧に保持する文の数 (個別除外の対象になる範囲)。
pub const HEAD_LIMIT: usize = 300;
/// 危険文・トランザクション制御文の一覧に保持する最大件数。
pub const LIST_LIMIT: usize = 200;
/// INSERT の対象テーブル別集計で別々に数える表の数の上限 (#1626)。超えた表への INSERT は
/// 表名を持たずに文の数だけ `insert_tables_overflow` へ足す (巨大ダンプでも状態を有限に保つ)。
pub const INSERT_TABLE_LIMIT: usize = 100;
/// 一覧に載せる SQL の最大文字数 (巨大な INSERT をそのまま返さない)。
const PREVIEW_CHARS: usize = 200;

/// 危険な文の種別。フロント `DangerKind` (`src/dangerousSql.ts`) と同じ名前。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DangerKind {
    DeleteNoWhere,
    UpdateNoWhere,
    Drop,
    Truncate,
    /// `ALTER TABLE ... DROP COLUMN` (#1626)。
    DropColumn,
    /// `ALTER TABLE ... DROP CONSTRAINT` / `DROP FOREIGN KEY` / `DROP PRIMARY KEY` / `DROP CHECK` (#1626)。
    DropConstraint,
}

/// 文の種別 (集計と一覧の表示用)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StatementCategory {
    /// 読み取り専用と判定できる文 (`SELECT` / `SET` 以外の `SHOW` など)。
    Read,
    /// データを書き換える文、または分類できない文 (fail-closed で書き込み扱い)。
    Write,
    /// スキーマを変更しうる文。
    Ddl,
    /// `BEGIN` / `COMMIT` / `ROLLBACK` 等 (ランナーが明示トランザクションに読み替える)。
    TxControl,
}

/// 一覧の 1 文。`index` は実行時の通し番号 (`ScriptFailure.index`) と同じ (1 始まり、
/// トランザクション制御文を含む) で、個別除外・再開位置の指定にそのまま使える。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzedStatement {
    pub index: u64,
    pub line: u64,
    pub sql: String,
    pub category: StatementCategory,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub danger: Option<DangerKind>,
    /// 読み取り専用セッションで実行時に拒否される文か。
    pub blocked: bool,
}

/// トランザクション制御文の位置。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TxControlMark {
    pub index: u64,
    pub line: u64,
    /// `begin` / `commit` / `rollback`。
    pub kind: &'static str,
}

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CategoryCounts {
    pub read: u64,
    pub write: u64,
    pub ddl: u64,
    pub tx_control: u64,
}

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DangerCounts {
    pub delete_no_where: u64,
    pub update_no_where: u64,
    pub drop: u64,
    pub truncate: u64,
    pub drop_column: u64,
    pub drop_constraint: u64,
}

/// INSERT の対象テーブル別の集計 (#1626)。`rows` は `VALUES (..),(..)` のタプル数の概算で、
/// `INSERT ... SELECT` のように行数を文面から数えられない文は 0 行として数える (文の数は数える)。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InsertTableCount {
    pub table: String,
    pub statements: u64,
    pub rows: u64,
}

/// 事前確認の結果。ファイルサイズに依らず小さい (一覧は上限つき)。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScriptAnalysis {
    pub total_statements: u64,
    pub categories: CategoryCounts,
    pub danger_counts: DangerCounts,
    pub dangerous_total: u64,
    /// 読み取り専用セッションで拒否される文の数 (緊急モード中は 0)。
    pub blocked_total: u64,
    /// トランザクション制御文の総数 (`tx_controls` は先頭 [`LIST_LIMIT`] 件のみ)。
    pub tx_control_total: u64,
    /// スクリプトが BEGIN したまま COMMIT / ROLLBACK なしで終わるか。ラップしない実行では
    /// EOF でランナーが取り消す (実行前に確定を選ぶこともできる, #1626) ため、実行前に知らせる。
    pub unclosed_transaction: bool,
    pub head: Vec<AnalyzedStatement>,
    pub dangerous: Vec<AnalyzedStatement>,
    pub tx_controls: Vec<TxControlMark>,
    /// INSERT の対象テーブル別の文数・概算行数 (概算行数の多い順、最大 [`INSERT_TABLE_LIMIT`] 表, #1626)。
    pub insert_tables: Vec<InsertTableCount>,
    /// 上限を超えて別集計できなかった表への INSERT の文数。0 でなければ `insert_tables` は一部のみ。
    pub insert_tables_overflow: u64,
    /// `head` に保持する最大件数 (`total_statements` がこれを超えると先頭のみ)。
    pub head_limit: u64,
    /// `dangerous` / `tx_controls` に保持する最大件数。
    pub list_limit: u64,
}

/// 文を 1 つずつ受け取り、[`ScriptAnalysis`] を組み立てる。
pub struct ScriptAnalyzer {
    driver: DriverKind,
    /// 実行時に非読み取り専用の文が拒否されるセッションか (緊急モードを除く)。
    enforce_read_only: bool,
    seen: u64,
    out: ScriptAnalysis,
    /// INSERT の対象テーブル別集計 (表名 → (文数, 概算行数))。`finish` で `out.insert_tables` へ。
    inserts: HashMap<String, (u64, u64)>,
}

impl ScriptAnalyzer {
    pub fn new(driver: DriverKind, enforce_read_only: bool) -> Self {
        Self {
            driver,
            enforce_read_only,
            seen: 0,
            inserts: HashMap::new(),
            out: ScriptAnalysis {
                total_statements: 0,
                categories: CategoryCounts::default(),
                danger_counts: DangerCounts::default(),
                dangerous_total: 0,
                blocked_total: 0,
                tx_control_total: 0,
                unclosed_transaction: false,
                head: Vec::new(),
                dangerous: Vec::new(),
                tx_controls: Vec::new(),
                insert_tables: Vec::new(),
                insert_tables_overflow: 0,
                head_limit: HEAD_LIMIT as u64,
                list_limit: LIST_LIMIT as u64,
            },
        }
    }

    /// これまでに見た文の数 (進捗表示用)。
    pub fn seen(&self) -> u64 {
        self.seen
    }

    /// これまでに見つけた危険文の数 (進捗表示用)。
    pub fn dangerous_so_far(&self) -> u64 {
        self.out.dangerous_total
    }

    pub fn push(&mut self, stmt: &ScriptStatement) {
        self.seen += 1;
        let index = self.seen;
        let sql = stmt.sql.as_str();
        self.out.total_statements = self.seen;

        if starts_with_word(sql, "insert") {
            self.record_insert(sql);
        }
        let (category, danger, blocked, tx_kind) = self.classify(sql);
        match category {
            StatementCategory::Read => self.out.categories.read += 1,
            StatementCategory::Write => self.out.categories.write += 1,
            StatementCategory::Ddl => self.out.categories.ddl += 1,
            StatementCategory::TxControl => self.out.categories.tx_control += 1,
        }
        if blocked {
            self.out.blocked_total += 1;
        }
        if let Some(kind) = tx_kind {
            self.out.tx_control_total += 1;
            self.out.unclosed_transaction = kind == "begin";
            if self.out.tx_controls.len() < LIST_LIMIT {
                self.out.tx_controls.push(TxControlMark {
                    index,
                    line: stmt.line,
                    kind,
                });
            }
        }
        if let Some(d) = danger {
            self.out.dangerous_total += 1;
            match d {
                DangerKind::DeleteNoWhere => self.out.danger_counts.delete_no_where += 1,
                DangerKind::UpdateNoWhere => self.out.danger_counts.update_no_where += 1,
                DangerKind::Drop => self.out.danger_counts.drop += 1,
                DangerKind::Truncate => self.out.danger_counts.truncate += 1,
                DangerKind::DropColumn => self.out.danger_counts.drop_column += 1,
                DangerKind::DropConstraint => self.out.danger_counts.drop_constraint += 1,
            }
        }
        let need_head = self.out.head.len() < HEAD_LIMIT;
        let need_danger = danger.is_some() && self.out.dangerous.len() < LIST_LIMIT;
        if need_head || need_danger {
            let item = AnalyzedStatement {
                index,
                line: stmt.line,
                sql: preview(sql),
                category,
                danger,
                blocked,
            };
            if need_danger {
                self.out.dangerous.push(item.clone());
            }
            if need_head {
                self.out.head.push(item);
            }
        }
    }

    pub fn finish(mut self) -> ScriptAnalysis {
        let mut tables: Vec<InsertTableCount> = self
            .inserts
            .into_iter()
            .map(|(table, (statements, rows))| InsertTableCount {
                table,
                statements,
                rows,
            })
            .collect();
        // 概算行数の多い順 (同数は文数、表名で決定的に)。
        tables.sort_by(|a, b| {
            b.rows
                .cmp(&a.rows)
                .then(b.statements.cmp(&a.statements))
                .then_with(|| a.table.cmp(&b.table))
        });
        self.out.insert_tables = tables;
        self.out
    }

    /// INSERT 1 文を対象テーブル別の集計へ足す (#1626)。表名を読み取れない文は数えない。
    fn record_insert(&mut self, sql: &str) {
        let Some((table, rest)) = insert_target(sql) else {
            return;
        };
        let rows = count_values_tuples(rest, self.driver == DriverKind::Mysql);
        if let Some(entry) = self.inserts.get_mut(&table) {
            entry.0 += 1;
            entry.1 = entry.1.saturating_add(rows);
        } else if self.inserts.len() < INSERT_TABLE_LIMIT {
            self.inserts.insert(table, (1, rows));
        } else {
            self.out.insert_tables_overflow += 1;
        }
    }

    /// 1 文を分類する。戻り値は (種別, 危険種別, 読み取り専用で拒否, 制御文の種類)。
    fn classify(
        &self,
        sql: &str,
    ) -> (
        StatementCategory,
        Option<DangerKind>,
        bool,
        Option<&'static str>,
    ) {
        // mysqldump の大半を占める INSERT は、マスク走査を省いて書き込みと決める
        // (INSERT で始まる 1 文が危険文・DDL・読み取り専用になることはない)。
        if starts_with_word(sql, "insert") {
            return (StatementCategory::Write, None, self.enforce_read_only, None);
        }
        // 解釈できないモード語を含む開始文 (`BEGIN ISOLATION LEVEL FOO`) は実行時に
        // エラーで止まるので、正常な制御文として数えず通常の文として分類する。
        if let Some((ctl, Ok(_))) = classify_tx_statement(self.driver, sql) {
            let kind = match ctl {
                TxControl::Begin => "begin",
                TxControl::Commit => "commit",
                TxControl::Rollback => "rollback",
            };
            // 制御文は実行時に `ensure_allowed_for_session` を通らない (読み替えられる)。
            return (StatementCategory::TxControl, None, false, Some(kind));
        }
        let danger = classify_dangerous(self.driver, sql);
        let read_only = is_read_only_sql_for(self.driver, sql);
        let category = if read_only {
            StatementCategory::Read
        } else if sql_may_change_schema(self.driver, sql) {
            StatementCategory::Ddl
        } else {
            StatementCategory::Write
        };
        (category, danger, self.enforce_read_only && !read_only, None)
    }
}

/// `INSERT [LOW_PRIORITY|DELAYED|HIGH_PRIORITY|IGNORE|OR <action>] [INTO] <表名>` の表名
/// (引用符を外し、`.` で連ねたもの) と、表名より後ろの文字列を返す (#1626)。引用符付きの表名は
/// 中の空白・`.` を保つ。表名を読み取れなければ `None`。
fn insert_target(sql: &str) -> Option<(String, &str)> {
    let mut rest = sql.trim_start();
    // 先頭の `INSERT`。
    rest = rest.get(6..)?;
    // 修飾語と INTO を読み飛ばす。
    loop {
        rest = rest.trim_start();
        let word_end = rest
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .unwrap_or(rest.len());
        let word = &rest[..word_end];
        let lower = word.to_ascii_lowercase();
        match lower.as_str() {
            "low_priority" | "delayed" | "high_priority" | "ignore" | "into" => {
                rest = &rest[word_end..];
            }
            // SQLite の `INSERT OR REPLACE / OR IGNORE / ...`
            "or" => {
                rest = rest[word_end..].trim_start();
                let w2 = rest
                    .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                    .unwrap_or(rest.len());
                rest = &rest[w2..];
            }
            _ => break,
        }
    }
    rest = rest.trim_start();
    let mut name = String::new();
    let mut i = 0;
    let bytes = rest.as_bytes();
    loop {
        // 1 つの識別子 (引用符付き or 素)。
        let part_start = i;
        match bytes.get(i)? {
            b'`' | b'"' | b'[' => {
                let close = if bytes[i] == b'[' { b']' } else { bytes[i] };
                let end = rest[i + 1..].find(close as char)? + i + 1;
                name.push_str(&rest[i + 1..end]);
                i = end + 1;
            }
            c if c.is_ascii_alphanumeric() || *c == b'_' || *c == b'$' || *c >= 0x80 => {
                while i < bytes.len()
                    && (bytes[i].is_ascii_alphanumeric()
                        || bytes[i] == b'_'
                        || bytes[i] == b'$'
                        || bytes[i] >= 0x80)
                {
                    i += 1;
                }
                name.push_str(&rest[part_start..i]);
            }
            _ => return None,
        }
        if bytes.get(i) == Some(&b'.') {
            name.push('.');
            i += 1;
        } else {
            break;
        }
    }
    if name.is_empty() {
        None
    } else {
        Some((name, &rest[i..]))
    }
}

/// `VALUES (..),(..)` のタプルの数 (#1626)。引用符の中の `(` は数えず、`VALUES` より前
/// (列リスト) と、タプルの後ろの `ON DUPLICATE KEY UPDATE ... VALUES(c)` は数えない。
/// `INSERT ... SELECT` のように `VALUES` が無ければ 0。コメントは考慮しない概算。
/// `backslash_escapes` は MySQL の文字列内 `\'` を閉じ引用符と取り違えないため。
fn count_values_tuples(rest: &str, backslash_escapes: bool) -> u64 {
    let b = rest.as_bytes();
    let mut i = 0;
    let mut depth = 0usize;
    let mut quote: Option<u8> = None;
    let mut in_values = false;
    let mut rows = 0u64;
    while i < b.len() {
        let c = b[i];
        if let Some(q) = quote {
            if backslash_escapes && c == b'\\' && q != b'`' {
                i += 2;
                continue;
            }
            if c == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        match c {
            b'\'' | b'"' | b'`' => quote = Some(c),
            b'(' => {
                if in_values && depth == 0 {
                    rows += 1;
                }
                depth += 1;
            }
            b')' => depth = depth.saturating_sub(1),
            _ if depth == 0 && c.is_ascii_alphabetic() => {
                let start = i;
                while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
                    i += 1;
                }
                let word = &rest[start..i];
                if in_values {
                    // タプルの並びの後ろに単語 (ON DUPLICATE / RETURNING など) が来たら終わり。
                    return rows;
                }
                if word.eq_ignore_ascii_case("values") || word.eq_ignore_ascii_case("value") {
                    in_values = true;
                }
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    rows
}

/// 先頭の空白を除いて `word` で始まり、直後が単語文字でなければ true (大文字小文字無視)。
pub(crate) fn starts_with_word(sql: &str, word: &str) -> bool {
    let s = sql.trim_start().as_bytes();
    let w = word.as_bytes();
    s.len() >= w.len()
        && s[..w.len()].eq_ignore_ascii_case(w)
        && s.get(w.len()).map_or(true, |c| !is_word_byte(*c))
}

fn is_word_byte(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

/// 事前確認の一覧に出す 1 行表示。dump の文は `-- Table structure ...` のような
/// 行コメントで始まることが多く、改行を潰すと「コメントが SQL を飲み込んだ」ように
/// 見えるため、先頭の `--` 行コメントを除いた SQL 本体を見せる (#1614)。全体が
/// コメントだけなら、そのまま見せる。
fn preview(sql: &str) -> String {
    let mut body = sql;
    loop {
        let t = body.trim_start();
        if !t.starts_with("--") {
            body = t;
            break;
        }
        match t.find('\n') {
            Some(i) => body = &t[i + 1..],
            None => {
                body = sql;
                break;
            }
        }
    }
    // コメントだけの文は本体が空になるので、元の SQL を見せる。
    if body.trim().is_empty() {
        body = sql;
    }
    let one_line = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() > PREVIEW_CHARS {
        let head: String = one_line.chars().take(PREVIEW_CHARS).collect();
        format!("{head}…")
    } else {
        one_line
    }
}

/// 1 文が危険か判定する (フロント `analyzeDangerousSql` と同じ規則)。ベストエフォートの
/// 安全網であってパーサではない: 先頭キーワードが `DELETE` / `UPDATE` でトップレベルの
/// `WHERE` が無い、または `TRUNCATE` / `DROP` で始まる文を拾う。コメント・文字列
/// リテラルはドライバ別にマスクしてから走査する。
pub fn classify_dangerous(driver: DriverKind, sql: &str) -> Option<DangerKind> {
    let chars: Vec<char> = sql.chars().collect();
    let masked: String = mask_for_driver(driver, &chars).into_iter().collect();
    let lower = masked.to_lowercase();
    // 先頭の空白と `(` を読み飛ばす。Rust の `is_whitespace` は U+0085 を含み U+FEFF を含まないが、
    // JS の `\s` は逆なので、両方を明示してフロントと判定を揃える (共有ゴールデンで固定)。
    let body = lower.trim_start_matches(|c: char| {
        c.is_whitespace() || c == '(' || c == '\u{FEFF}' || c == '\u{0085}'
    });
    if body.is_empty() {
        return None;
    }
    if keyword_prefix(body, "delete") {
        return (!has_top_level_where(body)).then_some(DangerKind::DeleteNoWhere);
    }
    if keyword_prefix(body, "update") {
        return (!has_top_level_where(body)).then_some(DangerKind::UpdateNoWhere);
    }
    if keyword_prefix(body, "truncate") {
        return Some(DangerKind::Truncate);
    }
    if keyword_prefix(body, "drop") {
        return Some(DangerKind::Drop);
    }
    if keyword_prefix(body, "alter") {
        return alter_drop_kind(body);
    }
    None
}

/// `ALTER TABLE` の中の `DROP COLUMN` / `DROP CONSTRAINT` (MySQL の `DROP FOREIGN KEY` /
/// `DROP PRIMARY KEY` / `DROP CHECK` を含む) と、COLUMN 省略形の `DROP <列>` を拾う (#1626, #1839)。
/// `lower` はコメント・リテラルがマスク済みの小文字文字列。ASCII の単語 (`[a-z0-9_]+`) と引用
/// 識別子の開き記号に分けて、`DROP` とその次のトークン (`IF EXISTS` は読み飛ばす) を見る。次が
/// `column` なら列、`constraint` / `foreign` / `primary` / `check` なら制約、`index` / `key` /
/// `partition` など列以外の DROP 句の語なら対象外、それ以外 (任意の識別子・引用符) は省略形の
/// 列削除とする。先に現れた方を返す。限界: 未引用の列名が除外語と同じ (PostgreSQL の非予約語
/// `identity` / `key` など) だと見逃す。非 ASCII だけの未引用列名 (`DROP 顧客`) も語にならず見逃す。
/// 逆に `RENAME COLUMN drop TO d` のような `drop` 語の後ろの識別子は列削除と誤検出する (安全側)。
/// フロントの `alterDropKind` (`src/dangerousSql.ts`) と同じ規則で、共有ゴールデンで固定している。
fn alter_drop_kind(lower: &str) -> Option<DangerKind> {
    // 語 (`[a-z0-9_]+`) と引用識別子の開き記号 (中身はマスク済みで空白) を 1 トークンずつ取る。
    let b = lower.as_bytes();
    let mut words: Vec<&str> = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i].is_ascii_alphanumeric() || b[i] == b'_' {
            let start = i;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
                i += 1;
            }
            words.push(&lower[start..i]);
        } else {
            if matches!(b[i], b'`' | b'"' | b'[') {
                words.push(&lower[i..=i]);
            }
            i += 1;
        }
    }
    if words.first() != Some(&"alter") || words.get(1) != Some(&"table") {
        return None;
    }
    for i in 2..words.len().saturating_sub(1) {
        if words[i] != "drop" {
            continue;
        }
        let mut j = i + 1;
        // `DROP IF EXISTS <列>` (MariaDB) の IF EXISTS を読み飛ばす。
        if words.get(j) == Some(&"if") && words.get(j + 1) == Some(&"exists") && j + 2 < words.len()
        {
            j += 2;
        }
        match words[j] {
            "column" => return Some(DangerKind::DropColumn),
            "constraint" | "foreign" | "primary" | "check" => {
                return Some(DangerKind::DropConstraint)
            }
            // 列以外の DROP 句 / 列属性の解除。フロントの `ALTER_DROP_NON_COLUMN` と同じ。
            "index" | "key" | "partition" | "default" | "not" | "expression" | "identity"
            | "system" | "period" | "if" => {}
            // COLUMN 省略形 (`DROP c` / ``DROP `c` `` / `DROP "c"`) は列の削除 (#1839)。
            _ => return Some(DangerKind::DropColumn),
        }
    }
    None
}

/// `body` が `kw` で始まり直後が単語境界 (JS の `^kw\b`) なら true。
fn keyword_prefix(body: &str, kw: &str) -> bool {
    body.starts_with(kw)
        && body
            .as_bytes()
            .get(kw.len())
            .map_or(true, |c| !is_word_byte(*c))
}

/// 括弧の深さ 0 に `WHERE` があるか。サブクエリ内の `WHERE` を文自身のガードと
/// 取り違えない。`lower` はコメント・リテラルがマスク済みの小文字文字列。
fn has_top_level_where(lower: &str) -> bool {
    let b = lower.as_bytes();
    let mut depth = 0usize;
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'(' => depth += 1,
            b')' => depth = depth.saturating_sub(1),
            b'w' if depth == 0 && b[i..].starts_with(b"where") => {
                let before_ok = i == 0 || !is_word_byte(b[i - 1]);
                let after_ok = b.get(i + 5).map_or(true, |c| !is_word_byte(*c));
                if before_ok && after_ok {
                    return true;
                }
            }
            _ => {}
        }
        i += 1;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::script::split_script;

    const D: DriverKind = DriverKind::Mysql;

    #[test]
    fn classifies_dangerous_statements() {
        assert_eq!(
            classify_dangerous(D, "DELETE FROM t"),
            Some(DangerKind::DeleteNoWhere)
        );
        assert_eq!(classify_dangerous(D, "DELETE FROM t WHERE id = 1"), None);
        assert_eq!(
            classify_dangerous(D, "update t set a = (select 1 where true)"),
            Some(DangerKind::UpdateNoWhere)
        );
        assert_eq!(
            classify_dangerous(D, "UPDATE t SET a = 'where'"),
            Some(DangerKind::UpdateNoWhere)
        );
        assert_eq!(
            classify_dangerous(D, "TRUNCATE TABLE t"),
            Some(DangerKind::Truncate)
        );
        assert_eq!(
            classify_dangerous(D, "drop table t"),
            Some(DangerKind::Drop)
        );
        assert_eq!(classify_dangerous(D, "SELECT * FROM t"), None);
        assert_eq!(classify_dangerous(D, "dropdown"), None);
        assert_eq!(classify_dangerous(D, ""), None);
    }

    fn analyze(sql: &str, enforce_read_only: bool) -> ScriptAnalysis {
        let mut a = ScriptAnalyzer::new(DriverKind::Sqlite, enforce_read_only);
        for s in split_script(DriverKind::Sqlite, sql) {
            a.push(&s);
        }
        a.finish()
    }

    #[test]
    fn counts_categories_and_positions() {
        let a = analyze(
            "BEGIN;\nCREATE TABLE t (id INT);\nINSERT INTO t VALUES (1);\nSELECT * FROM t;\nDELETE FROM t;\nDROP TABLE t;\nCOMMIT;",
            false,
        );
        assert_eq!(a.total_statements, 7);
        assert_eq!(a.categories.tx_control, 2);
        assert_eq!(a.categories.ddl, 2);
        assert_eq!(a.categories.read, 1);
        assert_eq!(a.categories.write, 2);
        assert_eq!(a.dangerous_total, 2);
        assert_eq!(a.danger_counts.delete_no_where, 1);
        assert_eq!(a.danger_counts.drop, 1);
        assert_eq!(a.dangerous.len(), 2);
        assert_eq!(a.dangerous[0].index, 5);
        assert_eq!(a.dangerous[0].line, 5);
        assert_eq!(a.dangerous[1].index, 6);
        assert_eq!(a.tx_control_total, 2);
        assert!(!a.unclosed_transaction);
        assert_eq!(
            a.tx_controls
                .iter()
                .map(|m| (m.index, m.kind))
                .collect::<Vec<_>>(),
            vec![(1, "begin"), (7, "commit")]
        );
        assert_eq!(a.blocked_total, 0);
        assert_eq!(a.head.len(), 7);
    }

    #[test]
    fn detects_unclosed_transaction_1601() {
        assert!(analyze("BEGIN; UPDATE t SET a = 1 WHERE id = 1;", false).unclosed_transaction);
        assert!(
            !analyze("BEGIN; UPDATE t SET a = 1 WHERE id = 1; COMMIT;", false).unclosed_transaction
        );
        assert!(
            !analyze("BEGIN; DELETE FROM t WHERE id = 1; ROLLBACK;", false).unclosed_transaction
        );
        assert!(analyze("BEGIN; COMMIT; BEGIN; SELECT 1;", false).unclosed_transaction);
        assert!(!analyze("SELECT 1;", false).unclosed_transaction);
    }

    #[test]
    fn unparsable_begin_is_not_counted_as_tx_control_1601() {
        // 解釈できないモード語の開始文は実行時にエラーで止まる。正常な制御文として数えない。
        let a = analyze("BEGIN ISOLATION LEVEL FOO;", false);
        assert_eq!(a.categories.tx_control, 0);
        assert_eq!(a.tx_control_total, 0);
        let ok = analyze("BEGIN ISOLATION LEVEL SERIALIZABLE;", false);
        assert_eq!(ok.categories.tx_control, 1);
    }

    #[test]
    fn read_only_session_counts_blocked_statements() {
        let a = analyze(
            "SELECT 1;\nINSERT INTO t VALUES (1);\nUPDATE t SET a = 1;",
            true,
        );
        assert_eq!(a.blocked_total, 2);
        assert!(!a.head[0].blocked);
        assert!(a.head[1].blocked);
        assert!(a.head[2].blocked);
    }

    #[test]
    fn keeps_only_bounded_lists_for_huge_scripts() {
        let mut sql = String::new();
        for i in 0..(HEAD_LIMIT + 500) {
            sql.push_str(&format!("INSERT INTO t VALUES ({i});\n"));
        }
        for _ in 0..(LIST_LIMIT + 50) {
            sql.push_str("DELETE FROM t;\n");
        }
        let a = analyze(&sql, false);
        assert_eq!(
            a.total_statements as usize,
            HEAD_LIMIT + 500 + LIST_LIMIT + 50
        );
        assert_eq!(a.head.len(), HEAD_LIMIT);
        assert_eq!(a.dangerous.len(), LIST_LIMIT);
        assert_eq!(a.dangerous_total as usize, LIST_LIMIT + 50);
        // 危険文の index は head の外でも正しい通し番号。
        assert_eq!(a.dangerous[0].index as usize, HEAD_LIMIT + 500 + 1);
    }

    #[test]
    fn preview_skips_leading_line_comments() {
        assert_eq!(
            preview("-- Table structure for table t\n-- more\nCREATE TABLE t (id int)"),
            "CREATE TABLE t (id int)"
        );
        // コメントだけなら潰して見せる。
        assert_eq!(preview("-- only a comment"), "-- only a comment");
        assert_eq!(preview("-- c\n"), "-- c");
        // 文中の -- は触らない。
        assert_eq!(preview("SELECT 1 -- x\n, 2"), "SELECT 1 -- x , 2");
    }

    #[test]
    fn long_statements_are_previewed() {
        let a = analyze(
            &format!("INSERT INTO t VALUES ('{}');", "x".repeat(1000)),
            false,
        );
        assert!(a.head[0].sql.chars().count() <= PREVIEW_CHARS + 1);
        assert!(a.head[0].sql.ends_with('…'));
    }

    #[test]
    fn classifies_alter_table_drops() {
        for (driver, sql, want) in [
            (
                D,
                "ALTER TABLE t DROP COLUMN c",
                Some(DangerKind::DropColumn),
            ),
            (
                D,
                "alter table `t` drop column if exists `c`",
                Some(DangerKind::DropColumn),
            ),
            (
                D,
                "ALTER TABLE t DROP CONSTRAINT fk",
                Some(DangerKind::DropConstraint),
            ),
            (
                D,
                "ALTER TABLE t DROP FOREIGN KEY fk",
                Some(DangerKind::DropConstraint),
            ),
            (
                D,
                "ALTER TABLE t DROP PRIMARY KEY",
                Some(DangerKind::DropConstraint),
            ),
            (
                D,
                "ALTER TABLE t DROP CHECK ck",
                Some(DangerKind::DropConstraint),
            ),
            (
                DriverKind::Postgres,
                "ALTER TABLE ONLY s.t DROP COLUMN c CASCADE",
                Some(DangerKind::DropColumn),
            ),
            (
                D,
                "ALTER TABLE t ADD COLUMN c INT, DROP COLUMN d",
                Some(DangerKind::DropColumn),
            ),
            (D, "ALTER TABLE t DROP INDEX i", None),
            (D, "ALTER TABLE t ADD COLUMN c INT", None),
            (D, "ALTER TABLE t ADD COLUMN `drop` INT", None),
            (D, "ALTER TABLE t COMMENT 'drop column'", None),
            (D, "ALTER INDEX i RENAME TO j", None),
        ] {
            assert_eq!(classify_dangerous(driver, sql), want, "{sql}");
        }
    }

    #[test]
    fn insert_target_reads_table_names() {
        let name = |sql: &str| insert_target(sql).map(|(n, _)| n);
        assert_eq!(name("INSERT INTO t VALUES (1)").as_deref(), Some("t"));
        assert_eq!(
            name("insert into `db`.`my t` (a) values (1)").as_deref(),
            Some("db.my t")
        );
        assert_eq!(
            name("INSERT IGNORE INTO \"s\".t VALUES (1)").as_deref(),
            Some("s.t")
        );
        assert_eq!(
            name("INSERT OR REPLACE INTO t VALUES (1)").as_deref(),
            Some("t")
        );
        assert_eq!(name("INSERT t VALUES (1)").as_deref(), Some("t"));
        assert_eq!(name("INSERT INTO"), None);
    }

    #[test]
    fn counts_value_tuples_ignoring_quotes_and_upsert_tail() {
        let rows = |sql: &str, mysql: bool| {
            let (_, rest) = insert_target(sql).expect("target");
            count_values_tuples(rest, mysql)
        };
        assert_eq!(
            rows("INSERT INTO t VALUES (1,'a'),(2,'b'),(3,'c')", false),
            3
        );
        assert_eq!(
            rows("INSERT INTO t (a, b) VALUES (1,'),('),(2,'x')", false),
            2
        );
        assert_eq!(rows("INSERT INTO t VALUES (1,'it\\'s ('),(2,'x')", true), 2);
        assert_eq!(
            rows(
                "INSERT INTO t VALUES (1,2) ON DUPLICATE KEY UPDATE a = VALUES(a)",
                true
            ),
            1
        );
        assert_eq!(rows("INSERT INTO t SELECT * FROM u", false), 0);
        assert_eq!(rows("INSERT INTO t (a) SELECT (1)", false), 0);
    }

    #[test]
    fn aggregates_inserts_per_table() {
        let a = analyze(
            "INSERT INTO a VALUES (1),(2);\nINSERT INTO b VALUES (1);\nINSERT INTO a VALUES (3);\nINSERT INTO c SELECT 1;",
            false,
        );
        let got: Vec<(&str, u64, u64)> = a
            .insert_tables
            .iter()
            .map(|t| (t.table.as_str(), t.statements, t.rows))
            .collect();
        assert_eq!(got, vec![("a", 2, 3), ("b", 1, 1), ("c", 1, 0)]);
        assert_eq!(a.insert_tables_overflow, 0);
    }

    #[test]
    fn insert_table_aggregation_is_capped() {
        let mut sql = String::new();
        for i in 0..(INSERT_TABLE_LIMIT + 5) {
            sql.push_str(&format!("INSERT INTO t{i} VALUES (1);\n"));
        }
        let a = analyze(&sql, false);
        assert_eq!(a.insert_tables.len(), INSERT_TABLE_LIMIT);
        assert_eq!(a.insert_tables_overflow, 5);
    }
}
