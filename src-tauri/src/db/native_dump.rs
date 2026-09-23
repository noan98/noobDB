//! 外部バイナリに依存しない論理ダンプ (#987)。
//!
//! MySQL / PostgreSQL のダンプは `mysqldump` / `pg_dump` を呼び、SQLite は
//! `sqlite_master` の DDL をそのまま書き出す (`commands/dump.rs`)。DuckDB と
//! Microsoft SQL Server にはそのどちらも無い (DuckDB に `.dump` 相当の外部 CLI を
//! 前提にできない / MSSQL の `sqlpackage` 等は PATH 依存が強い) ため、ここで
//! **ライブ接続のカタログから DDL を組み立て、行データを `INSERT` としてストリーム
//! 出力する**。
//!
//! - スキーマ: DuckDB は `duckdb_tables()` / `duckdb_views()` / `duckdb_indexes()`
//!   の `sql` 列 (エンジン自身が再生成する正規化済み DDL) と `duckdb_sequences()`
//!   の現在値、MSSQL は `sys.*` カタログから `CREATE TABLE` / インデックス /
//!   外部キーを再構成し、ビュー・ルーチン・トリガーは `sys.sql_modules.definition`
//!   (`OBJECT_DEFINITION` と同じ本文) を使う。MSSQL の introspection はドライバ全体の
//!   方針 (`db/mssql.rs` のモジュール doc) と同じく `dbo` スキーマ限定。
//! - 行データ: `Connection::execute_stream` でテーブルを 1 本ずつストリーム読みし、
//!   INSERT 文の書式はエクスポート (`commands/export.rs::write_sql_insert`) と
//!   [`build_sql_insert_statement`] を共有する。リテラル化はエクスポートと同じ
//!   `data_diff::sql_literal` を土台に、**ダンプを再実行して同じ値に戻る**ための
//!   列型別の補正 ([`ColumnRender`]) を掛ける:
//!   - 64bit を超えうる整数・DECIMAL は `Value::from_*_lossless` により文字列で
//!     届くので、数値列では引用符なしの数値リテラルへ戻す (精度を落とさない)。
//!   - DuckDB の日時・INTERVAL・UUID・ENUM・LIST/STRUCT/MAP などは SELECT 側で
//!     `CAST(col AS VARCHAR)` し、`CAST('...' AS <型>)` として書く — DuckDB の
//!     テキスト表現はその型への CAST で往復できる (TIMESTAMPTZ もオフセット付き)。
//!   - MSSQL の日時はサーバ側で言語設定 (`DATEFORMAT`) に依存しない ISO 形式の
//!     文字列へ変換してから `N'...'` で書く。`money` は小数 4 桁の数値文字列、
//!     `xml` / `sql_variant` は文字列、`hierarchyid` / `geometry` / `geography` は
//!     `varbinary` として取り出す。文字列は Unicode を保つため `N'...'`。
//!   - 計算列・`rowversion` 列は値を挿入できないので INSERT の列から外し、
//!     IDENTITY 列を持つテーブルは `SET IDENTITY_INSERT` で挟む。
//!
//! MSSQL の出力は `GO` 区切りのバッチ (SSMS / sqlcmd のスクリプト形式)。
//! `CREATE VIEW` / `CREATE PROCEDURE` などはバッチの先頭文でなければならないため。
//!
//! 読み出しのみ (カタログ参照と SELECT) なので読み取り専用セッションでも実行できる。

use crate::db::data_diff::sql_literal;
use crate::db::sync::quote_ident;
use crate::db::types::{StreamBatch, Value};
use crate::db::{Connection, DriverKind};
use crate::error::{AppError, Result};

/// `execute_stream` で 1 度に受け取る行数。INSERT のバッチ (既定 100 行) より
/// 大きめにして、往復回数とメモリ (1 チャンク分だけ) のバランスを取る。
const STREAM_CHUNK_ROWS: usize = 500;
/// 1 つの INSERT 文にまとめる既定の行数 (エクスポートの既定と同じ)。
const DEFAULT_INSERT_BATCH: usize = 100;
/// T-SQL の `INSERT ... VALUES` が 1 文で受け付ける行数の上限。
const MSSQL_MAX_VALUES_ROWS: usize = 1000;
/// MSSQL のダンプ対象スキーマ (ドライバ全体の introspection 範囲と同じ)。
const MSSQL_SCHEMA: &str = "dbo";

/// ネイティブダンプの整形オプション。`commands::dump::DumpOptions` から
/// ドライバ非依存の項目だけを写したもの (db 層が commands 層に依存しないように)。
#[derive(Debug, Clone, Copy)]
pub struct NativeDumpOptions {
    /// 行データを出さない (スキーマのみ)。
    pub no_data: bool,
    /// スキーマを出さない (データのみ)。DROP も出さない。
    pub no_create_info: bool,
    /// CREATE の前に DROP ... IF EXISTS を出す。
    pub add_drop_table: bool,
    /// 複数行 INSERT にまとめる (false なら 1 行 1 文)。
    pub extended_insert: bool,
    /// MSSQL: ストアドプロシージャ / 関数を含める。
    pub routines: bool,
    /// MSSQL: トリガーを含める。
    pub triggers: bool,
}

impl Default for NativeDumpOptions {
    fn default() -> Self {
        Self {
            no_data: false,
            no_create_info: false,
            add_drop_table: true,
            extended_insert: true,
            routines: true,
            triggers: true,
        }
    }
}

/// ダンプの書き出し先。`write` は同期 (エクスポートのストリーミング sink と同じく
/// `execute_stream` の同期コールバック内から呼ばれる)。`table_done` はテーブル 1 本
/// を書き終えるたびに呼ばれ、進捗イベントの発火に使う。
pub trait DumpSink {
    fn write(&mut self, s: &str) -> Result<()>;
    fn table_done(&mut self, done: u64, total: u64);
}

/// メモリへ書き出す sink (単体テスト・統合テスト用)。
impl DumpSink for String {
    fn write(&mut self, s: &str) -> Result<()> {
        self.push_str(s);
        Ok(())
    }
    fn table_done(&mut self, _done: u64, _total: u64) {}
}

// ───────────────────────── 共通: 列ごとのリテラル化 ─────────────────────────

/// 1 列ぶんの「SELECT での取り出し方」と「INSERT でのリテラル化」。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ColumnRender {
    /// ドライバ既定のリテラル化 (`sql_literal`。MSSQL の文字列は `N'...'`)。
    Plain,
    /// 数値列。文字列で届いた値 (2^53 超の整数・DECIMAL・money) が数値の字面
    /// なら引用符なしで書く。
    Numeric,
    /// DuckDB: SELECT で VARCHAR に落とし、`CAST('...' AS <型>)` で書き戻す。
    CastText(String),
}

/// ダンプ 1 列ぶんのメタデータ。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DumpColumn {
    pub name: String,
    /// SELECT リストに置く式 (クオート済み列名、または変換式)。
    pub select_expr: String,
    pub render: ColumnRender,
}

/// `s` が符号付きの十進数値リテラル (`-12`, `3.50`, `1e10`) かどうか。数値列の
/// 文字列値を引用符なしで書いてよいかの判定に使う — それ以外 (空文字や任意の
/// テキスト) は安全側で文字列リテラルにする (SQL インジェクションにならない)。
pub(crate) fn is_numeric_literal(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'-' || b[i] == b'+') {
        i += 1;
    }
    let int_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let int_digits = i - int_start;
    let mut frac_digits = 0;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let frac_start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        frac_digits = i - frac_start;
    }
    if int_digits + frac_digits == 0 {
        return false;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'-' || b[i] == b'+') {
            i += 1;
        }
        let exp_start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == exp_start {
            return false;
        }
    }
    i == b.len()
}

/// 浮動小数の往復可能な最短表記。`f64` の `Debug` は極端な桁で指数表記
/// (`1e300`) を使うため、`Display` (`1000…0` の 301 桁) のように MSSQL の
/// 数値リテラル精度上限 (38 桁) を超えない。非有限値はドライバ既定
/// (`sql_literal`: DuckDB は `'NaN'` 等、MSSQL は NULL) に任せる。
fn float_literal(driver: DriverKind, f: f64) -> String {
    if f.is_finite() {
        format!("{f:?}")
    } else {
        sql_literal(driver, &Value::Float(f))
    }
}

/// ダンプ用に `value` をリテラル化する。エクスポートと同じ `sql_literal` を
/// 土台に、`render` による型別の補正を掛ける (モジュール doc 参照)。
pub(crate) fn dump_literal(driver: DriverKind, render: &ColumnRender, value: &Value) -> String {
    match (render, value) {
        (_, Value::Null) => "NULL".to_string(),
        (ColumnRender::Numeric, Value::String(s)) if is_numeric_literal(s) => s.clone(),
        (ColumnRender::CastText(ty), Value::String(s)) => {
            format!(
                "CAST({} AS {ty})",
                sql_literal(driver, &Value::String(s.clone()))
            )
        }
        (_, Value::Float(f)) => float_literal(driver, *f),
        // T-SQL の '...' は varchar (コードページ依存) なので、nvarchar の値を
        // 失わないよう Unicode リテラル N'...' にする。
        (_, Value::String(s)) if driver == DriverKind::Mssql => {
            format!("N'{}'", s.replace('\'', "''"))
        }
        // DuckDB の BLOB リテラルは '\xAB\x12' を BLOB へ CAST したときにだけ
        // バイト列として解釈されるので、型を明示する。
        (_, Value::Bytes(_)) if driver == DriverKind::DuckDb => {
            format!("{}::BLOB", sql_literal(driver, value))
        }
        _ => sql_literal(driver, value),
    }
}

