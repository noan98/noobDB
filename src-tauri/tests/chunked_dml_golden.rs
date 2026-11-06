//! 大規模 DML のチャンク分割実行 (#2020) の SQL 生成ゴールデン — バック側。
//!
//! フロントの `components/chunkedDml.ts` と同じ `chunkedDmlVectors.json` を読み、
//! 成功ケースの SQL と拒否ケースの理由コードを固定する。対は
//! `src/__tests__/chunkedDmlGolden.test.ts`。

use std::collections::BTreeMap;

use noobdb_lib::__test_api as t;
use serde::Deserialize;

const VECTORS_JSON: &str = include_str!("../../src/__tests__/fixtures/chunkedDmlVectors.json");

#[derive(Deserialize)]
struct Vectors {
    drivers: Vec<String>,
    cases: Vec<Case>,
    errors: Vec<ErrorCase>,
    fragments: Vec<FragmentCase>,
}

#[derive(Deserialize)]
struct FragmentCase {
    note: String,
    frag: String,
    /// `null` なら通る。
    error: Option<String>,
    drivers: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct Case {
    note: String,
    table: String,
    database: Option<String>,
    #[serde(rename = "where")]
    where_clause: String,
    #[serde(rename = "batchSize")]
    batch_size: u32,
    set: Option<String>,
    #[serde(rename = "rowKey")]
    row_key: Option<String>,
    expected: BTreeMap<String, String>,
    count: BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct ErrorCase {
    note: String,
    table: String,
    #[serde(rename = "where")]
    where_clause: String,
    #[serde(rename = "batchSize")]
    batch_size: u32,
    set: Option<String>,
    error: String,
    drivers: Option<Vec<String>>,
}

fn driver_of(name: &str) -> t::DriverKind {
    t::DriverKind::parse(name).unwrap_or_else(|| panic!("unknown driver in vectors: {name}"))
}

#[test]
fn chunk_sql_matches_shared_vectors() {
    let v: Vectors = serde_json::from_str(VECTORS_JSON).expect("valid vectors JSON");
    assert!(v.cases.len() >= 8);
    let mut failures = Vec::new();
    for case in &v.cases {
        for name in case.expected.keys() {
            let d = driver_of(name);
            let got = t::chunked_dml_sql(
                d,
                case.database.as_deref(),
                &case.table,
                case.set.as_deref(),
                &case.where_clause,
                case.batch_size,
                case.row_key.as_deref().unwrap_or("rowid"),
            );
            if got.as_ref() != Ok(&case.expected[name]) {
                failures.push(format!(
                    "  - {} [{name}]: expected {:?}, got {got:?}",
                    case.note, case.expected[name]
                ));
            }
            let count = t::chunked_dml_count_sql(
                d,
                case.database.as_deref(),
                &case.table,
                &case.where_clause,
            );
            if count.as_ref() != Ok(&case.count[name]) {
                failures.push(format!(
                    "  - {} count [{name}]: expected {:?}, got {count:?}",
                    case.note, case.count[name]
                ));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn chunk_sql_rejections_match_shared_vectors() {
    let v: Vectors = serde_json::from_str(VECTORS_JSON).expect("valid vectors JSON");
    assert!(v.errors.len() >= 10);
    let mut failures = Vec::new();
    for case in &v.errors {
        let names = case.drivers.clone().unwrap_or_else(|| v.drivers.clone());
        for name in &names {
            let got = t::chunked_dml_sql(
                driver_of(name),
                None,
                &case.table,
                case.set.as_deref(),
                &case.where_clause,
                case.batch_size,
                "rowid",
            );
            if got.as_ref() != Err(&case.error) {
                failures.push(format!(
                    "  - {} [{name}]: expected Err({:?}), got {got:?}",
                    case.note, case.error
                ));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn count_sql_rejections_match_shared_vectors() {
    let v: Vectors = serde_json::from_str(VECTORS_JSON).expect("valid vectors JSON");
    let mut failures = Vec::new();
    for case in &v.errors {
        // 件数 SELECT は SET もバッチサイズも持たない (SET 側の拒否は対象外、バッチサイズは 1 で固定)。
        if case.set.is_some() || case.error == "badBatchSize" {
            continue;
        }
        let names = case.drivers.clone().unwrap_or_else(|| v.drivers.clone());
        for name in &names {
            let got =
                t::chunked_dml_count_sql(driver_of(name), None, &case.table, &case.where_clause);
            if got.as_ref() != Err(&case.error) {
                failures.push(format!(
                    "  - {} count [{name}]: expected Err({:?}), got {got:?}",
                    case.note, case.error
                ));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn validate_fragment_matches_shared_vectors() {
    let v: Vectors = serde_json::from_str(VECTORS_JSON).expect("valid vectors JSON");
    assert!(v.fragments.len() >= 40);
    let mut failures = Vec::new();
    for case in &v.fragments {
        let names = case.drivers.clone().unwrap_or_else(|| v.drivers.clone());
        for name in &names {
            let got = t::chunked_dml_validate_fragment(driver_of(name), &case.frag);
            let want = match &case.error {
                None => Ok(()),
                Some(e) => Err(e.clone()),
            };
            if got != want {
                failures.push(format!(
                    "  - {} [{name}] {:?}: expected {want:?}, got {got:?}",
                    case.note, case.frag
                ));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
