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
        | "INT UNSIGNED" | "BIGINT UNSIGNED" => CellKind::Number,
        "DECIMAL" | "NEWDECIMAL" | "NUMERIC" => CellKind::Decimal,
        "BOOLEAN" | "BOOL" => CellKind::Bool,
        "DATE" | "DATETIME" | "TIMESTAMP" => CellKind::Date,
        "TIME" => CellKind::Time,
        "JSON" | "JSONB" => CellKind::Json,
        "ENUM" | "SET" => CellKind::Enum,
        "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" | "BINARY" | "VARBINARY" => {
            CellKind::Binary
        }
        _ => CellKind::String,
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

/// JS の `Number.prototype.toString()` (10 進) と同じ表記。`f64::to_string` は指数
/// 表記を使わないため (`1e21` が `1000000000000000000000` になる) 自前で組み立てる。
pub fn js_number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".to_string();
    }
    if x == 0.0 {
        return "0".to_string();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    let sign = if x < 0.0 { "-" } else { "" };
    // `{:e}` は最短の有効数字列を `d.ddde±x` 形式で返す。
    let sci = format!("{:e}", x.abs());
    let (mantissa, exp) = sci.split_once('e').unwrap_or((sci.as_str(), "0"));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let exp: i32 = exp.parse().unwrap_or(0);
    let k = digits.len() as i32;
    // 値 = 0.digits × 10^n
    let n = exp + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let e_sign = if e < 0 { "-" } else { "+" };
        if k == 1 {
            format!("{digits}e{e_sign}{}", e.abs())
        } else {
            format!("{}.{}e{e_sign}{}", &digits[..1], &digits[1..], e.abs())
        }
    };
    format!("{sign}{body}")
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
        let n: f64 = super::object_search::js_trim(term).parse().ok()?;
        return Some(format!("{col} = {}", js_number_to_string(n)));
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
            classify_type_name(&c.data_type),
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
    fn js_number_formatting_matches_ecmascript() {
        let cases = [
            (42.0, "42"),
            (-2.75, "-2.75"),
            (1e10, "10000000000"),
            (7.0, "7"),
            (1.5, "1.5"),
            (1e21, "1e+21"),
            (1e-7, "1e-7"),
            (0.000001, "0.000001"),
            (1.5e-7, "1.5e-7"),
            (123456789012345680000.0, "123456789012345680000"),
            (1.2345e25, "1.2345e+25"),
            (-0.0, "0"),
        ];
        for (x, want) in cases {
            assert_eq!(js_number_to_string(x), want, "{x:e}");
        }
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