/// 1 行を `(v1, v2, ...)` へ変換する。
fn values_tuple(driver: DriverKind, columns: &[DumpColumn], row: &[Value]) -> String {
    let mut out = String::from("(");
    for (i, col) in columns.iter().enumerate() {
        if i > 0 {
            out.push_str(", ");
        }
        out.push_str(&dump_literal(
            driver,
            &col.render,
            row.get(i).unwrap_or(&Value::Null),
        ));
    }
    out.push(')');
    out
}

/// `INSERT INTO <table> (<cols>) VALUES\n  (...),\n  (...);\n` を 1 文ぶん組み立てる。
/// 書式 (改行・字下げ・末尾の `;`) の単一実装で、結果グリッドの SQL エクスポート
/// (`commands/export.rs::write_sql_insert`) とこのダンプが共有する。`table` /
/// `cols` は呼び出し側でクオート済みのもの、`tuple` は 1 行を `(v1, v2, ...)` へ
/// 変換する関数 (ダンプは列型を見たリテラル化を差し込む)。
pub(crate) fn build_sql_insert_statement<R>(
    table: &str,
    cols: &str,
    rows: &[R],
    mut tuple: impl FnMut(&R) -> String,
) -> String {
    let mut stmt = format!("INSERT INTO {} ({}) VALUES\n", table, cols);
    for (i, row) in rows.iter().enumerate() {
        if i > 0 {
            stmt.push_str(",\n");
        }
        stmt.push_str("  ");
        stmt.push_str(&tuple(row));
    }
    stmt.push_str(";\n");
    stmt
}

/// 1 テーブル分の行データ出力の設定。
struct InsertPlan<'a> {
    driver: DriverKind,
    /// クオート (必要ならスキーマ修飾) 済みのテーブル名。
    table: &'a str,
    columns: &'a [DumpColumn],
    batch: usize,
    /// MSSQL: 各 INSERT バッチを `SET IDENTITY_INSERT ... ON/OFF` で挟む。
    identity_insert: bool,
}

impl InsertPlan<'_> {
    fn select_sql(&self) -> String {
        let list = self
            .columns
            .iter()
            .map(|c| c.select_expr.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        format!("SELECT {list} FROM {}", self.table)
    }

    /// `rows` を INSERT 文 (必要なら MSSQL のバッチ区切り付き) にして返す。
    fn render(&self, rows: &[Vec<Value>]) -> String {
        let cols = self
            .columns
            .iter()
            .map(|c| quote_ident(self.driver, &c.name))
            .collect::<Vec<_>>()
            .join(", ");
        let mut out = String::new();
        for chunk in rows.chunks(self.batch.max(1)) {
            let stmt = build_sql_insert_statement(self.table, &cols, chunk, |row| {
                values_tuple(self.driver, self.columns, row)
            });
            if self.driver == DriverKind::Mssql {
                // SET IDENTITY_INSERT はセッション単位の設定なので、接続プール越しに
                // バッチごと別接続で実行されても効くよう同じバッチ内で ON/OFF する。
                if self.identity_insert {
                    out.push_str(&format!("SET IDENTITY_INSERT {} ON;\n", self.table));
                }
                out.push_str(&stmt);
                if self.identity_insert {
                    out.push_str(&format!("SET IDENTITY_INSERT {} OFF;\n", self.table));
                }
                out.push_str("GO\n");
            } else {
                out.push_str(&stmt);
            }
        }
        out
    }
}

/// テーブル 1 本の行を `execute_stream` で読みながら sink へ書く。
async fn stream_table_rows<S: DumpSink + Send>(
    conn: &Connection,
    database: Option<&str>,
    plan: &InsertPlan<'_>,
    sink: &mut S,
) -> Result<()> {
    if plan.columns.is_empty() {
        return Ok(());
    }
    let sql = plan.select_sql();
    conn.execute_stream(
        &sql,
        database,
        STREAM_CHUNK_ROWS,
        STREAM_CHUNK_ROWS,
        |batch| match batch {
            StreamBatch::Columns(_) => Ok(()),
            StreamBatch::Rows(rows) => {
                if rows.is_empty() {
                    return Ok(());
                }
                sink.write(&plan.render(&rows))
            }
        },
    )
    .await?;
    Ok(())
}

fn insert_batch(opts: &NativeDumpOptions, driver: DriverKind) -> usize {
    if !opts.extended_insert {
        return 1;
    }
    match driver {
        DriverKind::Mssql => DEFAULT_INSERT_BATCH.min(MSSQL_MAX_VALUES_ROWS),
        _ => DEFAULT_INSERT_BATCH,
    }
}

// ── カタログ結果の値取り出し ──

fn val_str(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) => Some(s.clone()),
        Value::Int(i) => Some(i.to_string()),
        Value::UInt(u) => Some(u.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Float(f) => Some(f.to_string()),
        Value::Bytes(_) | Value::Null => None,
    }
}

fn val_i64(v: Option<&Value>) -> Option<i64> {
    match v? {
        Value::Int(i) => Some(*i),
        Value::UInt(u) => i64::try_from(*u).ok(),
        Value::Bool(b) => Some(i64::from(*b)),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn val_bool(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Bool(b)) => *b,
        Some(Value::Int(i)) => *i != 0,
        Some(Value::UInt(u)) => *u != 0,
        Some(Value::String(s)) => matches!(s.as_str(), "1" | "true" | "TRUE" | "True"),
        _ => false,
    }
}

/// 外部キーの依存 (`child → parent`) を満たす順にテーブル名を並べる (Kahn 法)。
/// 同順位は入力順を保ち、循環や自己参照が残ったテーブルは末尾に入力順で足す
/// (DDL を落とすより、復元時に FK エラーで気づける方が安全)。
pub(crate) fn order_tables_by_dependencies(
    tables: &[String],
    edges: &[(String, String)],
) -> Vec<String> {
    let idx = |name: &str| tables.iter().position(|t| t == name);
    let n = tables.len();
    let mut indegree = vec![0usize; n];
    let mut children: Vec<Vec<usize>> = vec![Vec::new(); n];
    let mut seen = std::collections::HashSet::new();
    for (child, parent) in edges {
        let (Some(c), Some(p)) = (idx(child), idx(parent)) else {
            continue;
        };
        if c == p || !seen.insert((c, p)) {
            continue;
        }
        indegree[c] += 1;
        children[p].push(c);
    }
    let mut placed = vec![false; n];
    let mut out = Vec::with_capacity(n);
    // 入力順で最初の「依存が解消済み」テーブルを取る (安定な順序)。
    while let Some(next) = (0..n).find(|&i| !placed[i] && indegree[i] == 0) {
        placed[next] = true;
        out.push(tables[next].clone());
        for &c in &children[next] {
            indegree[c] = indegree[c].saturating_sub(1);
        }
    }
    for i in 0..n {
        if !placed[i] {
            out.push(tables[i].clone());
        }
    }
    out
}

// ───────────────────────────────── DuckDB ─────────────────────────────────

/// DuckDB の `information_schema.columns.data_type` から列の扱いを決める。
/// 数値・真偽・文字列・BLOB はドライバのデコード結果をそのまま使い、それ以外
/// (日時・INTERVAL・UUID・ENUM・入れ子型など) はテキスト経由で往復させる。
pub(crate) fn duckdb_column(name: &str, data_type: &str) -> DumpColumn {
    let upper = data_type.trim().to_ascii_uppercase();
    let ident = quote_ident(DriverKind::DuckDb, name);
    let base = upper.split('(').next().unwrap_or("").trim();
    let numeric = matches!(
        base,
        "TINYINT"
            | "SMALLINT"
            | "INTEGER"
            | "BIGINT"
            | "HUGEINT"
            | "UTINYINT"
            | "USMALLINT"
            | "UINTEGER"
            | "UBIGINT"
            | "UHUGEINT"
            | "DECIMAL"
            | "NUMERIC"
    );
    let plain = matches!(
        base,
        "BOOLEAN" | "FLOAT" | "DOUBLE" | "REAL" | "VARCHAR" | "TEXT" | "STRING" | "BLOB" | "BYTEA"
    );
    // 配列 (`INTEGER[]` / `DECIMAL(18,3)[3]`) は base 判定で数値や文字列に見えても
    // 入れ子型なので必ずテキスト経由にする (`STRUCT(...)` / `MAP(...)` は base が
    // 一致しないので自然にテキスト経由になる)。
    let nested = upper.contains('[');
    if (numeric || plain) && !nested {
        return DumpColumn {
            name: name.to_string(),
            select_expr: ident,
            render: if numeric {
                ColumnRender::Numeric
            } else {
                ColumnRender::Plain
            },
        };
    }
    DumpColumn {
        name: name.to_string(),
        select_expr: format!("CAST({ident} AS VARCHAR)"),
        render: ColumnRender::CastText(data_type.trim().to_string()),
    }
}

