//! 実行計画の「このインデックスが無かったら / あったら」の試算 (#2326)。
//!
//! 本番の構造を変えずに、インデックスを無効化した場合・追加した場合の EXPLAIN を取り、今の計画と
//! 並べて比べられるようにする。**実 DB に残る変更 (インデックスの実作成・恒久的な削除) は一切しない**。
//! ドライバごとに安全に試算できる方法が違うため、できない組み合わせは理由つきで無効にする
//! ([`compute_support`])。
//!
//! | ドライバ | 無効化 (`Disable`) | 追加 (`Add`) |
//! |---|---|---|
//! | PostgreSQL (hypopg あり) | `hypopg_hide_index` (関数がある場合。セッション内のみ) | `hypopg_create_index` (仮想インデックス) |
//! | PostgreSQL (hypopg なし) | `BEGIN; SET LOCAL lock_timeout; DROP INDEX; EXPLAIN; ROLLBACK` (**ACCESS EXCLUSIVE ロックを取る**。確認必須・read_only 不可) | 非対応 (実体を作ってしまうため) |
//! | MySQL | 対象クエリの表参照に `IGNORE INDEX (idx)` を差し込んで EXPLAIN (`ALTER INDEX ... INVISIBLE` は他セッションにも効くので使わない) | 非対応 (仮想インデックスが無く、DDL はロールバックできない) |
//! | SQLite | `BEGIN; DROP INDEX; EXPLAIN QUERY PLAN; ROLLBACK` (read_only 不可) | `BEGIN; CREATE INDEX; EXPLAIN QUERY PLAN; ROLLBACK` (read_only 不可・大きな表は構築に時間がかかる) |
//!
//! MySQL の無効化に `/*+ NO_INDEX(...) */` ではなく `IGNORE INDEX` を使うのは、(1) MariaDB は
//! オプティマイザヒントを持たず黙って無視する、(2) NO_INDEX は問い合わせブロックごとの指定が要り
//! サブクエリ内の同じ表に効かない、(3) 8.0.20 未満でも同じコードで動く、ため。どちらも対象の表参照
//! (エイリアスを含む) を字句で見つける処理が要るので ([`mysql_ignore_index_sql`])、構文の単純な方を選んだ。
//!
//! 比較は「同じ接続・同じ統計」で before / after を連続して取る (今の計画だけ別の時刻に取ると、統計の
//! 更新やキャッシュの差が「インデックスの効果」に混ざる)。どちらも `ANALYZE` なしの推定 EXPLAIN で、
//! 試算の対象 SQL は実行されない。

use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::{Connection, DriverKind, QueryResult};
use crate::error::{AppError, Result};

/// 試算の全体にかける時間の上限。SQLite の `CREATE INDEX` は表の大きさに比例するため、これを超えたら
/// 中断する (future の drop で接続ごと閉じ、未コミットの変更は残らない)。
pub const WHATIF_TIMEOUT_SECS: u64 = 60;
/// PostgreSQL の DDL 経路で `SET LOCAL lock_timeout` に使う既定値 (秒)。
pub const DEFAULT_LOCK_TIMEOUT_SECS: u64 = 3;
/// `lock_timeout` の上限 (秒)。長く待つほど、後ろのクエリを巻き込んで止める時間が伸びる。
pub const MAX_LOCK_TIMEOUT_SECS: u64 = 30;
/// 追加する試算インデックスの列数の上限。
pub const MAX_WHATIF_COLUMNS: usize = 16;
/// SQLite の試算で一時的に作るインデックス名の接頭辞 (ROLLBACK で消える。名前の衝突を避けるため
/// 実際の名前には現在時刻のナノ秒を付ける)。
pub(crate) const SQLITE_TEMP_INDEX_PREFIX: &str = "noobdb_whatif_idx";

/// 試算の種類。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IndexWhatIfAction {
    /// 既存のインデックスが無かったらどうなるか。
    Disable,
    /// この列構成のインデックスがあったらどうなるか。
    Add,
}

/// 試算の方法。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IndexWhatIfMethod {
    /// PostgreSQL の hypopg 拡張 (仮想インデックス / インデックスの非表示)。実体を作らない。
    Hypopg,
    /// MySQL: 対象の表参照へ `IGNORE INDEX` を差し込む。DB には何も書かない。
    IgnoreIndex,
    /// `BEGIN; DDL; EXPLAIN; ROLLBACK`。短時間だがロックを取る (PostgreSQL は ACCESS EXCLUSIVE、
    /// SQLite はデータベース全体の書き込みロック)。
    RollbackDdl,
}

