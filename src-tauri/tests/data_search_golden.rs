//! DB 全体からの値検索 (#748 / #1261) の走査 SQL 生成の実装横断ゴールデンテスト — バック側。
//!
//! 列ごとの述語・テーブル単位の `SUM(CASE …)` クエリ・しきい値判定・結果 1 行のパースは
//! 旧フロント実装 (`components/dataSearch.ts`) から Rust へ移植した。期待値は移植前の TS
//! 実装 (`src/__tests__/oracles/dataSearchOracle.ts`) の出力で、フロント側の
//! `dataSearchGolden.test.ts` がオラクルと、フロントに残る `buildColumnPredicate` (ヒット行
//! のジャンプ SQL 用) との一致を、ここが Rust 実装との一致を、同じ `dataSearchVectors.json`
//! に対して検証する。数値語は JS の `Number()` → 文字列化と同じ表記で埋め込まれる。

use noobdb_lib::__test_api as t;
use serde::Deserialize;

const VECTORS_JSON: &str = include_str!("../../src/__tests__/fixtures/dataSearchVectors.json");

#[derive(Deserialize)]
struct Vectors {
    classify: Vec<Classify>,
    predicates: Vec<Predicate>,
    #[serde(rename = "numericTerms")]
    numeric_terms: Vec<NumericTerm>,
    #[serde(rename = "scanSql")]
    scan_sql: Vec<ScanSql>,
    skip: Vec<Skip>,
    #[serde(rename = "parseRow")]
    parse_row: Vec<ParseRow>,
}

#[derive(Deserialize)]
struct Classify {
    #[serde(rename = "dataType")]
    data_type: String,
    kind: String,
    target: String,
}

#[derive(Deserialize)]
struct Predicate {
    driver: String,
    column: String,
    #[serde(rename = "dataType")]
    data_type: String,
    term: String,
    mode: t::MatchMode,
    expected: Option<String>,
}

#[derive(Deserialize)]
struct NumericTerm {
    term: String,
    expected: bool,
}

#[derive(Deserialize)]
struct ScanSql {
    driver: String,
    database: Option<String>,
    table: String,
    columns: Vec<t::ScanColumn>,
    term: String,
    mode: t::MatchMode,
    expected: Option<ExpectedScan>,
}

#[derive(Deserialize)]
struct ExpectedScan {
    sql: String,
    columns: Vec<String>,
}

#[derive(Deserialize)]
struct Skip {
    estimate: Option<i64>,
    threshold: i64,
    expected: bool,
}

#[derive(Deserialize)]
struct ParseRow {
    columns: Vec<String>,
    row: Vec<serde_json::Value>,
    expected: Vec<ExpectedHit>,
}

#[derive(Deserialize)]
struct ExpectedHit {
    column: String,
    count: f64,
}

fn load() -> Vectors {
    serde_json::from_str(VECTORS_JSON).expect("shared data search vectors must be valid JSON")
}

fn driver_of(name: &str) -> t::DriverKind {
    t::DriverKind::parse(name).unwrap_or_else(|| panic!("unknown driver {name}"))
}

fn kind_name(kind: t::CellKind) -> &'static str {
    match kind {
        t::CellKind::Number => "number",
        t::CellKind::Decimal => "decimal",
        t::CellKind::Bool => "bool",
        t::CellKind::Date => "date",
        t::CellKind::Time => "time",
        t::CellKind::Json => "json",
        t::CellKind::Enum => "enum",
        t::CellKind::Binary => "binary",
        t::CellKind::String => "string",
    }
}

fn target_name(target: t::SearchTarget) -> &'static str {
    match target {
        t::SearchTarget::Text => "text",
        t::SearchTarget::Numeric => "numeric",
        t::SearchTarget::Excluded => "excluded",
    }
}

#[test]
fn type_classification_matches_the_shared_vectors() {
    for c in &load().classify {
        let kind = t::classify_type_name(&c.data_type);
        assert_eq!(kind_name(kind), c.kind, "kind of {:?}", c.data_type);
        assert_eq!(
            target_name(t::search_target_for_kind(kind)),
            c.target,
            "target of {:?}",
            c.data_type
        );
    }
}

#[test]
fn column_predicates_match_the_shared_vectors() {
    let vectors = load();
    assert!(vectors.predicates.len() > 100);
    for p in &vectors.predicates {
        let actual = t::build_column_predicate(
            driver_of(&p.driver),
            &p.column,
            t::classify_type_name(&p.data_type),
            &p.term,
            p.mode,
        );
        assert_eq!(
            actual, p.expected,
            "{} {:?} {} {:?} {:?}",
            p.driver, p.column, p.data_type, p.term, p.mode
        );
    }
}

#[test]
fn numeric_term_detection_matches_the_shared_vectors() {
    for n in &load().numeric_terms {
        assert_eq!(t::is_numeric_term(&n.term), n.expected, "{:?}", n.term);
    }
}

#[test]
fn table_scan_sql_matches_the_shared_vectors() {
    for s in &load().scan_sql {
        let actual = t::build_table_scan_sql(
            driver_of(&s.driver),
            s.database.as_deref(),
            &s.table,
            &s.columns,
            &s.term,
            s.mode,
        );
        match (&actual, &s.expected) {
            (None, None) => {}
            (Some(a), Some(e)) => {
                assert_eq!(a.sql, e.sql, "{} {:?}", s.driver, s.table);
                assert_eq!(a.columns, e.columns, "{} {:?}", s.driver, s.table);
            }
            _ => panic!("scan SQL presence mismatch for {} {:?}", s.driver, s.table),
        }
    }
}

#[test]
fn row_threshold_matches_the_shared_vectors() {
    for s in &load().skip {
        assert_eq!(
            t::should_skip_table_for_scan(s.estimate, s.threshold),
            s.expected,
            "{:?} vs {}",
            s.estimate,
            s.threshold
        );
    }
}

#[test]
fn scan_row_parsing_matches_the_shared_vectors() {
    for p in &load().parse_row {
        let row: Vec<t::Value> = p
            .row
            .iter()
            .map(|v| match v {
                serde_json::Value::Null => t::Value::Null,
                serde_json::Value::Bool(b) => t::Value::Bool(*b),
                serde_json::Value::Number(n) => match n.as_i64() {
                    Some(i) => t::Value::Int(i),
                    None => t::Value::Float(n.as_f64().unwrap_or(f64::NAN)),
                },
                serde_json::Value::String(s) => t::Value::String(s.clone()),
                other => panic!("unsupported row value {other}"),
            })
            .collect();
        let actual = t::parse_scan_row(&p.columns, &row);
        let actual: Vec<(String, f64)> = actual.into_iter().map(|h| (h.column, h.count)).collect();
        let expected: Vec<(String, f64)> = p
            .expected
            .iter()
            .map(|h| (h.column.clone(), h.count))
            .collect();
        assert_eq!(actual, expected, "{:?} {:?}", p.columns, p.row);
    }
}