/// DuckDB のシーケンスを「現在値の続きから始まる」`CREATE SEQUENCE` にする。
/// `duckdb_sequences().sql` は作成時の START を返すため、そのまま使うと復元後の
/// `nextval` が既存行の値と衝突する。
#[allow(clippy::too_many_arguments)]
pub(crate) fn duckdb_sequence_ddl(
    qualified: &str,
    start_value: i64,
    last_value: Option<i64>,
    increment_by: i64,
    min_value: i64,
    max_value: i64,
    cycle: bool,
) -> String {
    let start = match last_value {
        Some(last) => last.saturating_add(increment_by),
        None => start_value,
    };
    // 続きの値が範囲外 (使い切った非 CYCLE シーケンス) なら範囲内に丸める。
    let start = start.clamp(min_value.min(max_value), max_value.max(min_value));
    format!(
        "CREATE SEQUENCE {qualified} INCREMENT BY {increment_by} MINVALUE {min_value} \
         MAXVALUE {max_value} START WITH {start}{};\n",
        if cycle { " CYCLE" } else { " NO CYCLE" }
    )
}

pub(crate) async fn dump_duckdb<S: DumpSink + Send>(
    conn: &Connection,
    database: &str,
    opts: &NativeDumpOptions,
    sink: &mut S,
) -> Result<()> {
    let driver = DriverKind::DuckDb;
    let schema = match database.trim() {
        "" => "main",
        s => s,
    };
    let schema_lit = sql_literal(driver, &Value::String(schema.to_string()));
    let schema_ident = quote_ident(driver, schema);
    let is_main = schema == "main";
    let qualify = |name: &str| format!("{schema_ident}.{}", quote_ident(driver, name));

    // テーブル (作成順)。一時テーブル・内部テーブルは除く。
    let tables_res = conn
        .execute(
            &format!(
                "SELECT table_name, sql FROM duckdb_tables() \
                 WHERE database_name = current_database() AND schema_name = {schema_lit} \
                   AND NOT internal AND NOT temporary ORDER BY table_oid"
            ),
            None,
        )
        .await?;
    let mut table_sql: Vec<(String, String)> = Vec::new();
    for r in &tables_res.rows {
        if let (Some(name), Some(sql)) = (val_str(r.first()), val_str(r.get(1))) {
            table_sql.push((name, sql));
        }
    }
    let names: Vec<String> = table_sql.iter().map(|(n, _)| n.clone()).collect();
    let fks = conn.foreign_keys(schema).await.unwrap_or_default();
    let edges: Vec<(String, String)> = fks
        .iter()
        .map(|fk| (fk.table.clone(), fk.referenced_table.clone()))
        .collect();
    let ordered = order_tables_by_dependencies(&names, &edges);

    let views_res = if opts.no_create_info {
        None
    } else {
        Some(
            conn.execute(
                &format!(
                    "SELECT view_name, sql FROM duckdb_views() \
                     WHERE database_name = current_database() AND schema_name = {schema_lit} \
                       AND NOT internal AND NOT temporary ORDER BY view_oid"
                ),
                None,
            )
            .await?,
        )
    };
    let views: Vec<(String, String)> = views_res
        .iter()
        .flat_map(|r| r.rows.iter())
        .filter_map(|r| Some((val_str(r.first())?, val_str(r.get(1))?)))
        .collect();

    let mut head = format!("-- noobDB native dump (DuckDB)\n-- schema: {schema}\n\n");
    if !opts.no_create_info {
        if !is_main {
            head.push_str(&format!("CREATE SCHEMA IF NOT EXISTS {schema_ident};\n"));
        }
        if opts.add_drop_table {
            // ビュー → 子テーブル → 親テーブルの順に落とす (依存の逆順)。
            for (name, _) in views.iter().rev() {
                head.push_str(&format!("DROP VIEW IF EXISTS {};\n", qualify(name)));
            }
            for name in ordered.iter().rev() {
                head.push_str(&format!("DROP TABLE IF EXISTS {};\n", qualify(name)));
            }
        }
    }
    sink.write(&head)?;

    if !opts.no_create_info {
        // シーケンスはテーブルの DEFAULT nextval(...) から参照されうるので先に作る。
        let seqs = conn
            .execute(
                &format!(
                    "SELECT sequence_name, start_value, last_value, increment_by, \
                            min_value, max_value, cycle, sql \
                     FROM duckdb_sequences() \
                     WHERE database_name = current_database() AND schema_name = {schema_lit} \
                       AND NOT temporary ORDER BY sequence_oid"
                ),
                None,
            )
            .await?;
        let mut chunk = String::new();
        for r in &seqs.rows {
            let Some(name) = val_str(r.first()) else {
                continue;
            };
            let qualified = qualify(&name);
            if opts.add_drop_table {
                chunk.push_str(&format!("DROP SEQUENCE IF EXISTS {qualified};\n"));
            }
            // `sql` はエンジンが永続化済みのカウンタ (次に返す値) を START に
            // 埋めて再生成する。`last_value` はセッション内でしか埋まらない
            // (接続し直すと NULL) ため、`sql` がある限りそちらを優先する。
            match val_str(r.get(7)) {
                Some(sql) if !sql.trim().is_empty() => {
                    chunk.push_str(sql.trim_end().trim_end_matches(';'));
                    chunk.push_str(";\n");
                }
                _ => chunk.push_str(&duckdb_sequence_ddl(
                    &qualified,
                    val_i64(r.get(1)).unwrap_or(1),
                    val_i64(r.get(2)),
                    val_i64(r.get(3)).unwrap_or(1),
                    val_i64(r.get(4)).unwrap_or(1),
                    val_i64(r.get(5)).unwrap_or(i64::MAX),
                    val_bool(r.get(6)),
                )),
            }
        }
        for name in &ordered {
            if let Some((_, sql)) = table_sql.iter().find(|(n, _)| n == name) {
                chunk.push_str(sql.trim_end().trim_end_matches(';'));
                chunk.push_str(";\n");
            }
        }
        if !chunk.is_empty() {
            chunk.push('\n');
            sink.write(&chunk)?;
        }
    }

    let total = ordered.len() as u64;
    let batch = insert_batch(opts, driver);
    for (i, name) in ordered.iter().enumerate() {
        if !opts.no_data {
            let columns: Vec<DumpColumn> = conn
                .columns(schema, name)
                .await?
                .iter()
                .map(|c| duckdb_column(&c.name, &c.data_type))
                .collect();
            let generated = table_sql
                .iter()
                .find(|(n, _)| n == name)
                .map(|(_, sql)| duckdb_generated_columns(sql))
                .unwrap_or_default();
            let columns: Vec<DumpColumn> = columns
                .into_iter()
                .filter(|c| !generated.contains(&c.name))
                .collect();
            let table = qualify(name);
            let plan = InsertPlan {
                driver,
                table: &table,
                columns: &columns,
                batch,
                identity_insert: false,
            };
            stream_table_rows(conn, None, &plan, sink).await?;
        }
        sink.table_done(i as u64 + 1, total);
    }

    if !opts.no_create_info {
        let mut tail = String::new();
        // インデックスはデータ投入後に作る (投入が速く、UNIQUE 違反も DDL 側で出る)。
        let idx = conn
            .execute(
                &format!(
                    "SELECT sql FROM duckdb_indexes() \
                     WHERE database_name = current_database() AND schema_name = {schema_lit} \
                       AND sql IS NOT NULL ORDER BY index_oid"
                ),
                None,
            )
            .await?;
        for r in &idx.rows {
            if let Some(sql) = val_str(r.first()) {
                tail.push_str(sql.trim_end().trim_end_matches(';'));
                tail.push_str(";\n");
            }
        }
        for (_, sql) in &views {
            tail.push_str(sql.trim_end().trim_end_matches(';'));
            tail.push_str(";\n");
        }
        if !tail.is_empty() {
            sink.write(&format!("\n{tail}"))?;
        }
    }
    Ok(())
}

/// DuckDB の生成列 (`GENERATED ALWAYS AS (...)`) の名前を、`duckdb_tables().sql`
/// の正規化済み DDL から取り出す。値を INSERT できないため行データの列から外す。
/// (`information_schema.columns.is_generated` は DuckDB では常に NULL で、
/// 生成式は `column_default` に入るため、カタログ列からは判別できない。)
///
/// 列リスト `(...)` をトップレベルのカンマで分け、文字列・クオート識別子の外側に
/// `GENERATED ALWAYS AS` を含む要素の先頭識別子を返す。
pub(crate) fn duckdb_generated_columns(ddl: &str) -> Vec<String> {
    let chars: Vec<char> = ddl.chars().collect();
    let n = chars.len();
    // クオートの外で最初の `(` = 列リストの開始 (テーブル名の `"a(b"` は飛ばす)。
    let mut i = 0;
    let mut start = None;
    while i < n {
        match chars[i] {
            '"' | '\'' => i = skip_quoted(&chars, i),
            '(' => {
                start = Some(i + 1);
                break;
            }
            _ => i += 1,
        }
    }
    let Some(mut i) = start else {
        return Vec::new();
    };
    // 要素ごとに「クオート外だけを残した文字列 (判定用)」と「原文 (名前取り出し
    // 用)」を集める。
    let mut elements: Vec<(String, String)> = Vec::new();
    let (mut masked, mut raw) = (String::new(), String::new());
    let mut depth = 0usize;
    while i < n {
        let c = chars[i];
        match c {
            '"' | '\'' => {
                let end = skip_quoted(&chars, i);
                raw.extend(&chars[i..end]);
                masked.push(' ');
                i = end;
                continue;
            }
            '(' => depth += 1,
            ')' if depth == 0 => break,
            ')' => depth -= 1,
            ',' if depth == 0 => {
                elements.push((std::mem::take(&mut masked), std::mem::take(&mut raw)));
                i += 1;
                continue;
            }
            _ => {}
        }
        masked.push(c);
        raw.push(c);
        i += 1;
    }
    elements.push((masked, raw));
    elements
        .into_iter()
        .filter(|(masked, _)| {
            masked
                .to_ascii_uppercase()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .contains("GENERATED ALWAYS AS")
        })
        .filter_map(|(_, raw)| leading_identifier(raw.trim_start()))
        .collect()
}

