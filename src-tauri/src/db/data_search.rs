//! DB 全体からの値検索 (#748) の走査 SQL 生成 (#1261 で Rust へ移植)。
//!
//! 「この値はどのテーブル・どの列にあるか」を調べるため、列ごとの述語
//! (`buildColumnPredicate`) を 1 テーブル 1 クエリの `SUM(CASE WHEN … THEN 1 ELSE 0 END)`
//! にまとめる (`buildTableScanSql`)。以前はフロント (`components/dataSearch.ts`) が
//! テーブルごとに生成して直列に発行していたが、Rust 側で生成・並列実行する。
//!
//! 述語の生成は、ヒット行クリック時のジャンプ SQL (`buildColumnJumpSql` /
//! `buildTableJumpSql`、フロントに残る) と同じ規則でなければならない。二重実装は
//! 共有ゴールデン `src/__tests__/fixtures/dataSearchVectors.json` が両側で固定する。

use serde::{Deserialize, Serialize};

use super::js_compat::js_number_to_string;
use super::sync::quote_ident;
use super::types::Value;
use super::DriverKind;

/// 一致モード: 完全一致 / 部分一致 (contains) / 前方一致。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MatchMode {
    Exact,
    Contains,
    Prefix,
}

/// 結果グリッドの列を分類する型タグ (`cellTypeMeta.ts` の `CellKind`)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CellKind {
    Number,
    Decimal,
    Bool,
    Date,
    Time,
    Json,
    Enum,
    Binary,
    String,
}

/// 生の型名 (`TableColumnInfo.data_type`) を [`CellKind`] へ分類する。
/// `cellTypeMeta.ts::classifyTypeName` と同一 (大文字化して完全一致で比較する。
/// `varchar(255)` のような長さ付きの型名は集合に無いので `String` になる)。
pub fn classify_type_name(type_name: &str) -> CellKind {
    let t = type_name.to_uppercase();
    match t.as_str() {
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "INTEGER" | "BIGINT" | "YEAR" | "FLOAT"
        | "DOUBLE" | "REAL" | "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "MEDIUMINT UNSIGNED"
        | "INT UNSIGNED" | "BIGINT UNSIGNED" | "INT2" | "INT4" | "INT8" | "FLOAT4" | "FLOAT8" => {
            CellKind::Number
        }
        "DECIMAL" | "NEWDECIMAL" | "NUMERIC" => CellKind::Decimal,
        "BOOLEAN" | "BOOL" => CellKind::Bool,
        "DATE" | "DATETIME" | "TIMESTAMP" | "TIMESTAMPTZ" => CellKind::Date,
        "TIME" | "TIMETZ" => CellKind::Time,
        "JSON" | "JSONB" => CellKind::Json,
        "ENUM" | "SET" => CellKind::Enum,
        "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" | "BINARY" | "VARBINARY" | "BYTEA" => {
            CellKind::Binary
        }
        _ => CellKind::String,
    }
}

/// PostgreSQL で `LIKE` / `=` による文字列比較が成立する型名 (大文字化・長さ指定除去後)。
const PG_TEXT_TYPES: &[&str] = &[
    "TEXT",
    "VARCHAR",
    "CHARACTER VARYING",
    "CHAR",
    "CHARACTER",
    "BPCHAR",
    "NAME",
    "CITEXT",
];

/// PostgreSQL の整数・浮動小数の型名 (`information_schema` / `format_type` の表記)。
const PG_NUMBER_TYPES: &[&str] = &[
    "SMALLINT",
    "INTEGER",
    "BIGINT",
    "INT2",
    "INT4",
    "INT8",
    "REAL",
    "DOUBLE PRECISION",
    "FLOAT4",
    "FLOAT8",
];