/// 試算できない理由 (フロントが文言に変換する)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IndexWhatIfUnavailable {
    /// 読み取り専用の接続では DDL を使う経路を取れない。
    ReadOnly,
    /// PostgreSQL で hypopg が無い (導入すれば試算できる)。
    NeedsHypopg,
    /// 仮想インデックスの仕組みが無く、DDL もロールバックできない (MySQL の「追加」)。
    NoVirtualIndex,
}

/// 試算の種類ごとの可否。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexWhatIfModeSupport {
    /// 使う方法。試算できないときは `None`。
    pub method: Option<IndexWhatIfMethod>,
    /// 試算できない理由。できるときは `None`。
    pub unavailable: Option<IndexWhatIfUnavailable>,
    /// 実行中に表 (SQLite はデータベース) への書き込み / 読み取りを止めるロックを取るか。
    /// 真なら確認の上で `confirm_locking` を立てないとバックエンドが実行しない。
    pub locks_table: bool,
    /// 実際にインデックスを (ロールバック前提で) 構築するか。大きな表では時間がかかる。
    pub builds_index: bool,
}

impl IndexWhatIfModeSupport {
    fn ok(method: IndexWhatIfMethod, locks_table: bool, builds_index: bool) -> Self {
        Self {
            method: Some(method),
            unavailable: None,
            locks_table,
            builds_index,
        }
    }

    fn no(reason: IndexWhatIfUnavailable) -> Self {
        Self {
            method: None,
            unavailable: Some(reason),
            locks_table: false,
            builds_index: false,
        }
    }
}

/// この接続で使える試算の一覧。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexWhatIfSupport {
    /// PostgreSQL の hypopg 拡張のバージョン。入っていない / PostgreSQL 以外は `None`。
    pub hypopg_version: Option<String>,
    pub disable: IndexWhatIfModeSupport,
    pub add: IndexWhatIfModeSupport,
}

/// 接続先の hypopg 拡張の情報。関数は**拡張が入っているスキーマ**を付けて呼ぶ (`search_path` は
/// 対象テーブルのスキーマだけにしてあり、hypopg を別スキーマ (public など) に入れていると
/// 修飾なしでは見えない)。インデックスの非表示 (`hypopg_hide_index` / `hypopg_unhide_all_indexes`)
/// は版によって有無が違うため、バージョンの比較ではなく関数の存在を直接調べた結果を持つ。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HypopgCaps {
    pub version: String,
    /// 拡張のスキーマ (`pg_extension.extnamespace`)。
    pub schema: String,
    /// `hypopg_hide_index(oid)` と `hypopg_unhide_all_indexes()` の両方がある。
    pub can_hide: bool,
}

/// ドライバ・`read_only`・hypopg の有無と機能から、試算の可否と方法を決める純関数。
pub fn compute_support(
    driver: DriverKind,
    read_only: bool,
    hypopg: Option<&HypopgCaps>,
) -> IndexWhatIfSupport {
    let ddl = |locks: bool, builds: bool| {
        if read_only {
            IndexWhatIfModeSupport::no(IndexWhatIfUnavailable::ReadOnly)
        } else {
            IndexWhatIfModeSupport::ok(IndexWhatIfMethod::RollbackDdl, locks, builds)
        }
    };
    let (disable, add) = match driver {
        DriverKind::Mysql => (
            IndexWhatIfModeSupport::ok(IndexWhatIfMethod::IgnoreIndex, false, false),
            IndexWhatIfModeSupport::no(IndexWhatIfUnavailable::NoVirtualIndex),
        ),
        DriverKind::Postgres => match hypopg {
            Some(h) => (
                if h.can_hide {
                    IndexWhatIfModeSupport::ok(IndexWhatIfMethod::Hypopg, false, false)
                } else {
                    // 非表示の関数が無い版は DDL 経路へ縮退する。
                    ddl(true, false)
                },
                IndexWhatIfModeSupport::ok(IndexWhatIfMethod::Hypopg, false, false),
            ),
            None => (
                ddl(true, false),
                IndexWhatIfModeSupport::no(IndexWhatIfUnavailable::NeedsHypopg),
            ),
        },
        DriverKind::Sqlite => (ddl(true, false), ddl(true, true)),
    };
    IndexWhatIfSupport {
        hypopg_version: hypopg.map(|h| h.version.clone()),
        disable,
        add,
    }
}

/// 試算の依頼 (IPC の引数)。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexWhatIfRequest {
    /// PostgreSQL ではスキーマ、MySQL ではデータベース。SQLite は `main` のみ対応。
    pub database: Option<String>,
    pub table: String,
    /// 試算の対象の SQL (EXPLAIN を付けない読み取り専用の文)。
    pub sql: String,
    pub action: IndexWhatIfAction,
    /// `Disable` で無効化するインデックス名。
    #[serde(default)]
    pub index: Option<String>,
    /// `Add` で追加するインデックスの列 (キーの順)。
    #[serde(default)]
    pub columns: Vec<String>,
    /// ロックを取る経路 (`locks_table`) を実行してよいという利用者の確認。
    #[serde(default)]
    pub confirm_locking: bool,
    /// PostgreSQL の DDL 経路の `lock_timeout` (秒)。未指定は既定値。
    #[serde(default)]
    pub lock_timeout_secs: Option<u64>,
}