/// `chars[start]` の引用符 (`"` / `'`) で始まるクオートの直後の位置。二重化
/// (`""` / `''`) はエスケープとして読み飛ばす。閉じなければ末尾。
fn skip_quoted(chars: &[char], start: usize) -> usize {
    let q = chars[start];
    let mut i = start + 1;
    while i < chars.len() {
        if chars[i] == q {
            if chars.get(i + 1) == Some(&q) {
                i += 2;
                continue;
            }
            return i + 1;
        }
        i += 1;
    }
    chars.len()
}

/// 列定義の先頭の識別子 (`"a ""b"""` なら `a "b"`、裸なら空白まで)。
fn leading_identifier(s: &str) -> Option<String> {
    if let Some(rest) = s.strip_prefix('"') {
        let mut out = String::new();
        let mut it = rest.chars().peekable();
        while let Some(c) = it.next() {
            if c == '"' {
                if it.peek() == Some(&'"') {
                    it.next();
                    out.push('"');
                    continue;
                }
                return Some(out);
            }
            out.push(c);
        }
        None
    } else {
        let name: String = s.chars().take_while(|c| !c.is_whitespace()).collect();
        (!name.is_empty()).then_some(name)
    }
}

// ───────────────────────────────── MSSQL ─────────────────────────────────

/// MSSQL の 1 列ぶんのカタログ情報。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct MssqlColumn {
    pub name: String,
    /// `sys.types.name` (エイリアス型なら基底のシステム型名)。
    pub type_name: String,
    pub max_length: i64,
    pub precision: i64,
    pub scale: i64,
    pub nullable: bool,
    /// `(seed, increment)`。
    pub identity: Option<(String, String)>,
    /// 計算列の式 (`sys.computed_columns.definition`) と PERSISTED か。
    pub computed: Option<(String, bool)>,
    /// `(制約名, 式)`。
    pub default: Option<(String, String)>,
    /// DB 既定と異なる照合順序のときだけ `Some`。
    pub collation: Option<String>,
}

/// PRIMARY KEY / UNIQUE 制約。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct MssqlKey {
    pub name: String,
    pub primary: bool,
    pub clustered: bool,
    /// `(列名, 降順か)`。
    pub columns: Vec<(String, bool)>,
}

/// 1 テーブル分の DDL 素材。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct MssqlTable {
    pub name: String,
    pub columns: Vec<MssqlColumn>,
    pub keys: Vec<MssqlKey>,
    /// `(制約名, 式)`。
    pub checks: Vec<(String, String)>,
}

/// `sys.types` の名前と長さ・精度から型の字面を組み立てる (`nvarchar(50)`,
/// `decimal(10,2)`, `datetime2(3)`, `varbinary(max)` ...)。`max_length` は
/// バイト数なので、`nchar` / `nvarchar` は 2 で割る。
pub(crate) fn mssql_type_sql(
    type_name: &str,
    max_length: i64,
    precision: i64,
    scale: i64,
) -> String {
    let lower = type_name.to_ascii_lowercase();
    let len = |divisor: i64| {
        if max_length < 0 {
            "max".to_string()
        } else {
            (max_length / divisor).to_string()
        }
    };
    match lower.as_str() {
        "char" | "varchar" | "binary" | "varbinary" => format!("{lower}({})", len(1)),
        "nchar" | "nvarchar" => format!("{lower}({})", len(2)),
        "decimal" | "numeric" => format!("{lower}({precision},{scale})"),
        "datetime2" | "time" | "datetimeoffset" => format!("{lower}({scale})"),
        "float" if precision != 53 && precision > 0 => format!("float({precision})"),
        // `timestamp` は旧名。現行の同義語 rowversion で書く。
        "timestamp" => "rowversion".to_string(),
        _ => lower,
    }
}

fn mssql_qualify(name: &str) -> String {
    format!(
        "{}.{}",
        quote_ident(DriverKind::Mssql, MSSQL_SCHEMA),
        quote_ident(DriverKind::Mssql, name)
    )
}

/// 列定義 1 行。
pub(crate) fn mssql_column_def(col: &MssqlColumn) -> String {
    let ident = quote_ident(DriverKind::Mssql, &col.name);
    if let Some((expr, persisted)) = &col.computed {
        return format!(
            "{ident} AS {expr}{}",
            if *persisted { " PERSISTED" } else { "" }
        );
    }
    let mut def = format!(
        "{ident} {}",
        mssql_type_sql(&col.type_name, col.max_length, col.precision, col.scale)
    );
    if let Some(c) = &col.collation {
        def.push_str(&format!(" COLLATE {c}"));
    }
    if let Some((seed, incr)) = &col.identity {
        def.push_str(&format!(" IDENTITY({seed},{incr})"));
    }
    def.push_str(if col.nullable { " NULL" } else { " NOT NULL" });
    if let Some((name, expr)) = &col.default {
        def.push_str(&format!(
            " CONSTRAINT {} DEFAULT {expr}",
            quote_ident(DriverKind::Mssql, name)
        ));
    }
    def
}

