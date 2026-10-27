//! SQL 識別子引用 / リテラルエスケープの実装横断ゴールデンテスト — バック側 (#880)。
//!
//! 識別子引用は Rust の `db::sync::quote_ident` (MySQL/SQLite ドライバの
//! `quote_ident` はこれへ委譲する薄いラッパー) と、フロントの
//! `components/sqlDialect.ts::quoteIdentFor` / `components/exportPreview.ts::
//! quoteSqlIdent` に分散している。リテラルエスケープは `db::data_diff::sql_literal`
//! をフロントの `exportPreview.ts::sqlLiteral` と、実働の `cellEdit.ts::literalFromCellValue` /
//! `quoteString` (#1510) がミラーする。いずれも SQL
//! インジェクション隣接の安全性ロジックなので、read-only 判定 (#444) と同じ
//! 共有ベクタ方式で全実装を固定する。
//!
//! ベクタはフロントのテスト資産配下に 1 つだけ置き、ここからは `include_str!` で
//! 取り込む。フロント側の対テストは `src/__tests__/sqlQuotingGolden.test.ts`。

use std::collections::BTreeMap;

use noobdb_lib::__test_api as t;
use serde::Deserialize;

const VECTORS_JSON: &str = include_str!("../../src/__tests__/fixtures/sqlQuotingVectors.json");

#[derive(Deserialize)]
struct Vectors {
    drivers: Vec<String>,
    identifiers: Vec<IdentifierCase>,
    literals: Vec<LiteralCase>,
    #[serde(rename = "wherePredicates")]
    where_predicates: Vec<WherePredicateCase>,
}

/// 行同定 WHERE の述語形ゴールデン (#1870)。`frontend` はフロント専用の期待値で、ここでは見ない。
#[derive(Deserialize)]
struct WherePredicateCase {
    kind: String,
    #[serde(default)]
    value: serde_json::Value,
    #[serde(default = "default_column")]
    column: String,
    note: String,
    #[serde(default)]
    drivers: Option<Vec<String>>,
    expected: BTreeMap<String, String>,
}

fn default_column() -> String {
    "c".to_string()
}