/// 試算の結果。before / after はどちらも ANALYZE なしの推定 EXPLAIN。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexWhatIfOutcome {
    pub before: QueryResult,
    pub after: QueryResult,
    pub method: IndexWhatIfMethod,
    /// 試算のために実行した文 (EXPLAIN は除く)。何をしたかを利用者が確認できるようにする。
    pub statements: Vec<String>,
    /// MySQL の `IGNORE INDEX`: 差し込めた表参照の数。`refs_mentioned` より少ないと、一部の参照
    /// (別名の付け方が特殊など) には効いていない可能性がある。MySQL 以外は `None`。
    pub refs_applied: Option<u32>,
    /// MySQL: SQL 中で表名に当たる語の数 (コメント・文字列を除く)。
    pub refs_mentioned: Option<u32>,
    pub elapsed_ms: u64,
}

/// ドライバ層へ渡す、検証済みの試算の指示。
pub(crate) struct WhatIfPlan<'a> {
    pub database: Option<&'a str>,
    pub table: &'a str,
    /// EXPLAIN 前置きを付けた元の SQL。
    pub explain_before: String,
    pub sql: &'a str,
    pub action: IndexWhatIfAction,
    pub index: Option<&'a str>,
    pub columns: &'a [String],
    pub method: IndexWhatIfMethod,
    /// hypopg の情報 (PostgreSQL・hypopg 経路のみ)。
    pub hypopg: Option<&'a HypopgCaps>,
    pub lock_timeout_ms: u64,
}

/// ドライバ層が返す生の結果。
pub(crate) struct WhatIfRaw {
    pub before: QueryResult,
    pub after: QueryResult,
    pub statements: Vec<String>,
    /// MySQL: `IGNORE INDEX` を差し込んだ表参照の数と、SQL 中で表名に当たる語の数。
    pub refs: Option<(u32, u32)>,
}

/// 方言ごとの EXPLAIN 前置き。フロントの `bundleExplainPrefix` (EXPLAIN タブの既定) と同じ形式にして、
/// 計画のパーサをそのまま使えるようにする。
pub(crate) fn explain_prefix(driver: DriverKind) -> &'static str {
    match driver {
        DriverKind::Postgres => "EXPLAIN (FORMAT JSON) ",
        DriverKind::Sqlite => "EXPLAIN QUERY PLAN ",
        DriverKind::Mysql => "EXPLAIN FORMAT=JSON ",
    }
}

/// 試算の対象 SQL を検証して、末尾の `;` と空白を落とした文を返す。読み取り専用の 1 文で、
/// それ自体が EXPLAIN でないこと。
pub(crate) fn validate_target_sql(driver: DriverKind, sql: &str) -> Result<String> {
    let trimmed = sql.trim().trim_end_matches(';').trim_end();
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput("what-if: SQL is empty".into()));
    }
    if !super::is_read_only_sql_for(driver, trimmed)
        || super::has_stacked_statements_for(driver, trimmed)
    {
        return Err(AppError::ReadOnly(
            "what-if: only a single read-only SELECT statement can be analyzed".into(),
        ));
    }
    let flavor = super::sql_flavor_of(driver);
    let head = super::strip_sql_comments(trimmed, flavor)
        .trim_start()
        .to_ascii_lowercase();
    let first = head
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .next()
        .unwrap_or("");
    let ok = head.starts_with('(') || matches!(first, "select" | "with" | "table" | "values");
    if !ok {
        return Err(AppError::InvalidInput(
            "what-if: give the SELECT statement itself (without EXPLAIN)".into(),
        ));
    }
    Ok(trimmed.to_string())
}