/// `CREATE TABLE [dbo].[t] (...)` (+ `GO`)。PK / UNIQUE / CHECK はインライン、
/// 外部キーはデータ投入後に `ALTER TABLE` で足す ([`mssql_foreign_key_sql`])。
pub(crate) fn mssql_create_table(table: &MssqlTable) -> String {
    let mut lines: Vec<String> = table.columns.iter().map(mssql_column_def).collect();
    for key in &table.keys {
        let cols = key
            .columns
            .iter()
            .map(|(c, desc)| {
                format!(
                    "{} {}",
                    quote_ident(DriverKind::Mssql, c),
                    if *desc { "DESC" } else { "ASC" }
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!(
            "CONSTRAINT {} {} {} ({cols})",
            quote_ident(DriverKind::Mssql, &key.name),
            if key.primary { "PRIMARY KEY" } else { "UNIQUE" },
            if key.clustered {
                "CLUSTERED"
            } else {
                "NONCLUSTERED"
            },
        ));
    }
    for (name, expr) in &table.checks {
        lines.push(format!(
            "CONSTRAINT {} CHECK {expr}",
            quote_ident(DriverKind::Mssql, name)
        ));
    }
    format!(
        "CREATE TABLE {} (\n  {}\n);\nGO\n",
        mssql_qualify(&table.name),
        lines.join(",\n  ")
    )
}

/// 行データ出力に使う列 (計算列・rowversion を除く) と SELECT 式。日時などは
/// サーバ側で往復可能な文字列へ変換する (モジュール doc 参照)。
pub(crate) fn mssql_dump_columns(table: &MssqlTable) -> Vec<DumpColumn> {
    table
        .columns
        .iter()
        .filter(|c| c.computed.is_none())
        .filter(|c| {
            let t = c.type_name.to_ascii_lowercase();
            t != "timestamp" && t != "rowversion"
        })
        .map(|c| {
            let ident = quote_ident(DriverKind::Mssql, &c.name);
            let t = c.type_name.to_ascii_lowercase();
            let (select_expr, render) = match t.as_str() {
                "tinyint" | "smallint" | "int" | "bigint" | "decimal" | "numeric" => {
                    (ident, ColumnRender::Numeric)
                }
                // money は tiberius が f64 で読むため精度が落ちる。style 2 = 小数 4 桁。
                "money" | "smallmoney" => (
                    format!("CONVERT(nvarchar(40), {ident}, 2)"),
                    ColumnRender::Numeric,
                ),
                // datetime / smalldatetime の 'yyyy-mm-dd hh:mi:ss' は DATEFORMAT に
                // 依存して解釈されるため、依存しない ISO 8601 (style 126) で出す。
                "datetime" | "smalldatetime" => (
                    format!("CONVERT(nvarchar(40), {ident}, 126)"),
                    ColumnRender::Plain,
                ),
                // 新しい日時型の既定文字列表現 (ISO 形式、オフセット付き) は
                // 言語設定に依存せず元の型へ戻せる。datetimeoffset のオフセットも保つ。
                "date" | "time" | "datetime2" | "datetimeoffset" => (
                    format!("CAST({ident} AS nvarchar(40))"),
                    ColumnRender::Plain,
                ),
                "xml" => (
                    format!("CAST({ident} AS nvarchar(max))"),
                    ColumnRender::Plain,
                ),
                "sql_variant" => (
                    format!("CAST({ident} AS nvarchar(4000))"),
                    ColumnRender::Plain,
                ),
                // CLR 型はバイナリ表現で往復する (varbinary → UDT は暗黙変換可)。
                "hierarchyid" | "geometry" | "geography" => (
                    format!("CAST({ident} AS varbinary(max))"),
                    ColumnRender::Plain,
                ),
                _ => (ident, ColumnRender::Plain),
            };
            DumpColumn {
                name: c.name.clone(),
                select_expr,
                render,
            }
        })
        .collect()
}

/// 非制約インデックス。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct MssqlIndex {
    pub table: String,
    pub name: String,
    pub unique: bool,
    pub clustered: bool,
    pub key_columns: Vec<(String, bool)>,
    pub included: Vec<String>,
    pub filter: Option<String>,
}

pub(crate) fn mssql_index_sql(ix: &MssqlIndex) -> String {
    let keys = ix
        .key_columns
        .iter()
        .map(|(c, desc)| {
            format!(
                "{} {}",
                quote_ident(DriverKind::Mssql, c),
                if *desc { "DESC" } else { "ASC" }
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    let mut sql = format!(
        "CREATE {}{} INDEX {} ON {} ({keys})",
        if ix.unique { "UNIQUE " } else { "" },
        if ix.clustered {
            "CLUSTERED"
        } else {
            "NONCLUSTERED"
        },
        quote_ident(DriverKind::Mssql, &ix.name),
        mssql_qualify(&ix.table),
    );
    if !ix.included.is_empty() {
        let inc = ix
            .included
            .iter()
            .map(|c| quote_ident(DriverKind::Mssql, c))
            .collect::<Vec<_>>()
            .join(", ");
        sql.push_str(&format!(" INCLUDE ({inc})"));
    }
    if let Some(f) = &ix.filter {
        sql.push_str(&format!(" WHERE {f}"));
    }
    sql.push_str(";\nGO\n");
    sql
}

/// 外部キー制約。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct MssqlForeignKey {
    pub name: String,
    pub table: String,
    pub columns: Vec<String>,
    pub referenced_table: String,
    pub referenced_columns: Vec<String>,
    /// `sys.foreign_keys.delete_referential_action_desc` (`NO_ACTION` / `CASCADE` ...)。
    pub on_delete: String,
    pub on_update: String,
}

fn referential_action(desc: &str) -> Option<String> {
    let d = desc.trim().to_ascii_uppercase().replace('_', " ");
    match d.as_str() {
        "CASCADE" | "SET NULL" | "SET DEFAULT" => Some(d),
        _ => None,
    }
}

pub(crate) fn mssql_foreign_key_sql(fk: &MssqlForeignKey) -> String {
    let list = |cols: &[String]| {
        cols.iter()
            .map(|c| quote_ident(DriverKind::Mssql, c))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let mut sql = format!(
        "ALTER TABLE {} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({})",
        mssql_qualify(&fk.table),
        quote_ident(DriverKind::Mssql, &fk.name),
        list(&fk.columns),
        mssql_qualify(&fk.referenced_table),
        list(&fk.referenced_columns),
    );
    if let Some(a) = referential_action(&fk.on_delete) {
        sql.push_str(&format!(" ON DELETE {a}"));
    }
    if let Some(a) = referential_action(&fk.on_update) {
        sql.push_str(&format!(" ON UPDATE {a}"));
    }
    sql.push_str(";\nGO\n");
    sql
}

/// ビュー・関数・プロシージャ・トリガー (`sys.sql_modules`)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MssqlModule {
    pub name: String,
    /// `sys.objects.type` (`V` / `P` / `FN` / `IF` / `TF` / `TR`)。
    pub kind: String,
    pub definition: Option<String>,
}

impl MssqlModule {
    fn is_trigger(&self) -> bool {
        self.kind == "TR"
    }
    fn is_routine(&self) -> bool {
        matches!(self.kind.as_str(), "P" | "FN" | "IF" | "TF")
    }
    fn is_view(&self) -> bool {
        self.kind == "V"
    }
    /// `DROP ... IF EXISTS` の種別キーワード。
    fn drop_keyword(&self) -> Option<&'static str> {
        match self.kind.as_str() {
            "V" => Some("VIEW"),
            "P" => Some("PROCEDURE"),
            "FN" | "IF" | "TF" => Some("FUNCTION"),
            // トリガーはテーブルと一緒に落ちる。
            _ => None,
        }
    }
}

/// 出力対象のモジュールだけを残す (作成順は保つ)。
fn mssql_selected_modules<'a>(
    modules: &'a [MssqlModule],
    opts: &NativeDumpOptions,
) -> Vec<&'a MssqlModule> {
    modules
        .iter()
        .filter(|m| {
            m.is_view() || (opts.routines && m.is_routine()) || (opts.triggers && m.is_trigger())
        })
        .collect()
}

/// 1 モジュールを `GO` 区切りのバッチとして書く。暗号化されて本文が取れない
/// ものはコメントで残す (黙って欠落させない)。
pub(crate) fn mssql_module_sql(m: &MssqlModule) -> String {
    match &m.definition {
        Some(def) if !def.trim().is_empty() => format!("{}\nGO\n", def.trim()),
        _ => format!(
            "-- skipped {}: definition is not available (WITH ENCRYPTION?)\n",
            mssql_qualify(&m.name)
        ),
    }
}

async fn mssql_load_tables(conn: &Connection, db: &str) -> Result<Vec<MssqlTable>> {
    let db_opt = Some(db);
    let collation_res = conn
        .execute(
            "SELECT CAST(DATABASEPROPERTYEX(DB_NAME(), 'Collation') AS nvarchar(128))",
            db_opt,
        )
        .await?;
    let db_collation = collation_res
        .rows
        .first()
        .and_then(|r| val_str(r.first()))
        .unwrap_or_default();

    let tables_res = conn
        .execute(
            "SELECT t.name FROM sys.tables t \
             JOIN sys.schemas s ON s.schema_id = t.schema_id \
             WHERE s.name = N'dbo' AND t.is_ms_shipped = 0 ORDER BY t.name",
            db_opt,
        )
        .await?;
    let mut tables: Vec<MssqlTable> = tables_res
        .rows
        .iter()
        .filter_map(|r| val_str(r.first()))
        .map(|name| MssqlTable {
            name,
            ..Default::default()
        })
        .collect();
    let find =
        |tables: &mut Vec<MssqlTable>, name: &str| tables.iter().position(|t| t.name == name);

    let cols_res = conn
        .execute(
            "SELECT t.name, c.name, \
                    CASE WHEN ty.is_user_defined = 1 THEN TYPE_NAME(c.system_type_id) ELSE ty.name END, \
                    CAST(c.max_length AS int), CAST(c.precision AS int), CAST(c.scale AS int), \
                    c.is_nullable, c.is_identity, \
                    CAST(ic.seed_value AS nvarchar(64)), CAST(ic.increment_value AS nvarchar(64)), \
                    cc.definition, cc.is_persisted, dc.name, dc.definition, c.collation_name \
             FROM sys.columns c \
             JOIN sys.tables t ON t.object_id = c.object_id \
             JOIN sys.schemas s ON s.schema_id = t.schema_id \
             JOIN sys.types ty ON ty.user_type_id = c.user_type_id \
             LEFT JOIN sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id \
             LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id \
             LEFT JOIN sys.default_constraints dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id \
             WHERE s.name = N'dbo' AND t.is_ms_shipped = 0 \
             ORDER BY t.name, c.column_id",
            db_opt,
        )
        .await?;
    for r in &cols_res.rows {
        let (Some(table), Some(name)) = (val_str(r.first()), val_str(r.get(1))) else {
            continue;
        };
        let Some(ti) = find(&mut tables, &table) else {
            continue;
        };
        let identity = if val_bool(r.get(7)) {
            Some((
                val_str(r.get(8)).unwrap_or_else(|| "1".into()),
                val_str(r.get(9)).unwrap_or_else(|| "1".into()),
            ))
        } else {
            None
        };
        let computed = val_str(r.get(10)).map(|d| (d, val_bool(r.get(11))));
        let default = match (val_str(r.get(12)), val_str(r.get(13))) {
            (Some(n), Some(d)) => Some((n, d)),
            _ => None,
        };
        let collation = val_str(r.get(14)).filter(|c| !c.eq_ignore_ascii_case(&db_collation));
        tables[ti].columns.push(MssqlColumn {
            name,
            type_name: val_str(r.get(2)).unwrap_or_default(),
            max_length: val_i64(r.get(3)).unwrap_or(0),
            precision: val_i64(r.get(4)).unwrap_or(0),
            scale: val_i64(r.get(5)).unwrap_or(0),
            nullable: val_bool(r.get(6)),
            identity,
            computed,
            default,
            collation,
        });
    }

    let keys_res = conn
        .execute(
            "SELECT t.name, kc.name, kc.type, i.type, c.name, ic.is_descending_key \
             FROM sys.key_constraints kc \
             JOIN sys.tables t ON t.object_id = kc.parent_object_id \
             JOIN sys.schemas s ON s.schema_id = t.schema_id \
             JOIN sys.indexes i ON i.object_id = kc.parent_object_id AND i.index_id = kc.unique_index_id \
             JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
             JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
             WHERE s.name = N'dbo' AND ic.is_included_column = 0 \
             ORDER BY t.name, kc.name, ic.key_ordinal",
            db_opt,
        )
        .await?;
    for r in &keys_res.rows {
        let (Some(table), Some(key), Some(col)) =
            (val_str(r.first()), val_str(r.get(1)), val_str(r.get(4)))
        else {
            continue;
        };
        let Some(ti) = find(&mut tables, &table) else {
            continue;
        };
        let primary = val_str(r.get(2)).is_some_and(|k| k.trim() == "PK");
        let clustered = val_i64(r.get(3)) == Some(1);
        let desc = val_bool(r.get(5));
        let keys = &mut tables[ti].keys;
        match keys.iter_mut().find(|k| k.name == key) {
            Some(k) => k.columns.push((col, desc)),
            None => keys.push(MssqlKey {
                name: key,
                primary,
                clustered,
                columns: vec![(col, desc)],
            }),
        }
    }

    let checks_res = conn
        .execute(
            "SELECT t.name, cc.name, cc.definition \
             FROM sys.check_constraints cc \
             JOIN sys.tables t ON t.object_id = cc.parent_object_id \
             JOIN sys.schemas s ON s.schema_id = t.schema_id \
             WHERE s.name = N'dbo' ORDER BY t.name, cc.name",
            db_opt,
        )
        .await?;
    for r in &checks_res.rows {
        let (Some(table), Some(name), Some(def)) =
            (val_str(r.first()), val_str(r.get(1)), val_str(r.get(2)))
        else {
            continue;
        };
        if let Some(ti) = find(&mut tables, &table) {
            tables[ti].checks.push((name, def));
        }
    }
    Ok(tables)
}