/// 走査用の型分類。MySQL / SQLite は [`classify_type_name`] そのまま。PostgreSQL は
/// `LIKE` が使えない型 (uuid・timestamp・bytea・json/jsonb・enum=`USER-DEFINED`・配列 …) を
/// 文字列扱いすると表ごと SQL エラーになるため、`information_schema` の型名
/// (`double precision` / `numeric(10,2)` / `timestamp without time zone` など) を解釈し、
/// 文字列として比較できる型以外は走査対象外 (`Binary`) にする。
/// フロントの `dataSearch.ts::searchKindFor` と同一規則 (共有ゴールデンで固定)。
pub fn classify_for_search(driver: DriverKind, type_name: &str) -> CellKind {
    let kind = classify_type_name(type_name);
    if driver != DriverKind::Postgres {
        return kind;
    }
    if !matches!(kind, CellKind::String | CellKind::Json | CellKind::Enum) {
        return kind;
    }
    // `numeric(10,2)` などの括弧を除き、空白を畳んで大文字化する。
    let mut base = String::new();
    let mut depth = 0u32;
    for ch in type_name.chars() {
        match ch {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            c if depth == 0 => base.push(c),
            _ => {}
        }
    }
    let base = base
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_uppercase();
    if base == "NUMERIC" || base == "DECIMAL" {
        CellKind::Decimal
    } else if PG_NUMBER_TYPES.contains(&base.as_str()) {
        CellKind::Number
    } else if PG_TEXT_TYPES.contains(&base.as_str()) || base.is_empty() {
        CellKind::String
    } else {
        CellKind::Binary
    }
}

/// 走査における列の扱い。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchTarget {
    /// LIKE / 完全一致の対象 (文字列・ENUM・JSON)。
    Text,
    /// 検索語が数値のときだけ等価比較の対象 (整数・小数)。
    Numeric,
    /// 既定で走査対象外 (BLOB・真偽値・日時)。
    Excluded,
}

pub fn search_target_for_kind(kind: CellKind) -> SearchTarget {
    match kind {
        CellKind::String | CellKind::Enum | CellKind::Json => SearchTarget::Text,
        CellKind::Number | CellKind::Decimal => SearchTarget::Numeric,
        _ => SearchTarget::Excluded,
    }
}

/// 検索語が数値リテラルとして解釈できるか。
/// `/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i` を `trim()` した語に当てる。
pub fn is_numeric_term(term: &str) -> bool {
    let t = super::object_search::js_trim(term).as_bytes();
    let mut i = 0;
    if t.get(i) == Some(&b'-') {
        i += 1;
    }
    let digits = |i: &mut usize| -> bool {
        let start = *i;
        while t.get(*i).is_some_and(u8::is_ascii_digit) {
            *i += 1;
        }
        *i > start
    };
    if !digits(&mut i) {
        return false;
    }
    if t.get(i) == Some(&b'.') {
        i += 1;
        if !digits(&mut i) {
            return false;
        }
    }
    if matches!(t.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(t.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        if !digits(&mut i) {
            return false;
        }
    }
    i == t.len()
}

/// 数値検索語を SQL へ埋め込む数値リテラルへ正規化する。
///
/// 整数表記 (`-?\d+`) は f64 を通さず 10 進文字列のまま埋め込む (2^53 超の BIGINT ID が
/// 丸められて別の行にヒットするのを防ぐ)。先頭の 0 は除き `-0` は `0` にする。小数・指数表記は
/// f64 経由 (JS の `Number()` → 文字列化と同じ表記) だが、`1e400` のように有限でなくなる語は
/// `Infinity` という識別子を SQL に出してしまうので `None` (その列は走査しない)。
pub fn numeric_literal(term: &str) -> Option<String> {
    if !is_numeric_term(term) {
        return None;
    }
    let t = super::object_search::js_trim(term);
    let (neg, digits) = match t.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, t),
    };
    if digits.bytes().all(|b| b.is_ascii_digit()) {
        let trimmed = digits.trim_start_matches('0');
        if trimmed.is_empty() {
            return Some("0".to_string());
        }
        return Some(format!("{}{trimmed}", if neg { "-" } else { "" }));
    }
    let n: f64 = t.parse().ok()?;
    if !n.is_finite() {
        return None;
    }
    Some(js_number_to_string(n))
}

