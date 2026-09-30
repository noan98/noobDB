//! 結果ハンドル (#1264) のソート・フィルタ・検索・列統計のフロント↔バック共有ゴールデン
//! — バック側。
//!
//! `db/result_ops.rs` (結果ハンドル経由の実装) は、フロントの `ResultGrid.tsx` /
//! `gridFind.ts` / `gridStats.ts` (JS 実装 = 判定の正) と同じ意味論を Rust に移したもの。
//! 期待値は JS 実装が出した値で、共有ベクタ (`src/__tests__/fixtures/resultOpsVectors.json`)
//! を `include_str!` で取り込んで突き合わせる。フロント側の対テストは
//! `src/__tests__/resultOpsGolden.test.ts`。
//!
//! 既知の差は文字列ソートの照合順序 (`Intl.Collator` の近似) だけで、ベクタには両実装が
//! 一致する範囲 (ASCII・数字列・Latin-1 のアクセント・かな) のみを入れている。

use noobdb_lib::__test_api as t;
use serde::Deserialize;
use serde_json::Value as Json;

const VECTORS_JSON: &str = include_str!("../../src/__tests__/fixtures/resultOpsVectors.json");

#[derive(Deserialize)]
struct Vectors {
    #[serde(rename = "sortFilter")]
    sort_filter: Vec<SortFilterCase>,
    find: Vec<FindCase>,
    #[serde(rename = "columnStats")]
    column_stats: Vec<StatsCase>,
}

#[derive(Deserialize)]
struct SortKey {
    col: usize,
    desc: bool,
}

#[derive(Deserialize)]
struct SortFilterCase {
    name: String,
    kinds: Vec<String>,
    rows: Vec<Vec<t::Value>>,
    #[serde(default)]
    sort: Vec<SortKey>,
    #[serde(default)]
    filters: Vec<t::FilterSpec>,
    #[serde(default)]
    global: String,
    expected: Vec<u32>,
}

#[derive(Deserialize)]
struct FindCase {
    name: String,
    rows: Vec<Vec<t::Value>>,
    #[serde(rename = "columnCount")]
    column_count: usize,
    query: String,
    options: t::FindOptions,
    limit: usize,
    expected: Json,
}

#[derive(Deserialize)]
struct StatsCase {
    name: String,
    rows: Vec<Vec<t::Value>>,
    col: usize,
    expected: Json,
}

fn sort_kind(kind: &str) -> t::SortKind {
    match kind {
        "number" | "decimal" => t::SortKind::Numeric,
        "bool" => t::SortKind::Bool,
        _ => t::SortKind::String,
    }
}

/// 数値は f64 として比較する (`3` と `3.0` を同一視)。
fn json_eq(a: &Json, b: &Json) -> bool {
    match (a, b) {
        (Json::Number(x), Json::Number(y)) => x.as_f64() == y.as_f64(),
        (Json::Array(x), Json::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| json_eq(p, q))
        }
        (Json::Object(x), Json::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).is_some_and(|w| json_eq(v, w)))
        }
        _ => a == b,
    }
}

fn vectors() -> Vectors {
    serde_json::from_str(VECTORS_JSON).expect("resultOpsVectors.json parses")
}

#[test]
fn sort_and_filter_match_the_js_implementation() {
    let v = vectors();
    assert!(!v.sort_filter.is_empty());
    for c in v.sort_filter {
        let sort: Vec<t::SortSpec> = c
            .sort
            .iter()
            .map(|s| t::SortSpec {
                col: s.col,
                kind: sort_kind(&c.kinds[s.col]),
                desc: s.desc,
            })
            .collect();
        let got = t::sort_filter(&c.rows, c.kinds.len(), &sort, &c.filters, &c.global);
        assert_eq!(got, c.expected, "{}", c.name);
    }
}

#[test]
fn find_matches_the_js_implementation() {
    let v = vectors();
    assert!(!v.find.is_empty());
    for c in v.find {
        let got = t::find(&c.rows, c.column_count, &c.query, c.options, c.limit);
        let got = serde_json::to_value(got).expect("serializes");
        assert!(
            json_eq(&got, &c.expected),
            "{}: {got} != {}",
            c.name,
            c.expected
        );
    }
}

#[test]
fn column_stats_match_the_js_implementation() {
    let v = vectors();
    assert!(!v.column_stats.is_empty());
    for c in v.column_stats {
        let got = serde_json::to_value(t::column_stats(&c.rows, c.col)).expect("serializes");
        assert!(
            json_eq(&got, &c.expected),
            "{}: {got} != {}",
            c.name,
            c.expected
        );
    }
}
