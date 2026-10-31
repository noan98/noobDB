//! `js_compat::collation_key` (照合順) のフロント↔バック共有ゴールデン — バック側 (#1944)。
//!
//! `collation_key` は `new Intl.Collator(undefined, { numeric: true })` (フロントの
//! `compareStringCells`) の近似再現。期待値は JS 実装が出した比較符号 (-1 / 0 / 1) で、
//! 共有ベクタ (`src/__tests__/fixtures/collationKeyVectors.json`) を `include_str!` で
//! 取り込んで突き合わせる。フロント側の対テストは `src/__tests__/collationKeyGolden.test.ts`。
//!
//! ICU との既知の差 (キリル・漢字・全角/半角の同一視など) はベクタに含めず、両実装が
//! 一致する範囲だけを固定する。

use noobdb_lib::__test_api as t;
use serde::Deserialize;

const VECTORS_JSON: &str = include_str!("../../src/__tests__/fixtures/collationKeyVectors.json");

#[derive(Deserialize)]
struct Vectors {
    // `knownDifferences` (ICU との既知の差) は意図的に読まない。TS 側 (JS の正) だけが検証する。
    groups: Vec<Group>,
}

#[derive(Deserialize)]
struct Group {
    name: String,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    a: String,
    b: String,
    expected: i32,
}

#[test]
fn collation_key_matches_shared_vectors() {
    let vectors: Vectors =
        serde_json::from_str(VECTORS_JSON).expect("collationKeyVectors.json parses");
    let mut total = 0;
    let mut failures = Vec::new();
    for group in &vectors.groups {
        for case in &group.cases {
            total += 1;
            let got = match t::collation_key(&case.a).cmp(&t::collation_key(&case.b)) {
                std::cmp::Ordering::Less => -1,
                std::cmp::Ordering::Equal => 0,
                std::cmp::Ordering::Greater => 1,
            };
            if got != case.expected {
                failures.push(format!(
                    "[{}] {:?} vs {:?}: expected {}, got {}",
                    group.name, case.a, case.b, case.expected, got
                ));
            }
        }
    }
    assert!(total > 0, "ベクタが空");
    assert!(
        failures.is_empty(),
        "{} / {} 件が不一致:\n{}",
        failures.len(),
        total,
        failures.join("\n")
    );
}