/// LIKE パターン中のワイルドカード (`%` `_`) とエスケープ文字自身をエスケープする。
pub fn escape_like_wildcards(term: &str) -> String {
    term.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// 文字列リテラルのクオート (`cellEdit.ts::quoteString` と同じ): シングルクォートは
/// 全方言で二重化、バックスラッシュは MySQL だけ二重化する。
fn quote_string(driver: DriverKind, s: &str) -> String {
    let escaped = match driver {
        DriverKind::Mysql => s.replace('\\', "\\\\").replace('\'', "''"),
        DriverKind::Postgres | DriverKind::Sqlite => s.replace('\'', "''"),
    };
    format!("'{escaped}'")
}

/// 1 列ぶんの検索述語 (WHERE の断片) を生成する。走査対象外の型・数値列に対する
/// 非数値検索語など、意味のない組み合わせは `None` を返す。
///
/// - text 列: `exact` は `=`、`contains`/`prefix` は `LIKE` (ワイルドカードをエスケープし、
///   SQLite でも効くよう常に明示的な `ESCAPE` 句を付ける)。
/// - numeric 列: 検索語が数値のときだけ `=` で等価比較 (一致モードは無視)。
pub fn build_column_predicate(
    driver: DriverKind,
    column_name: &str,
    kind: CellKind,
    term: &str,
    mode: MatchMode,
) -> Option<String> {
    let target = search_target_for_kind(kind);
    if target == SearchTarget::Excluded {
        return None;
    }
    let col = quote_ident(driver, column_name);
    if target == SearchTarget::Numeric {
        if !is_numeric_term(term) {
            return None;
        }
        let literal = numeric_literal(term)?;
        return Some(format!("{col} = {literal}"));
    }
    let escape_clause = format!("ESCAPE {}", quote_string(driver, "\\"));
    Some(match mode {
        MatchMode::Exact => format!("{col} = {}", quote_string(driver, term)),
        MatchMode::Prefix => format!(
            "{col} LIKE {} {escape_clause}",
            quote_string(driver, &format!("{}%", escape_like_wildcards(term)))
        ),
        MatchMode::Contains => format!(
            "{col} LIKE {} {escape_clause}",
            quote_string(driver, &format!("%{}%", escape_like_wildcards(term)))
        ),
    })
}

/// テーブル参照の DB 修飾 (`fkNavigation.ts::qualifiedTable`)。SQLite と DB 名が空のときは修飾しない。
pub fn qualified_table(driver: DriverKind, database: Option<&str>, table: &str) -> String {
    match database {
        Some(db) if driver != DriverKind::Sqlite && !db.is_empty() => {
            format!("{}.{}", quote_ident(driver, db), quote_ident(driver, table))
        }
        _ => quote_ident(driver, table),
    }
}

/// 走査対象として列名と生の型名だけが要る。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScanColumn {
    pub name: String,
    #[serde(rename = "dataType")]
    pub data_type: String,
}

/// {@link build_table_scan_sql} の戻り値。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableScanSql {
    /// テーブル 1 つを 1 回のクエリで走査する SQL。
    pub sql: String,
    /// SELECT リストと同じ順序の列名 (結果行を位置で対応付けるため)。
    pub columns: Vec<String>,
}