#[derive(Deserialize)]
struct IdentifierCase {
    input: String,
    note: String,
    expected: BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct LiteralCase {
    kind: String,
    #[serde(default)]
    value: serde_json::Value,
    note: String,
    expected: BTreeMap<String, String>,
}

fn load() -> Vectors {
    serde_json::from_str(VECTORS_JSON).expect("shared SQL quoting vectors must be valid JSON")
}

fn driver_of(name: &str) -> t::DriverKind {
    t::DriverKind::parse(name).unwrap_or_else(|| panic!("unknown driver name in vectors: {name}"))
}

/// ベクタの `kind` + `value` から `db::types::Value` を組み立てる。`Value` は
/// `#[serde(untagged)]` なので JSON だけからバリアントを一意に決められない
/// (16 進文字列の `Bytes` と `String` が区別できない) ため、`kind` を明示的な
/// 判別子として使う。
fn value_of(case: &LiteralCase) -> t::Value {
    let v = &case.value;
    match case.kind.as_str() {
        "null" => t::Value::Null,
        "bool" => t::Value::Bool(v.as_bool().expect("bool case needs a bool value")),
        "int" => t::Value::Int(v.as_i64().expect("int case needs an integer value")),
        "float" => t::Value::Float(v.as_f64().expect("float case needs a number value")),
        "string" => t::Value::String(v.as_str().expect("string case needs a string").to_string()),
        "bytes" => t::Value::Bytes(
            v.as_str()
                .expect("bytes case needs a hex string")
                .to_string(),
        ),
        other => panic!("unknown literal kind in vectors: {other}"),
    }
}

#[test]
fn quote_ident_matches_shared_vectors() {
    let vectors = load();
    assert!(
        vectors.identifiers.len() >= 10,
        "expected at least 10 identifier vectors, got {}",
        vectors.identifiers.len()
    );

    let mut failures = Vec::new();
    for case in &vectors.identifiers {
        for driver_name in &vectors.drivers {
            let expected = case.expected.get(driver_name).unwrap_or_else(|| {
                panic!(
                    "identifier vector {:?} is missing an expectation for {driver_name}",
                    case.input
                )
            });
            let actual = t::quote_ident(driver_of(driver_name), &case.input);
            if &actual != expected {
                failures.push(format!(
                    "  - {:?} (note: {}) [{driver_name}]: expected {expected:?}, got {actual:?}",
                    case.input, case.note
                ));
            }
        }
    }

    assert!(
        failures.is_empty(),
        "quote_ident diverged from the shared golden vectors (フロント quoteIdentFor / quoteSqlIdent とズレています):\n{}",
        failures.join("\n")
    );
}

#[test]
fn sql_literal_matches_shared_vectors() {
    let vectors = load();
    assert!(
        vectors.literals.len() >= 12,
        "expected at least 12 literal vectors, got {}",
        vectors.literals.len()
    );

    let mut failures = Vec::new();
    for case in &vectors.literals {
        let value = value_of(case);
        for driver_name in &vectors.drivers {
            let expected = case.expected.get(driver_name).unwrap_or_else(|| {
                panic!(
                    "literal vector {:?} is missing an expectation for {driver_name}",
                    case.note
                )
            });
            let actual = t::sql_literal(driver_of(driver_name), &value);
            if &actual != expected {
                failures.push(format!(
                    "  - {} {:?} (note: {}) [{driver_name}]: expected {expected:?}, got {actual:?}",
                    case.kind, case.value, case.note
                ));
            }
        }
    }

    assert!(
        failures.is_empty(),
        "sql_literal diverged from the shared golden vectors (フロント sqlLiteral とズレています):\n{}",
        failures.join("\n")
    );
}

/// 行同定 WHERE の述語形 (#1870)。楽観ロックの `old_predicate` と行同定の `row_condition` を、
/// フロント `cellEdit.ts::whereEqualsClause` / `buildRowWhere` と同じベクタに通す。
/// `bytes` は `old_predicate` の対象外 (フロントが除外する型)、`float4` は `row_condition`
/// の対象外 (許容差の述語は楽観ロック専用)。
#[test]
fn where_predicate_matches_shared_vectors() {
    let vectors = load();
    assert!(
        vectors.where_predicates.len() >= 8,
        "expected at least 8 where-predicate vectors, got {}",
        vectors.where_predicates.len()
    );

    let mut failures = Vec::new();
    for case in &vectors.where_predicates {
        let v = &case.value;
        let text = || match v {
            serde_json::Value::Number(n) => n.to_string(),
            other => panic!("number-like case needs a number value: {other:?}"),
        };
        let old: Option<t::BulkOldValue> = match case.kind.as_str() {
            "null" => Some(t::BulkOldValue::Null),
            "bool" => Some(t::BulkOldValue::Bool {
                value: v.as_bool().expect("bool case needs a bool value"),
            }),
            "int" | "float" => Some(t::BulkOldValue::Number { text: text() }),
            "float4" => Some(t::BulkOldValue::Float4 { text: text() }),
            "string" => Some(t::BulkOldValue::Text {
                text: v.as_str().expect("string case needs a string").to_string(),
            }),
            "bytes" => None,
            other => panic!("unknown where-predicate kind in vectors: {other}"),
        };
        let key: Option<t::Value> = match case.kind.as_str() {
            "null" => Some(t::Value::Null),
            "bool" => Some(t::Value::Bool(v.as_bool().expect("bool"))),
            "int" => Some(t::Value::Int(v.as_i64().expect("int"))),
            "float" => Some(t::Value::Float(v.as_f64().expect("float"))),
            "string" => Some(t::Value::String(v.as_str().expect("string").to_string())),
            "bytes" => Some(t::Value::Bytes(v.as_str().expect("hex").to_string())),
            _ => None,
        };
        let names: Vec<&String> = case
            .drivers
            .as_ref()
            .map(|d| d.iter().collect())
            .unwrap_or_else(|| vectors.drivers.iter().collect());
        for driver_name in names {
            let expected = case.expected.get(driver_name).unwrap_or_else(|| {
                panic!(
                    "where vector {:?} is missing an expectation for {driver_name}",
                    case.note
                )
            });
            let driver = driver_of(driver_name);
            if let Some(old) = &old {
                let actual = t::bulk_old_predicate(driver, &case.column, old)
                    .unwrap_or_else(|e| panic!("old_predicate failed for {:?}: {e}", case.note));
                if &actual != expected {
                    failures.push(format!(
                        "  - old_predicate {} (note: {}) [{driver_name}]: expected {expected:?}, got {actual:?}",
                        case.kind, case.note
                    ));
                }
            }
            if let Some(key) = &key {
                let actual = t::bulk_row_condition(
                    driver,
                    std::slice::from_ref(&case.column),
                    std::slice::from_ref(key),
                );
                if &actual != expected {
                    failures.push(format!(
                        "  - row_condition {} (note: {}) [{driver_name}]: expected {expected:?}, got {actual:?}",
                        case.kind, case.note
                    ));
                }
            }
        }
    }

    assert!(
        failures.is_empty(),
        "WHERE predicate diverged from the shared golden vectors (フロント whereEqualsClause / buildRowWhere とズレています):\n{}",
        failures.join("\n")
    );
}

/// ドライバの取りこぼし防止: ベクタが `DriverKind` の全バリアントを覆っているか。
/// 新ドライバを追加したのにベクタへ足し忘れると、その方言の引用/エスケープが
/// 誰にも検証されないまま出荷されてしまう。
#[test]
fn vectors_cover_every_driver() {
    let vectors = load();
    for driver in [
        t::DriverKind::Mysql,
        t::DriverKind::Postgres,
        t::DriverKind::Sqlite,
    ] {
        assert!(
            vectors.drivers.iter().any(|d| d == driver.as_str()),
            "shared vectors must list {driver:?} in `drivers`"
        );
    }
}