/// 試算の指示の検証 (対象のインデックス・列)。`indexes` は対象表の既存インデックス。
pub(crate) fn validate_action(
    request: &IndexWhatIfRequest,
    indexes: &[super::types::IndexInfo],
) -> Result<()> {
    if request.table.trim().is_empty() {
        return Err(AppError::InvalidInput("what-if: table is empty".into()));
    }
    match request.action {
        IndexWhatIfAction::Disable => {
            let name = request.index.as_deref().unwrap_or("");
            let Some(found) = indexes.iter().find(|i| i.name == name) else {
                return Err(AppError::InvalidInput(format!(
                    "what-if: index not found on the table: {name}"
                )));
            };
            if found.primary {
                return Err(AppError::InvalidInput(
                    "what-if: the primary key index cannot be disabled".into(),
                ));
            }
        }
        IndexWhatIfAction::Add => {
            let cols = &request.columns;
            if cols.is_empty() || cols.len() > MAX_WHATIF_COLUMNS {
                return Err(AppError::InvalidInput(format!(
                    "what-if: specify 1 to {MAX_WHATIF_COLUMNS} columns"
                )));
            }
            if cols.iter().any(|c| c.trim().is_empty()) {
                return Err(AppError::InvalidInput(
                    "what-if: column name is empty".into(),
                ));
            }
            let mut seen = std::collections::HashSet::new();
            if !cols.iter().all(|c| seen.insert(c.to_ascii_lowercase())) {
                return Err(AppError::InvalidInput(
                    "what-if: duplicate column in the index".into(),
                ));
            }
        }
    }
    Ok(())
}

impl Connection {
    /// PostgreSQL の hypopg 拡張の情報 (入っていなければ `None`)。他ドライバは常に `None`。
    pub async fn index_whatif_hypopg(&self) -> Result<Option<HypopgCaps>> {
        match self {
            Connection::Postgres(c) => c.hypopg_caps().await,
            Connection::MySql(_) | Connection::Sqlite(_) => Ok(None),
        }
    }

    /// 検証済みの試算を実行する。呼び出し側が [`compute_support`] で方法を決め、ロックの確認と
    /// `read_only` の拒否を済ませている前提。
    pub(crate) async fn index_whatif_run(&self, plan: &WhatIfPlan<'_>) -> Result<WhatIfRaw> {
        match self {
            Connection::Postgres(c) => c.index_whatif(plan).await,
            Connection::Sqlite(c) => c.index_whatif(plan).await,
            Connection::MySql(_) => self.mysql_index_whatif(plan).await,
        }
    }

    /// MySQL: 元の計画と、対象の表参照へ `IGNORE INDEX` を差し込んだ計画を取る。DB には何も書かず、
    /// サーバ側も読み取り専用で包む (`read_only_scope`)。
    async fn mysql_index_whatif(&self, plan: &WhatIfPlan<'_>) -> Result<WhatIfRaw> {
        if plan.method != IndexWhatIfMethod::IgnoreIndex
            || plan.action != IndexWhatIfAction::Disable
        {
            return Err(AppError::InvalidInput(
                "what-if: unsupported on MySQL".into(),
            ));
        }
        let Some(index) = plan.index else {
            return Err(AppError::InvalidInput("what-if: index is required".into()));
        };
        let Some((rewritten, applied, mentioned)) =
            mysql_ignore_index_sql(plan.sql, plan.database, plan.table, index)
        else {
            return Err(AppError::InvalidInput(format!(
                "what-if: table {} is not referenced in the SQL",
                plan.table
            )));
        };
        let after_sql = format!("{}{}", explain_prefix(DriverKind::Mysql), rewritten);
        let database = plan.database;
        super::read_only_scope::scope(async {
            let before = self.execute(&plan.explain_before, database).await?;
            let after = self.execute(&after_sql, database).await?;
            Ok::<_, AppError>(WhatIfRaw {
                before,
                after,
                statements: vec![rewritten.clone()],
                refs: Some((applied as u32, mentioned as u32)),
            })
        })
        .await
    }
}

/// 試算全体のタイムアウト付き実行。タイムアウトで future を落とすと、ドライバ層が接続ごと閉じる。
pub(crate) async fn run_with_timeout(
    conn: &Connection,
    plan: &WhatIfPlan<'_>,
) -> Result<WhatIfRaw> {
    match tokio::time::timeout(
        Duration::from_secs(WHATIF_TIMEOUT_SECS),
        conn.index_whatif_run(plan),
    )
    .await
    {
        Ok(r) => r,
        Err(_) => Err(AppError::Timeout(WHATIF_TIMEOUT_SECS)),
    }
}

// ── MySQL: 表参照への IGNORE INDEX の差し込み ──

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    /// 引用なしの語 (識別子・キーワード・数値)。
    Word(String),
    /// バッククォートで引用した識別子 (中身)。
    Quoted(String),
    Punct(char),
    /// 文字列リテラル。
    Str,
}

#[derive(Debug, Clone)]
struct Token {
    tok: Tok,
    end: usize,
}