async fn mssql_load_indexes(conn: &Connection, db: &str) -> Result<Vec<MssqlIndex>> {
    let res = conn
        .execute(
            "SELECT t.name, i.name, i.is_unique, i.type, c.name, ic.is_descending_key, \
                    ic.is_included_column, i.filter_definition \
             FROM sys.indexes i \
             JOIN sys.tables t ON t.object_id = i.object_id \
             JOIN sys.schemas s ON s.schema_id = t.schema_id \
             JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
             JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
             WHERE s.name = N'dbo' AND t.is_ms_shipped = 0 AND i.is_primary_key = 0 \
               AND i.is_unique_constraint = 0 AND i.is_hypothetical = 0 AND i.type IN (1, 2) \
             ORDER BY t.name, i.name, ic.is_included_column, ic.key_ordinal, ic.index_column_id",
            Some(db),
        )
        .await?;
    let mut out: Vec<MssqlIndex> = Vec::new();
    for r in &res.rows {
        let (Some(table), Some(name), Some(col)) =
            (val_str(r.first()), val_str(r.get(1)), val_str(r.get(4)))
        else {
            continue;
        };
        let pos = out
            .iter()
            .position(|ix| ix.table == table && ix.name == name);
        let ix = match pos {
            Some(p) => &mut out[p],
            None => {
                out.push(MssqlIndex {
                    table,
                    name,
                    unique: val_bool(r.get(2)),
                    clustered: val_i64(r.get(3)) == Some(1),
                    filter: val_str(r.get(7)),
                    ..Default::default()
                });
                let last = out.len() - 1;
                &mut out[last]
            }
        };
        if val_bool(r.get(6)) {
            ix.included.push(col);
        } else {
            ix.key_columns.push((col, val_bool(r.get(5))));
        }
    }
    Ok(out)
}

async fn mssql_load_foreign_keys(conn: &Connection, db: &str) -> Result<Vec<MssqlForeignKey>> {
    let res = conn
        .execute(
            "SELECT fk.name, tp.name, cp.name, tr.name, cr.name, \
                    fk.delete_referential_action_desc, fk.update_referential_action_desc \
             FROM sys.foreign_keys fk \
             JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id \
             JOIN sys.tables tp ON tp.object_id = fkc.parent_object_id \
             JOIN sys.schemas sp ON sp.schema_id = tp.schema_id \
             JOIN sys.columns cp ON cp.object_id = fkc.parent_object_id AND cp.column_id = fkc.parent_column_id \
             JOIN sys.tables tr ON tr.object_id = fkc.referenced_object_id \
             JOIN sys.schemas sr ON sr.schema_id = tr.schema_id \
             JOIN sys.columns cr ON cr.object_id = fkc.referenced_object_id AND cr.column_id = fkc.referenced_column_id \
             WHERE sp.name = N'dbo' AND sr.name = N'dbo' \
             ORDER BY tp.name, fk.name, fkc.constraint_column_id",
            Some(db),
        )
        .await?;
    let mut out: Vec<MssqlForeignKey> = Vec::new();
    for r in &res.rows {
        let (Some(name), Some(table), Some(col), Some(rt), Some(rc)) = (
            val_str(r.first()),
            val_str(r.get(1)),
            val_str(r.get(2)),
            val_str(r.get(3)),
            val_str(r.get(4)),
        ) else {
            continue;
        };
        match out.iter_mut().find(|f| f.name == name && f.table == table) {
            Some(f) => {
                f.columns.push(col);
                f.referenced_columns.push(rc);
            }
            None => out.push(MssqlForeignKey {
                name,
                table,
                columns: vec![col],
                referenced_table: rt,
                referenced_columns: vec![rc],
                on_delete: val_str(r.get(5)).unwrap_or_default(),
                on_update: val_str(r.get(6)).unwrap_or_default(),
            }),
        }
    }
    Ok(out)
}

async fn mssql_load_modules(conn: &Connection, db: &str) -> Result<Vec<MssqlModule>> {
    let res = conn
        .execute(
            "SELECT o.name, RTRIM(o.type), m.definition \
             FROM sys.sql_modules m \
             JOIN sys.objects o ON o.object_id = m.object_id \
             JOIN sys.schemas s ON s.schema_id = o.schema_id \
             WHERE s.name = N'dbo' AND o.is_ms_shipped = 0 \
               AND RTRIM(o.type) IN ('V', 'P', 'FN', 'IF', 'TF', 'TR') \
             ORDER BY o.create_date, o.object_id",
            Some(db),
        )
        .await?;
    Ok(res
        .rows
        .iter()
        .filter_map(|r| {
            Some(MssqlModule {
                name: val_str(r.first())?,
                kind: val_str(r.get(1))?.trim().to_string(),
                definition: val_str(r.get(2)),
            })
        })
        .collect())
}

