//! グローバルオブジェクト検索 (#1261) の実装横断ゴールデンテスト — バック側。
//!
//! 順位付け (完全一致 > 前方一致 > 単語境界 > 部分一致、同点はテーブル優先、二次キーは
//! DB → テーブル → カラムの UTF-16 順) は旧フロント実装 (`objectSearch.ts`) から Rust へ
//! 移植した。期待値は移植前の TS 実装 (`src/__tests__/oracles/objectSearchOracle.ts`) の
//! 出力で、フロント側の `objectSearchGolden.test.ts` がオラクルとの一致を、ここが Rust 実装
//! との一致を、同じ `objectSearchVectors.json` に対して検証する。

use std::collections::BTreeMap;

use noobdb_lib::__test_api as t;
use serde::Deserialize;

const VECTORS_JSON: &str = include_str!("../../src/__tests__/fixtures/objectSearchVectors.json");

#[derive(Deserialize)]
struct Vectors {
    schemas: BTreeMap<String, Vec<t::TableSchema>>,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    query: String,
    limit: usize,
    note: String,
    expected: Vec<t::ObjectHit>,
}

#[test]
fn rust_object_search_matches_the_shared_vectors() {
    let vectors: Vectors = serde_json::from_str(VECTORS_JSON)
        .expect("shared object search vectors must be valid JSON");
    let index = t::ObjectIndex::build(
        vectors
            .schemas
            .iter()
            .map(|(db, tables)| (db.as_str(), tables.as_slice())),
    );
    assert!(!vectors.cases.is_empty());
    for case in &vectors.cases {
        let actual = index.search(&case.query, case.limit);
        assert_eq!(
            actual, case.expected,
            "query {:?} (limit {}): {}",
            case.query, case.limit, case.note
        );
    }
}