/// 字句に分ける。コメント (`/* */` `-- ` `#`) は捨て、文字列リテラルは 1 トークンにする。
fn tokenize_mysql(sql: &str) -> Vec<Token> {
    let chars: Vec<(usize, char)> = sql.char_indices().collect();
    let n = chars.len();
    let byte_end = |i: usize| chars.get(i).map_or(sql.len(), |c| c.0);
    let mut out = Vec::new();
    let mut i = 0;
    while i < n {
        let c = chars[i].1;
        if c.is_whitespace() {
            i += 1;
        } else if c == '/' && chars.get(i + 1).map(|x| x.1) == Some('*') {
            i += 2;
            while i < n && !(chars[i].1 == '*' && chars.get(i + 1).map(|x| x.1) == Some('/')) {
                i += 1;
            }
            i = (i + 2).min(n);
        } else if c == '#'
            || (c == '-'
                && chars.get(i + 1).map(|x| x.1) == Some('-')
                && chars.get(i + 2).map_or(true, |x| x.1.is_whitespace()))
        {
            while i < n && chars[i].1 != '\n' {
                i += 1;
            }
        } else if c == '\'' || c == '"' {
            let quote = c;
            i += 1;
            while i < n {
                if chars[i].1 == '\\' {
                    i += 2;
                } else if chars[i].1 == quote {
                    if chars.get(i + 1).map(|x| x.1) == Some(quote) {
                        i += 2;
                    } else {
                        i += 1;
                        break;
                    }
                } else {
                    i += 1;
                }
            }
            let i = i.min(n);
            out.push(Token {
                tok: Tok::Str,
                end: byte_end(i),
            });
        } else if c == '`' {
            i += 1;
            let mut name = String::new();
            while i < n {
                if chars[i].1 == '`' {
                    if chars.get(i + 1).map(|x| x.1) == Some('`') {
                        name.push('`');
                        i += 2;
                    } else {
                        i += 1;
                        break;
                    }
                } else {
                    name.push(chars[i].1);
                    i += 1;
                }
            }
            out.push(Token {
                tok: Tok::Quoted(name),
                end: byte_end(i),
            });
        } else if c.is_alphanumeric() || c == '_' || c == '$' || !c.is_ascii() {
            let start = i;
            while i < n
                && (chars[i].1.is_alphanumeric()
                    || chars[i].1 == '_'
                    || chars[i].1 == '$'
                    || !chars[i].1.is_ascii())
            {
                i += 1;
            }
            let word: String = chars[start..i].iter().map(|x| x.1).collect();
            out.push(Token {
                tok: Tok::Word(word),
                end: byte_end(i),
            });
        } else {
            i += 1;
            out.push(Token {
                tok: Tok::Punct(c),
                end: byte_end(i),
            });
        }
    }
    out
}

/// 表参照の直後で、エイリアスとして読んではいけない語。
const ALIAS_STOP: &[&str] = &[
    "join",
    "inner",
    "cross",
    "left",
    "right",
    "natural",
    "straight_join",
    "outer",
    "full",
    "on",
    "using",
    "where",
    "group",
    "having",
    "order",
    "limit",
    "union",
    "window",
    "use",
    "ignore",
    "force",
    "for",
    "lock",
    "into",
    "partition",
    "set",
    "except",
    "intersect",
    "procedure",
    "select",
    "values",
    "tablesample",
];

/// FROM 句を終える語 (以降のカンマは表の区切りではない)。
const FROM_END: &[&str] = &[
    "where",
    "group",
    "having",
    "order",
    "limit",
    "union",
    "window",
    "except",
    "intersect",
    "into",
    "for",
    "lock",
    "procedure",
    "select",
];

struct Frame {
    /// 問い合わせブロック (トップレベルかサブクエリ) か。関数呼び出しの括弧 (`EXTRACT(x FROM y)`)
    /// の FROM を表の始まりと取り違えないために区別する。
    query: bool,
    in_from: bool,
}

fn word_is(t: &Token, kw: &str) -> bool {
    matches!(&t.tok, Tok::Word(w) if w.eq_ignore_ascii_case(kw))
}

