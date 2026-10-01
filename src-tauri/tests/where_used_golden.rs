//! Where-used (#1027 / #1261) の参照検出の実装横断ゴールデンテスト — バック側。
//!
//! 参照検出 (識別子境界・引用・スキーマ修飾・別名解決・マスク・行単位のまとめ) は旧フロント
//! 実装 (`components/whereUsed.ts`) から Rust へ移植した。期待値は移植前の TS 実装
//! (`src/__tests__/oracles/whereUsedOracle.ts`) の出力で、フロント側の
//! `whereUsedGolden.test.ts` がオラクルとの一致を、ここが Rust 実装との一致を、同じ
//! `whereUsedVectors.json` に対して検証する。ヒット位置・行内範囲・160 文字の切り詰めは
//! いずれも UTF-16 コードユニット基準で、補助平面の文字を含むケースも固定している。

use noobdb_lib::__test_api as t;
use serde::Deserialize;

const VECTORS_JSON: &str = include_str!("../../src/__tests__/fixtures/whereUsedVectors.json");

#[derive(Deserialize)]
struct Vectors {
    cases: Vec<Case>,
    prepare: Vec<Prepare>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    driver: String,
    target: t::WhereUsedTarget,
    sql: String,
    expected: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct Prepare {
    driver: String,
    sql: String,
    expected: String,
}

fn driver_of(name: &str) -> t::DriverKind {
    t::DriverKind::parse(name).unwrap_or_else(|| panic!("unknown driver {name}"))
}

#[test]
fn rust_where_used_matches_the_shared_vectors() {
    let vectors: Vectors =
        serde_json::from_str(VECTORS_JSON).expect("shared where-used vectors must be valid JSON");
    assert!(vectors.cases.len() > 40);
    for case in &vectors.cases {
        let actual = t::analyze_definition(&case.sql, &case.target, driver_of(&case.driver));
        let actual = match actual {
            Some(a) => serde_json::to_value(&a).expect("analysis must serialize"),
            None => serde_json::Value::Null,
        };
        let expected = case.expected.clone().unwrap_or(serde_json::Value::Null);
        assert_eq!(actual, expected, "{}: {:?}", case.name, case.sql);
    }
}

#[test]
fn rust_masking_for_reference_scan_matches_the_shared_vectors() {
    let vectors: Vectors =
        serde_json::from_str(VECTORS_JSON).expect("shared where-used vectors must be valid JSON");
    for p in &vectors.prepare {
        let actual = t::prepare_for_reference_scan(&p.sql, driver_of(&p.driver));
        assert_eq!(actual, p.expected, "{:?} ({})", p.sql, p.driver);
    }
}

#[test]
fn find_references_reports_utf16_offsets() {
    // 😀 は UTF-16 で 2 コードユニット: `-- 😀\n` は 6 ユニット、`SELECT * FROM ` は 14。
    let target = t::WhereUsedTarget {
        database: "app".into(),
        table: "orders".into(),
        column: None,
    };
    let hits = t::find_references(
        "-- \u{1F600}\nSELECT * FROM orders",
        &target,
        t::DriverKind::Mysql,
    );
    assert_eq!(hits.len(), 1);
    assert_eq!((hits[0].start, hits[0].end), (6 + 14, 6 + 20));
}
