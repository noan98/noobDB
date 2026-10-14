//! `.sql` スクリプトの**事前確認 (ドライラン)** の集計 (#1535)。
//!
//! 大きなダンプは GB 級になりうるので、全文をメモリに載せない。[`ScriptSplitter`]
//! (`db::script`) が確定した文を 1 文ずつ [`ScriptAnalyzer::push`] へ渡し、ここでは
//! 次の**有限個の情報だけ**を保持する。
//!
//! * 文の総数・種別ごとの件数 (読み取り / 書き込み / DDL / トランザクション制御)
//! * 先頭 [`HEAD_LIMIT`] 文の一覧 (プレビュー用。個別除外のチェックボックスの対象)
//! * 危険な文 (WHERE なしの DELETE / UPDATE、DROP、TRUNCATE) の件数と、先頭
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

use serde::Serialize;

use super::script::{classify_tx_statement, ScriptStatement, TxControl};
use super::{is_read_only_sql_for, mask_for_driver, sql_may_change_schema, DriverKind};

/// 先頭から一覧に保持する文の数 (個別除外の対象になる範囲)。
pub const HEAD_LIMIT: usize = 300;
/// 危険文・トランザクション制御文の一覧に保持する最大件数。
pub const LIST_LIMIT: usize = 200;
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
    /// EOF でランナーが黙って COMMIT するため、実行前に知らせる。
    pub unclosed_transaction: bool,
    pub head: Vec<AnalyzedStatement>,
    pub dangerous: Vec<AnalyzedStatement>,
    pub tx_controls: Vec<TxControlMark>,
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
}

impl ScriptAnalyzer {
    pub fn new(driver: DriverKind, enforce_read_only: bool) -> Self {
        Self {
            driver,
            enforce_read_only,
            seen: 0,
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

    pub fn finish(self) -> ScriptAnalysis {
        self.out
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
}