/// `toks[j]` から `[db.]table [PARTITION (...)] [[AS] alias]` を読み、末尾の位置と
/// (修飾, 表名) を返す。表参照でなければ `None`。
fn read_table_ref(toks: &[Token], j: usize) -> Option<(usize, Option<String>, String, usize)> {
    let name_of = |t: &Token| match &t.tok {
        Tok::Word(w) if !ALIAS_STOP.contains(&w.to_ascii_lowercase().as_str()) => Some(w.clone()),
        Tok::Quoted(q) => Some(q.clone()),
        _ => None,
    };
    let first = name_of(toks.get(j)?)?;
    let mut k = j + 1;
    let (qualifier, table) = if matches!(toks.get(k).map(|t| &t.tok), Some(Tok::Punct('.'))) {
        let second = name_of(toks.get(k + 1)?)?;
        k += 2;
        (Some(first), second)
    } else {
        (None, first)
    };
    // 関数呼び出し (`JSON_TABLE(...)` など) は表参照ではない。
    if matches!(toks.get(k).map(|t| &t.tok), Some(Tok::Punct('('))) {
        return None;
    }
    let mut end = toks[k - 1].end;
    if toks.get(k).is_some_and(|t| word_is(t, "partition"))
        && matches!(toks.get(k + 1).map(|t| &t.tok), Some(Tok::Punct('(')))
    {
        let mut depth = 0usize;
        let mut m = k + 1;
        while m < toks.len() {
            match toks[m].tok {
                Tok::Punct('(') => depth += 1,
                Tok::Punct(')') => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                _ => {}
            }
            m += 1;
        }
        k = (m + 1).min(toks.len());
        end = toks[k - 1].end;
    }
    let mut had_as = false;
    if toks.get(k).is_some_and(|t| word_is(t, "as")) {
        had_as = true;
        k += 1;
    }
    if let Some(t) = toks.get(k) {
        let alias = match &t.tok {
            Tok::Word(w) if had_as || !ALIAS_STOP.contains(&w.to_ascii_lowercase().as_str()) => {
                true
            }
            Tok::Quoted(_) => true,
            _ => false,
        };
        if alias {
            end = t.end;
            k += 1;
        }
    }
    Some((k, qualifier, table, end))
}