pub(crate) async fn dump_mssql<S: DumpSink + Send>(
    conn: &Connection,
    database: &str,
    opts: &NativeDumpOptions,
    sink: &mut S,
) -> Result<()> {
    let driver = DriverKind::Mssql;
    let db = database.trim();
    if db.is_empty() {
        return Err(AppError::InvalidInput("database name is empty".into()));
    }
    let tables = mssql_load_tables(conn, db).await?;
    let (indexes, fks, modules) = if opts.no_create_info {
        (Vec::new(), Vec::new(), Vec::new())
    } else {
        (
            mssql_load_indexes(conn, db).await?,
            mssql_load_foreign_keys(conn, db).await?,
            mssql_load_modules(conn, db).await?,
        )
    };
    let modules = mssql_selected_modules(&modules, opts);

    let mut head = format!(
        "-- noobDB native dump (Microsoft SQL Server)\n-- database: {db} (schema: {MSSQL_SCHEMA})\n\n\
         SET ANSI_NULLS ON;\nSET QUOTED_IDENTIFIER ON;\nGO\n"
    );
    if !opts.no_create_info {
        if opts.add_drop_table {
            // ビュー・ルーチン (スキーマバインドがテーブル削除を妨げうる) →
            // 外部キー → テーブルの順に落とす。
            for m in modules.iter().rev() {
                if let Some(kw) = m.drop_keyword() {
                    head.push_str(&format!(
                        "DROP {kw} IF EXISTS {};\n",
                        mssql_qualify(&m.name)
                    ));
                }
            }
            for fk in &fks {
                let fk_ident = quote_ident(driver, &fk.name);
                let object_name = format!("{MSSQL_SCHEMA}.{fk_ident}").replace('\'', "''");
                head.push_str(&format!(
                    "IF OBJECT_ID(N'{object_name}', N'F') IS NOT NULL \
                     ALTER TABLE {} DROP CONSTRAINT {fk_ident};\n",
                    mssql_qualify(&fk.table),
                ));
            }
            for t in &tables {
                head.push_str(&format!(
                    "DROP TABLE IF EXISTS {};\n",
                    mssql_qualify(&t.name)
                ));
            }
            head.push_str("GO\n");
        }
        head.push('\n');
        for t in &tables {
            head.push_str(&mssql_create_table(t));
        }
    }
    sink.write(&head)?;

    let total = tables.len() as u64;
    let batch = insert_batch(opts, driver);
    for (i, t) in tables.iter().enumerate() {
        if !opts.no_data {
            let columns = mssql_dump_columns(t);
            let identity_insert = t.columns.iter().any(|c| c.identity.is_some());
            let table = mssql_qualify(&t.name);
            let plan = InsertPlan {
                driver,
                table: &table,
                columns: &columns,
                batch,
                identity_insert,
            };
            stream_table_rows(conn, Some(db), &plan, sink).await?;
        }
        sink.table_done(i as u64 + 1, total);
    }

    if !opts.no_create_info {
        let mut tail = String::from("\n");
        for ix in &indexes {
            tail.push_str(&mssql_index_sql(ix));
        }
        for fk in &fks {
            tail.push_str(&mssql_foreign_key_sql(fk));
        }
        // 作成順 (create_date) のまま。トリガーはデータ投入後に作るので、復元時の
        // INSERT で発火しない。
        for m in &modules {
            tail.push_str(&mssql_module_sql(m));
        }
        sink.write(&tail)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numeric_literal_detection() {
        for ok in [
            "0",
            "-12",
            "+3",
            "3.50",
            ".5",
            "5.",
            "1e10",
            "-1.5E-3",
            "9223372036854775808",
        ] {
            assert!(is_numeric_literal(ok), "{ok}");
        }
        for ng in [
            "", "-", ".", "1e", "abc", "1 OR 1=1", "0x10", "1;DROP", "NaN", " 1",
        ] {
            assert!(!is_numeric_literal(ng), "{ng}");
        }
    }

    #[test]
    fn literal_null_is_null_for_every_render() {
        for r in [
            ColumnRender::Plain,
            ColumnRender::Numeric,
            ColumnRender::CastText("DATE".into()),
        ] {
            assert_eq!(dump_literal(DriverKind::DuckDb, &r, &Value::Null), "NULL");
            assert_eq!(dump_literal(DriverKind::Mssql, &r, &Value::Null), "NULL");
        }
    }

    #[test]
    fn literal_keeps_64bit_integers_exact_and_unquoted() {
        // 2^53 を超える BIGINT は from_i64_lossless で文字列として届く。
        let big = Value::from_i64_lossless(i64::MAX);
        assert!(matches!(big, Value::String(_)));
        assert_eq!(
            dump_literal(DriverKind::Mssql, &ColumnRender::Numeric, &big),
            "9223372036854775807"
        );
        let neg = Value::from_i64_lossless(i64::MIN);
        assert_eq!(
            dump_literal(DriverKind::DuckDb, &ColumnRender::Numeric, &neg),
            "-9223372036854775808"
        );
        let huge = Value::from_u128_lossless(u128::MAX);
        assert_eq!(
            dump_literal(DriverKind::DuckDb, &ColumnRender::Numeric, &huge),
            u128::MAX.to_string()
        );
        // 安全整数の範囲内は数値のまま。
        assert_eq!(
            dump_literal(DriverKind::Mssql, &ColumnRender::Numeric, &Value::Int(-7)),
            "-7"
        );
        // DECIMAL 文字列も引用符なし (精度を落とさない)。
        assert_eq!(
            dump_literal(
                DriverKind::Mssql,
                &ColumnRender::Numeric,
                &Value::String("12345678901234567890.123456".into())
            ),
            "12345678901234567890.123456"
        );
        // 数値の字面でない文字列は数値列でも必ずクオートする (注入させない)。
        assert_eq!(
            dump_literal(
                DriverKind::Mssql,
                &ColumnRender::Numeric,
                &Value::String("1); DROP TABLE t; --".into())
            ),
            "N'1); DROP TABLE t; --'"
        );
    }

    #[test]
    fn literal_strings_escape_quotes_per_driver() {
        let s = Value::String("it's \\ 日本語".into());
        assert_eq!(
            dump_literal(DriverKind::Mssql, &ColumnRender::Plain, &s),
            "N'it''s \\ 日本語'"
        );
        assert_eq!(
            dump_literal(DriverKind::DuckDb, &ColumnRender::Plain, &s),
            "'it''s \\ 日本語'"
        );
    }

    #[test]
    fn literal_binary_per_driver() {
        let b = Value::Bytes("00ff10".into());
        assert_eq!(
            dump_literal(DriverKind::Mssql, &ColumnRender::Plain, &b),
            "0x00ff10"
        );
        assert_eq!(
            dump_literal(DriverKind::DuckDb, &ColumnRender::Plain, &b),
            "'\\x00\\xff\\x10'::BLOB"
        );
        // 空の BLOB。
        let e = Value::Bytes(String::new());
        assert_eq!(
            dump_literal(DriverKind::Mssql, &ColumnRender::Plain, &e),
            "0x"
        );
        assert_eq!(
            dump_literal(DriverKind::DuckDb, &ColumnRender::Plain, &e),
            "''::BLOB"
        );
    }

    #[test]
    fn literal_dates_and_text_cast_types() {
        // DuckDB: テキスト経由の型は CAST で元の型へ戻す。
        let r = ColumnRender::CastText("TIMESTAMP WITH TIME ZONE".into());
        assert_eq!(
            dump_literal(
                DriverKind::DuckDb,
                &r,
                &Value::String("2024-01-02 03:04:05+09".into())
            ),
            "CAST('2024-01-02 03:04:05+09' AS TIMESTAMP WITH TIME ZONE)"
        );
        let r = ColumnRender::CastText("STRUCT(a INTEGER)".into());
        assert_eq!(
            dump_literal(DriverKind::DuckDb, &r, &Value::String("{'a': 1}".into())),
            "CAST('{''a'': 1}' AS STRUCT(a INTEGER))"
        );
        // MSSQL: 日時は ISO 文字列を N'...' で。
        assert_eq!(
            dump_literal(
                DriverKind::Mssql,
                &ColumnRender::Plain,
                &Value::String("2024-01-02T03:04:05.123".into())
            ),
            "N'2024-01-02T03:04:05.123'"
        );
    }

    #[test]
    fn literal_bool_and_float() {
        assert_eq!(
            dump_literal(DriverKind::Mssql, &ColumnRender::Plain, &Value::Bool(true)),
            "1"
        );
        assert_eq!(
            dump_literal(
                DriverKind::DuckDb,
                &ColumnRender::Plain,
                &Value::Bool(false)
            ),
            "FALSE"
        );
        assert_eq!(
            dump_literal(DriverKind::Mssql, &ColumnRender::Plain, &Value::Float(0.1)),
            "0.1"
        );
        assert_eq!(
            dump_literal(DriverKind::Mssql, &ColumnRender::Plain, &Value::Float(1.0)),
            "1.0"
        );
        // 極端な桁は指数表記 (MSSQL の 38 桁制限を超えない)。
        assert_eq!(
            dump_literal(
                DriverKind::Mssql,
                &ColumnRender::Plain,
                &Value::Float(1e300)
            ),
            "1e300"
        );
        assert_eq!(
            dump_literal(
                DriverKind::Mssql,
                &ColumnRender::Plain,
                &Value::Float(f64::NAN)
            ),
            "NULL"
        );
        assert_eq!(
            dump_literal(
                DriverKind::DuckDb,
                &ColumnRender::Plain,
                &Value::Float(f64::INFINITY)
            ),
            "'Infinity'"
        );
    }

    #[test]
    fn insert_plan_renders_batches_and_identity_insert() {
        let cols = vec![
            DumpColumn {
                name: "id".into(),
                select_expr: "[id]".into(),
                render: ColumnRender::Numeric,
            },
            DumpColumn {
                name: "na]me".into(),
                select_expr: "[na]]me]".into(),
                render: ColumnRender::Plain,
            },
        ];
        let plan = InsertPlan {
            driver: DriverKind::Mssql,
            table: "[dbo].[t]",
            columns: &cols,
            batch: 2,
            identity_insert: true,
        };
        assert_eq!(plan.select_sql(), "SELECT [id], [na]]me] FROM [dbo].[t]");
        let rows = vec![
            vec![Value::Int(1), Value::String("a".into())],
            vec![Value::Int(2), Value::Null],
            vec![Value::Int(3), Value::String("c".into())],
        ];
        assert_eq!(
            plan.render(&rows),
            "SET IDENTITY_INSERT [dbo].[t] ON;\n\
             INSERT INTO [dbo].[t] ([id], [na]]me]) VALUES\n  (1, N'a'),\n  (2, NULL);\n\
             SET IDENTITY_INSERT [dbo].[t] OFF;\nGO\n\
             SET IDENTITY_INSERT [dbo].[t] ON;\n\
             INSERT INTO [dbo].[t] ([id], [na]]me]) VALUES\n  (3, N'c');\n\
             SET IDENTITY_INSERT [dbo].[t] OFF;\nGO\n"
        );
        let duck_cols = vec![duckdb_column("we\"ird", "INTEGER")];
        let plan = InsertPlan {
            driver: DriverKind::DuckDb,
            table: "\"main\".\"t\"",
            columns: &duck_cols,
            batch: 100,
            identity_insert: false,
        };
        assert_eq!(
            plan.render(&[vec![Value::Int(1)], vec![Value::Int(2)]]),
            "INSERT INTO \"main\".\"t\" (\"we\"\"ird\") VALUES\n  (1),\n  (2);\n"
        );
    }

    #[test]
    fn duckdb_column_classification() {
        assert_eq!(duckdb_column("a", "BIGINT").render, ColumnRender::Numeric);
        assert_eq!(
            duckdb_column("a", "DECIMAL(18,3)").render,
            ColumnRender::Numeric
        );
        assert_eq!(duckdb_column("a", "VARCHAR").render, ColumnRender::Plain);
        assert_eq!(duckdb_column("a", "BLOB").render, ColumnRender::Plain);
        assert_eq!(duckdb_column("a", "BOOLEAN").select_expr, "\"a\"");
        let d = duckdb_column("a", "DATE");
        assert_eq!(d.select_expr, "CAST(\"a\" AS VARCHAR)");
        assert_eq!(d.render, ColumnRender::CastText("DATE".into()));
        assert_eq!(
            duckdb_column("a", "INTEGER[]").render,
            ColumnRender::CastText("INTEGER[]".into())
        );
        assert_eq!(
            duckdb_column("a", "STRUCT(a INTEGER)").render,
            ColumnRender::CastText("STRUCT(a INTEGER)".into())
        );
        assert_eq!(
            duckdb_column("a", "TIMESTAMP WITH TIME ZONE").render,
            ColumnRender::CastText("TIMESTAMP WITH TIME ZONE".into())
        );
    }

    #[test]
    fn duckdb_generated_columns_are_found_in_normalized_ddl() {
        // DuckDB が `duckdb_tables().sql` で返す正規化済み DDL の形。
        let ddl = "CREATE TABLE \"we(ird\"(id INTEGER DEFAULT(nextval('seq1')) PRIMARY KEY, \
                   \"na,me\" VARCHAR DEFAULT('GENERATED ALWAYS AS'), \
                   g INTEGER GENERATED ALWAYS AS((id * 2)), \
                   \"q \"\"x\"\"\" BIGINT GENERATED ALWAYS AS((id + 1)) VIRTUAL, \
                   CHECK((id > 0)));";
        assert_eq!(
            duckdb_generated_columns(ddl),
            vec!["g".to_string(), "q \"x\"".to_string()]
        );
        assert!(duckdb_generated_columns("CREATE TABLE t(a INTEGER, b VARCHAR);").is_empty());
        assert!(duckdb_generated_columns("garbage").is_empty());
    }

    #[test]
    fn duckdb_sequence_continues_after_last_value() {
        assert_eq!(
            duckdb_sequence_ddl("\"main\".\"s\"", 5, Some(6), 1, 1, i64::MAX, false),
            format!(
                "CREATE SEQUENCE \"main\".\"s\" INCREMENT BY 1 MINVALUE 1 MAXVALUE {} START WITH 7 NO CYCLE;\n",
                i64::MAX
            )
        );
        // 未使用なら元の START。
        assert!(duckdb_sequence_ddl("s", 5, None, 1, 1, 100, true).contains("START WITH 5 CYCLE"));
        // 使い切っていても範囲内に丸める。
        assert!(duckdb_sequence_ddl("s", 1, Some(100), 1, 1, 100, false).contains("START WITH 100"));
    }

    #[test]
    fn dependency_order_puts_parents_first() {
        let tables: Vec<String> = ["a_child", "b_parent", "c_grand", "d_self"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let edges = vec![
            ("a_child".to_string(), "b_parent".to_string()),
            ("b_parent".to_string(), "c_grand".to_string()),
            ("d_self".to_string(), "d_self".to_string()),
            ("a_child".to_string(), "missing".to_string()),
        ];
        assert_eq!(
            order_tables_by_dependencies(&tables, &edges),
            vec!["c_grand", "b_parent", "a_child", "d_self"]
        );
        // 循環は末尾に入力順で残す。
        let t2: Vec<String> = ["x", "y", "z"].iter().map(|s| s.to_string()).collect();
        let cyc = vec![
            ("x".to_string(), "y".to_string()),
            ("y".to_string(), "x".to_string()),
        ];
        assert_eq!(order_tables_by_dependencies(&t2, &cyc), vec!["z", "x", "y"]);
    }

    #[test]
    fn mssql_type_rendering() {
        assert_eq!(mssql_type_sql("nvarchar", 100, 0, 0), "nvarchar(50)");
        assert_eq!(mssql_type_sql("nvarchar", -1, 0, 0), "nvarchar(max)");
        assert_eq!(mssql_type_sql("varbinary", -1, 0, 0), "varbinary(max)");
        assert_eq!(mssql_type_sql("char", 10, 0, 0), "char(10)");
        assert_eq!(mssql_type_sql("decimal", 9, 10, 2), "decimal(10,2)");
        assert_eq!(mssql_type_sql("datetime2", 8, 27, 7), "datetime2(7)");
        assert_eq!(mssql_type_sql("float", 8, 53, 0), "float");
        assert_eq!(mssql_type_sql("float", 4, 24, 0), "float(24)");
        assert_eq!(mssql_type_sql("timestamp", 8, 0, 0), "rowversion");
        assert_eq!(mssql_type_sql("BIGINT", 8, 19, 0), "bigint");
    }

    fn sample_table() -> MssqlTable {
        MssqlTable {
            name: "or]ders".into(),
            columns: vec![
                MssqlColumn {
                    name: "id".into(),
                    type_name: "bigint".into(),
                    max_length: 8,
                    precision: 19,
                    nullable: false,
                    identity: Some(("1".into(), "1".into())),
                    ..Default::default()
                },
                MssqlColumn {
                    name: "name".into(),
                    type_name: "nvarchar".into(),
                    max_length: 200,
                    nullable: true,
                    default: Some(("DF_name".into(), "(N'x')".into())),
                    collation: Some("Japanese_CI_AS".into()),
                    ..Default::default()
                },
                MssqlColumn {
                    name: "total".into(),
                    type_name: "int".into(),
                    computed: Some(("([id]*(2))".into(), true)),
                    ..Default::default()
                },
                MssqlColumn {
                    name: "rv".into(),
                    type_name: "timestamp".into(),
                    max_length: 8,
                    ..Default::default()
                },
                MssqlColumn {
                    name: "at".into(),
                    type_name: "datetime".into(),
                    nullable: true,
                    ..Default::default()
                },
                MssqlColumn {
                    name: "price".into(),
                    type_name: "money".into(),
                    nullable: true,
                    ..Default::default()
                },
            ],
            keys: vec![MssqlKey {
                name: "PK_orders".into(),
                primary: true,
                clustered: true,
                columns: vec![("id".into(), false)],
            }],
            checks: vec![("CK_id".into(), "([id]>(0))".into())],
        }
    }

    #[test]
    fn mssql_create_table_ddl() {
        assert_eq!(
            mssql_create_table(&sample_table()),
            "CREATE TABLE [dbo].[or]]ders] (\n  \
             [id] bigint IDENTITY(1,1) NOT NULL,\n  \
             [name] nvarchar(100) COLLATE Japanese_CI_AS NULL CONSTRAINT [DF_name] DEFAULT (N'x'),\n  \
             [total] AS ([id]*(2)) PERSISTED,\n  \
             [rv] rowversion NOT NULL,\n  \
             [at] datetime NULL,\n  \
             [price] money NULL,\n  \
             CONSTRAINT [PK_orders] PRIMARY KEY CLUSTERED ([id] ASC),\n  \
             CONSTRAINT [CK_id] CHECK ([id]>(0))\n);\nGO\n"
        );
    }

    #[test]
    fn mssql_dump_columns_skip_computed_and_rowversion() {
        let cols = mssql_dump_columns(&sample_table());
        let names: Vec<&str> = cols.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["id", "name", "at", "price"]);
        assert_eq!(cols[0].render, ColumnRender::Numeric);
        assert_eq!(cols[2].select_expr, "CONVERT(nvarchar(40), [at], 126)");
        assert_eq!(cols[3].select_expr, "CONVERT(nvarchar(40), [price], 2)");
        assert_eq!(cols[3].render, ColumnRender::Numeric);
    }

    #[test]
    fn mssql_index_fk_and_module_sql() {
        let ix = MssqlIndex {
            table: "t".into(),
            name: "IX_t".into(),
            unique: true,
            clustered: false,
            key_columns: vec![("a".into(), false), ("b".into(), true)],
            included: vec!["c".into()],
            filter: Some("([a] IS NOT NULL)".into()),
        };
        assert_eq!(
            mssql_index_sql(&ix),
            "CREATE UNIQUE NONCLUSTERED INDEX [IX_t] ON [dbo].[t] ([a] ASC, [b] DESC) \
             INCLUDE ([c]) WHERE ([a] IS NOT NULL);\nGO\n"
        );
        let fk = MssqlForeignKey {
            name: "FK_c_p".into(),
            table: "c".into(),
            columns: vec!["pid".into()],
            referenced_table: "p".into(),
            referenced_columns: vec!["id".into()],
            on_delete: "CASCADE".into(),
            on_update: "NO_ACTION".into(),
        };
        assert_eq!(
            mssql_foreign_key_sql(&fk),
            "ALTER TABLE [dbo].[c] ADD CONSTRAINT [FK_c_p] FOREIGN KEY ([pid]) \
             REFERENCES [dbo].[p] ([id]) ON DELETE CASCADE;\nGO\n"
        );
        let m = MssqlModule {
            name: "v".into(),
            kind: "V".into(),
            definition: Some("CREATE VIEW dbo.v AS SELECT 1 AS x;\n".into()),
        };
        assert_eq!(
            mssql_module_sql(&m),
            "CREATE VIEW dbo.v AS SELECT 1 AS x;\nGO\n"
        );
        let enc = MssqlModule {
            name: "p".into(),
            kind: "P".into(),
            definition: None,
        };
        assert!(mssql_module_sql(&enc).starts_with("-- skipped [dbo].[p]"));

        let mods = vec![
            m.clone(),
            enc.clone(),
            MssqlModule {
                name: "tr".into(),
                kind: "TR".into(),
                definition: Some("CREATE TRIGGER x".into()),
            },
        ];
        let opts = NativeDumpOptions {
            routines: false,
            triggers: false,
            ..Default::default()
        };
        let sel = mssql_selected_modules(&mods, &opts);
        assert_eq!(sel.len(), 1);
        assert!(sel[0].is_view());
        assert_eq!(
            mssql_selected_modules(&mods, &NativeDumpOptions::default()).len(),
            3
        );
    }
}