/// テーブル 1 つぶんの走査 SQL を生成する。列ごとに `SUM(CASE WHEN <述語> THEN 1 ELSE 0 END)`
/// を並べた単一クエリで、1 回のフルスキャンで列ごとのヒット件数をまとめて取得する。
/// 走査対象の列が 1 つもなければ `None` (呼び出し側はテーブルをスキップ扱いにする)。
pub fn build_table_scan_sql(
    driver: DriverKind,
    database: Option<&str>,
    table: &str,
    columns: &[ScanColumn],
    term: &str,
    mode: MatchMode,
) -> Option<TableScanSql> {
    let mut parts: Vec<(&str, String)> = Vec::new();
    for c in columns {
        if let Some(predicate) = build_column_predicate(
            driver,
            &c.name,
            classify_for_search(driver, &c.data_type),
            term,
            mode,
        ) {
            parts.push((c.name.as_str(), predicate));
        }
    }
    if parts.is_empty() {
        return None;
    }
    let select_list = parts
        .iter()
        .map(|(name, predicate)| {
            format!(
                "SUM(CASE WHEN {predicate} THEN 1 ELSE 0 END) AS {}",
                quote_ident(driver, name)
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    Some(TableScanSql {
        sql: format!(
            "SELECT {select_list} FROM {}",
            qualified_table(driver, database, table)
        ),
        columns: parts.iter().map(|(n, _)| (*n).to_string()).collect(),
    })
}

/// 概算行数がしきい値を超えるテーブルをスキャン対象から除外すべきか。推定値が取れない
/// (`None`) 場合は保守的に「除外しない」。
pub fn should_skip_table_for_scan(estimate: Option<i64>, threshold_rows: i64) -> bool {
    estimate.is_some_and(|e| e > threshold_rows)
}

/// 列ごとのヒット件数 (件数 0 の列は含めない)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ColumnHit {
    pub column: String,
    pub count: f64,
}

/// JS の `Number(raw)` に相当する変換。数値として解釈できなければ `None`。
fn value_to_number(v: &Value) -> Option<f64> {
    match v {
        Value::Null => Some(0.0),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::Int(i) => Some(*i as f64),
        Value::UInt(u) => Some(*u as f64),
        Value::Float(f) => Some(*f),
        Value::String(s) => {
            let t = super::object_search::js_trim(s);
            if t.is_empty() {
                Some(0.0)
            } else {
                t.parse::<f64>().ok()
            }
        }
        Value::Bytes(_) => None,
    }
}

/// `build_table_scan_sql` が返した列順の 1 行 (`SUM(CASE...)` の結果) を、列ごとの
/// ヒット件数配列へ変換する。`SUM` は対象行が 0 件だと `NULL` を返すドライバがあるため、
/// `NULL` / 欠けは 0 件として扱う。件数 0 の列は除外する。
pub fn parse_scan_row(columns: &[String], row: &[Value]) -> Vec<ColumnHit> {
    let mut hits = Vec::new();
    for (i, column) in columns.iter().enumerate() {
        let count = match row.get(i) {
            None => 0.0,
            Some(v) => value_to_number(v).unwrap_or(f64::NAN),
        };
        if count.is_finite() && count > 0.0 {
            hits.push(ColumnHit {
                column: column.clone(),
                count,
            });
        }
    }
    hits
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numeric_literal_keeps_64bit_integers_exact_and_rejects_overflow() {
        assert_eq!(
            numeric_literal("9007199254740993").as_deref(),
            Some("9007199254740993")
        );
        assert_eq!(
            numeric_literal(" -9223372036854775808 ").as_deref(),
            Some("-9223372036854775808")
        );
        assert_eq!(numeric_literal("007").as_deref(), Some("7"));
        assert_eq!(numeric_literal("-0").as_deref(), Some("0"));
        assert_eq!(numeric_literal("1.50").as_deref(), Some("1.5"));
        assert_eq!(numeric_literal("1e400"), None);
        assert_eq!(numeric_literal("abc"), None);
    }

    #[test]
    fn postgres_non_text_types_are_not_searched_as_text() {
        let pg = DriverKind::Postgres;
        for t in [
            "uuid",
            "timestamp without time zone",
            "timestamp with time zone",
            "bytea",
            "jsonb",
            "USER-DEFINED",
            "ARRAY",
        ] {
            assert_eq!(classify_for_search(pg, t), CellKind::Binary, "{t}");
        }
        assert_eq!(
            classify_for_search(pg, "double precision"),
            CellKind::Number
        );
        assert_eq!(classify_for_search(pg, "numeric(10,2)"), CellKind::Decimal);
        assert_eq!(
            classify_for_search(pg, "character varying(50)"),
            CellKind::String
        );
        // MySQL / SQLite は従来どおり。
        assert_eq!(
            classify_for_search(DriverKind::Mysql, "uuid"),
            CellKind::String
        );
        assert_eq!(
            classify_for_search(DriverKind::Sqlite, ""),
            CellKind::String
        );
    }

    #[test]
    fn numeric_term_detection() {
        for ok in ["42", "-3.14", "1e10", " 7 ", "1E+5", "0"] {
            assert!(is_numeric_term(ok), "{ok}");
        }
        for ng in ["abc", "42abc", "", "1.", ".5", "--1", "1e", "+1"] {
            assert!(!is_numeric_term(ng), "{ng}");
        }
    }

    #[test]
    fn predicates_match_the_documented_shapes() {
        let p = |d, c, k, t, m| build_column_predicate(d, c, k, t, m);
        assert_eq!(
            p(
                DriverKind::Mysql,
                "name",
                CellKind::String,
                "Alice",
                MatchMode::Exact
            )
            .as_deref(),
            Some("`name` = 'Alice'")
        );
        assert_eq!(
            p(
                DriverKind::Mysql,
                "name",
                CellKind::String,
                "ali",
                MatchMode::Contains
            )
            .as_deref(),
            Some("`name` LIKE '%ali%' ESCAPE '\\\\'")
        );
        assert_eq!(
            p(
                DriverKind::Postgres,
                "name",
                CellKind::String,
                "ali",
                MatchMode::Prefix
            )
            .as_deref(),
            Some("\"name\" LIKE 'ali%' ESCAPE '\\'")
        );
        assert_eq!(
            p(
                DriverKind::Mysql,
                "age",
                CellKind::Number,
                "42",
                MatchMode::Contains
            )
            .as_deref(),
            Some("`age` = 42")
        );
        assert_eq!(
            p(
                DriverKind::Mysql,
                "age",
                CellKind::Number,
                "abc",
                MatchMode::Exact
            ),
            None
        );
        assert_eq!(
            p(
                DriverKind::Mysql,
                "photo",
                CellKind::Binary,
                "abc",
                MatchMode::Exact
            ),
            None
        );
    }

    #[test]
    fn scan_sql_selects_only_searchable_columns() {
        let cols = vec![
            ScanColumn {
                name: "name".into(),
                data_type: "VARCHAR".into(),
            },
            ScanColumn {
                name: "age".into(),
                data_type: "INT".into(),
            },
            ScanColumn {
                name: "photo".into(),
                data_type: "BLOB".into(),
            },
        ];
        let scan = build_table_scan_sql(
            DriverKind::Mysql,
            Some("shop"),
            "users",
            &cols,
            "ali",
            MatchMode::Contains,
        );
        assert_eq!(
            scan,
            Some(TableScanSql {
                sql: "SELECT SUM(CASE WHEN `name` LIKE '%ali%' ESCAPE '\\\\' THEN 1 ELSE 0 END) AS `name` FROM `shop`.`users`".into(),
                columns: vec!["name".into()],
            })
        );
        let numeric = build_table_scan_sql(
            DriverKind::Sqlite,
            Some("main"),
            "users",
            &cols,
            "42",
            MatchMode::Contains,
        );
        assert_eq!(
            numeric.map(|s| s.columns),
            Some(vec!["name".to_string(), "age".to_string()])
        );
    }

    #[test]
    fn parse_scan_row_drops_zero_and_null() {
        let cols = vec![
            "a".to_string(),
            "b".to_string(),
            "c".to_string(),
            "d".to_string(),
        ];
        let row = vec![
            Value::Int(3),
            Value::Null,
            Value::String("2".into()),
            Value::Int(0),
        ];
        let hits = parse_scan_row(&cols, &row);
        assert_eq!(
            hits,
            vec![
                ColumnHit {
                    column: "a".into(),
                    count: 3.0
                },
                ColumnHit {
                    column: "c".into(),
                    count: 2.0
                },
            ]
        );
    }
}