/// `sql` のうち、表 `table` を参照している**すべての**表参照 (サブクエリ・CTE の中を含む) の
/// 直後 (エイリアスの後) に ` IGNORE INDEX (<index>)` を差し込んだ SQL・差し込んだ件数・SQL 中で表名に当たる語の数を返す。
/// 表が 1 度も参照されていなければ `None`。表名は大文字小文字を区別せず、`db.table` の修飾が
/// `database` と違う参照は対象にしない。
pub(crate) fn mysql_ignore_index_sql(
    sql: &str,
    database: Option<&str>,
    table: &str,
    index: &str,
) -> Option<(String, usize, usize)> {
    let toks = tokenize_mysql(sql);
    // 表名に当たる語の数 (コメント・文字列は字句に分ける時点で除かれている)。
    let mentioned = toks
        .iter()
        .filter(|t| match &t.tok {
            Tok::Word(w) | Tok::Quoted(w) => w.eq_ignore_ascii_case(table),
            _ => false,
        })
        .count();
    let mut stack = vec![Frame {
        query: true,
        in_from: false,
    }];
    let mut inserts: Vec<usize> = Vec::new();
    let mut i = 0;
    let consider = |inserts: &mut Vec<usize>, r: &(usize, Option<String>, String, usize)| {
        let (_, qualifier, name, end) = r;
        let db_ok = match (qualifier, database.filter(|d| !d.is_empty())) {
            (Some(q), Some(d)) => q.eq_ignore_ascii_case(d),
            _ => true,
        };
        if db_ok && name.eq_ignore_ascii_case(table) {
            inserts.push(*end);
        }
    };
    while i < toks.len() {
        match &toks[i].tok {
            Tok::Punct('(') => {
                let query = toks.get(i + 1).is_some_and(|t| {
                    word_is(t, "select") || word_is(t, "with") || t.tok == Tok::Punct('(')
                });
                stack.push(Frame {
                    query,
                    in_from: false,
                });
                i += 1;
            }
            Tok::Punct(')') => {
                if stack.len() > 1 {
                    stack.pop();
                }
                i += 1;
            }
            Tok::Punct(',') => {
                i += 1;
                if stack.last().is_some_and(|f| f.query && f.in_from) {
                    if let Some(r) = read_table_ref(&toks, i) {
                        consider(&mut inserts, &r);
                        i = r.0;
                    }
                }
            }
            Tok::Word(w) => {
                let lw = w.to_ascii_lowercase();
                i += 1;
                let Some(frame) = stack.last_mut() else {
                    continue;
                };
                if !frame.query {
                    continue;
                }
                if lw == "from" || lw == "join" || lw == "straight_join" {
                    // `IS [NOT] DISTINCT FROM` の FROM は表の始まりではない。
                    if lw == "from" && i >= 2 && word_is(&toks[i - 2], "distinct") {
                        continue;
                    }
                    frame.in_from = true;
                    if let Some(r) = read_table_ref(&toks, i) {
                        consider(&mut inserts, &r);
                        i = r.0;
                    }
                } else if FROM_END.contains(&lw.as_str()) {
                    frame.in_from = false;
                }
            }
            _ => i += 1,
        }
    }
    if inserts.is_empty() {
        return None;
    }
    inserts.sort_unstable();
    inserts.dedup();
    let hint = format!(" IGNORE INDEX (`{}`)", index.replace('`', "``"));
    let mut out = sql.to_string();
    for at in inserts.iter().rev() {
        out.insert_str(*at, &hint);
    }
    Some((out, inserts.len(), mentioned))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rewrite(sql: &str, table: &str, index: &str) -> Option<String> {
        mysql_ignore_index_sql(sql, None, table, index).map(|r| r.0)
    }

    #[test]
    fn ignore_index_simple_and_alias() {
        assert_eq!(
            rewrite("SELECT * FROM users WHERE id = 1", "users", "idx_a").as_deref(),
            Some("SELECT * FROM users IGNORE INDEX (`idx_a`) WHERE id = 1")
        );
        assert_eq!(
            rewrite("SELECT * FROM users u WHERE u.id = 1", "users", "i").as_deref(),
            Some("SELECT * FROM users u IGNORE INDEX (`i`) WHERE u.id = 1")
        );
        assert_eq!(
            rewrite("SELECT * FROM `users` AS u", "USERS", "i").as_deref(),
            Some("SELECT * FROM `users` AS u IGNORE INDEX (`i`)")
        );
    }

    #[test]
    fn ignore_index_joins_commas_and_subqueries() {
        let got = rewrite(
            "SELECT * FROM orders o JOIN users u ON u.id = o.uid, items WHERE o.id IN (SELECT oid FROM users WHERE x = 1)",
            "users",
            "i",
        )
        .expect("rewritten");
        assert_eq!(got.matches("IGNORE INDEX").count(), 2);
        assert!(got.contains("JOIN users u IGNORE INDEX (`i`) ON u.id"));
        assert!(got.contains("FROM users IGNORE INDEX (`i`) WHERE x = 1)"));
        // カンマ区切りの 2 つ目の表参照も対象にできる。
        let got = rewrite("SELECT * FROM orders o, users u WHERE 1=1", "users", "i").expect("c");
        assert!(got.contains(", users u IGNORE INDEX (`i`) WHERE"));
    }

    #[test]
    fn ignore_index_skips_lookalikes() {
        // 文字列・コメント・関数の FROM・別の DB の同名表は対象にしない。
        assert_eq!(rewrite("SELECT 'FROM users' FROM t", "users", "i"), None);
        assert_eq!(
            rewrite("SELECT 1 /* FROM users */ FROM t", "users", "i"),
            None
        );
        assert_eq!(
            rewrite("SELECT EXTRACT(YEAR FROM users) FROM t", "users", "i"),
            None
        );
        assert_eq!(
            rewrite("SELECT a IS NOT DISTINCT FROM users FROM t", "users", "i"),
            None
        );
        assert_eq!(
            mysql_ignore_index_sql("SELECT * FROM other.users", Some("shop"), "users", "i"),
            None
        );
        assert!(
            mysql_ignore_index_sql("SELECT * FROM shop.users", Some("shop"), "users", "i")
                .is_some()
        );
        // 列名が表名と同じでも、SELECT リストや WHERE の識別子は表参照にならない。
        assert_eq!(
            rewrite("SELECT users FROM t WHERE users = 1", "users", "i"),
            None
        );
    }

    #[test]
    fn ignore_index_escapes_backticks_and_handles_group_by() {
        let got = rewrite(
            "SELECT a, b FROM users GROUP BY a, b ORDER BY a",
            "users",
            "we`ird",
        )
        .expect("g");
        assert_eq!(
            got,
            "SELECT a, b FROM users IGNORE INDEX (`we``ird`) GROUP BY a, b ORDER BY a"
        );
        // GROUP BY / ORDER BY のカンマの後ろの語を表と取り違えない。
        assert_eq!(
            rewrite("SELECT 1 FROM t GROUP BY a, users", "users", "i"),
            None
        );
        assert_eq!(rewrite("SELECT 1 FROM t LIMIT 1, 2", "users", "i"), None);
    }

    #[test]
    fn ignore_index_with_cte_and_partition() {
        let got = rewrite(
            "WITH x AS (SELECT * FROM users), y AS (SELECT 1) SELECT * FROM x JOIN y",
            "users",
            "i",
        )
        .expect("cte");
        assert!(got.contains("FROM users IGNORE INDEX (`i`))"));
        let got = rewrite("SELECT * FROM users PARTITION (p0) u WHERE 1", "users", "i").expect("p");
        assert!(got.contains("PARTITION (p0) u IGNORE INDEX (`i`) WHERE"));
    }

    fn caps(can_hide: bool) -> HypopgCaps {
        HypopgCaps {
            version: "1.4.1".into(),
            schema: "public".into(),
            can_hide,
        }
    }

    #[test]
    fn support_matrix() {
        use IndexWhatIfMethod::*;
        use IndexWhatIfUnavailable::*;
        let s = compute_support(DriverKind::Mysql, false, None);
        assert_eq!(s.disable.method, Some(IgnoreIndex));
        assert!(!s.disable.locks_table);
        assert_eq!(s.add.unavailable, Some(NoVirtualIndex));
        // MySQL の IGNORE INDEX は read_only でも使える (DB に何も書かない)。
        let s = compute_support(DriverKind::Mysql, true, None);
        assert_eq!(s.disable.method, Some(IgnoreIndex));

        let s = compute_support(DriverKind::Postgres, false, Some(&caps(true)));
        assert_eq!(s.disable.method, Some(Hypopg));
        assert_eq!(s.add.method, Some(Hypopg));
        let s = compute_support(DriverKind::Postgres, true, Some(&caps(true)));
        assert_eq!(s.disable.method, Some(Hypopg));
        assert_eq!(s.add.method, Some(Hypopg));
        // hide 系の関数が無い版は → DDL 経路 (ロックあり。read_only なら不可)。
        let s = compute_support(DriverKind::Postgres, false, Some(&caps(false)));
        assert_eq!(s.disable.method, Some(RollbackDdl));
        assert!(s.disable.locks_table);
        let s = compute_support(DriverKind::Postgres, true, Some(&caps(false)));
        assert_eq!(s.disable.unavailable, Some(ReadOnly));
        let s = compute_support(DriverKind::Postgres, false, None);
        assert_eq!(s.disable.method, Some(RollbackDdl));
        assert_eq!(s.add.unavailable, Some(NeedsHypopg));
        let s = compute_support(DriverKind::Postgres, true, None);
        assert_eq!(s.disable.unavailable, Some(ReadOnly));
        assert_eq!(s.add.unavailable, Some(NeedsHypopg));

        let s = compute_support(DriverKind::Sqlite, false, None);
        assert_eq!(s.disable.method, Some(RollbackDdl));
        assert_eq!(s.add.method, Some(RollbackDdl));
        assert!(s.add.builds_index);
        let s = compute_support(DriverKind::Sqlite, true, None);
        assert_eq!(s.disable.unavailable, Some(ReadOnly));
        assert_eq!(s.add.unavailable, Some(ReadOnly));
    }

    #[test]
    fn mentions_count_flags_unmatched_references() {
        // 表名が 3 回出るが、表参照は 1 つだけ (列名・別の修飾子)。差し込み件数 < 言及数になる。
        let (_, applied, mentioned) = mysql_ignore_index_sql(
            "SELECT users.id FROM users WHERE users.id = 1",
            None,
            "users",
            "i",
        )
        .expect("rewritten");
        assert_eq!((applied, mentioned), (1, 3));
    }

    #[test]
    fn target_sql_validation() {
        let pg = DriverKind::Postgres;
        assert_eq!(
            validate_target_sql(pg, "  SELECT 1;  ").as_deref().ok(),
            Some("SELECT 1")
        );
        assert!(validate_target_sql(pg, "/* c */ WITH a AS (SELECT 1) SELECT * FROM a").is_ok());
        assert!(validate_target_sql(pg, "").is_err());
        assert!(validate_target_sql(pg, "DELETE FROM t").is_err());
        assert!(validate_target_sql(pg, "SELECT 1; DROP TABLE t").is_err());
        assert!(validate_target_sql(pg, "EXPLAIN SELECT 1").is_err());
        assert!(validate_target_sql(DriverKind::Mysql, "SHOW TABLES").is_err());
    }

    fn idx(name: &str, primary: bool) -> super::super::types::IndexInfo {
        serde_json::from_value(serde_json::json!({
            "name": name, "columns": ["a"], "unique": false, "primary": primary, "method": null
        }))
        .expect("index info")
    }

    fn req(action: IndexWhatIfAction, index: Option<&str>, columns: &[&str]) -> IndexWhatIfRequest {
        IndexWhatIfRequest {
            database: None,
            table: "t".into(),
            sql: "SELECT 1".into(),
            action,
            index: index.map(str::to_string),
            columns: columns.iter().map(|s| s.to_string()).collect(),
            confirm_locking: false,
            lock_timeout_secs: None,
        }
    }

    #[test]
    fn action_validation() {
        let indexes = vec![idx("a_idx", false), idx("PRIMARY", true)];
        let d =
            |n: Option<&str>| validate_action(&req(IndexWhatIfAction::Disable, n, &[]), &indexes);
        assert!(d(Some("a_idx")).is_ok());
        assert!(d(Some("PRIMARY")).is_err());
        assert!(d(Some("missing")).is_err());
        assert!(d(None).is_err());
        let a = |c: &[&str]| validate_action(&req(IndexWhatIfAction::Add, None, c), &indexes);
        assert!(a(&["x", "y"]).is_ok());
        assert!(a(&[]).is_err());
        assert!(a(&["x", "X"]).is_err());
        assert!(a(&["x", " "]).is_err());
    }
}
