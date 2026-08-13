//! SQL 識別子引用 / リテラルエスケープの実装横断ゴールデンテスト — バック側 (#880)。
//!
//! 識別子引用は Rust の `db::sync::quote_ident` (MySQL/SQLite ドライバの
//! `quote_ident` はこれへ委譲する薄いラッパー) と、フロントの
//! `components/sqlDialect.ts::quoteIdentFor` / `components/exportPreview.ts::
//! quoteSqlIdent` に分散している。リテラルエスケープは `db::data_diff::sql_literal`
//! をフロントの `exportPreview.ts::sqlLiteral` がミラーする。いずれも SQL
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
        t::DriverKind::DuckDb,
        t::DriverKind::Mssql,
    ] {
        assert!(
            vectors.drivers.iter().any(|d| d == driver.as_str()),
            "shared vectors must list {driver:?} in `drivers`"
        );
    }
}
