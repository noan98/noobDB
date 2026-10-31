//! `js_compat::js_number_to_string` / `js_to_number` の実装横断ゴールデンテスト — バック側 (#1959)。
//!
//! フロントの素の `String(x)` / `Number(s)` を Rust で再現するこの 2 関数は、結果グリッドの
//! ソート/フィルタ・値検索 (`data_search`)・マスキングの仮名決定性 (`masking`) が乗る
//! 「JS と同一表記」の不変条件を担う。ECMAScript の指数表記切替 (絶対値 ≥1e21 / <1e-6) や
//! `Number()` の受理/NaN 境界が将来ズレても検出できるよう、同一の共有ベクタ
//! (`src/__tests__/fixtures/jsNumberVectors.json`) を `include_str!` で読み込み、
//! Rust 実装に通す。フロント側の対テストは `src/__tests__/jsNumberGolden.test.ts`
//! (実物の `String` / `Number` を同じベクタに通す)。

use noobdb_lib::__test_api as t;
use serde::Deserialize;

const VECTORS_JSON: &str = include_str!("../../src/__tests__/fixtures/jsNumberVectors.json");

#[derive(Deserialize)]
struct Vectors {
    #[serde(rename = "numberToString")]
    number_to_string: Vec<Case>,
    #[serde(rename = "toNumber")]
    to_number: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    input: String,
    expected: String,
    note: String,
}

fn load() -> Vectors {
    serde_json::from_str(VECTORS_JSON).expect("shared JS number vectors must be valid JSON")
}

/// ベクタの 10 進表記 (`NaN` / `Infinity` / `-Infinity` を含む) を f64 にする。
/// Rust の `f64::from_str` はこれらの綴りを受理し、`-0` は負のゼロになる。
fn parse_literal(s: &str) -> f64 {
    s.parse::<f64>()
        .unwrap_or_else(|e| panic!("vector literal {s:?} must parse as f64: {e}"))
}

#[test]
fn number_to_string_matches_shared_vectors() {
    let v = load();
    assert!(!v.number_to_string.is_empty());
    for c in &v.number_to_string {
        let x = parse_literal(&c.input);
        assert_eq!(
            t::js_number_to_string(x),
            c.expected,
            "String({}) ({})",
            c.input,
            c.note
        );
    }
}

#[test]
fn to_number_matches_shared_vectors() {
    let v = load();
    assert!(!v.to_number.is_empty());
    for c in &v.to_number {
        let got = t::js_to_number(&c.input);
        let want = parse_literal(&c.expected);
        if want.is_nan() {
            assert!(
                got.is_nan(),
                "Number({:?}) should be NaN ({})",
                c.input,
                c.note
            );
        } else {
            // ビット比較で -0 と 0 も区別する。
            assert_eq!(
                got.to_bits(),
                want.to_bits(),
                "Number({:?}) = {got:?}, want {} ({})",
                c.input,
                c.expected,
                c.note
            );
        }
    }
}
