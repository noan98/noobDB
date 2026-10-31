//! `js_compat::collation_key` (照合順) のフロント↔バック共有ゴールデン — バック側 (#1944)。
//!
//! `collation_key` は `new Intl.Collator(undefined, { numeric: true })` (フロントの
//! `compareStringCells`) の近似再現。期待値は en-US / ICU 77 の比較符号 (-1 / 0 / 1) で、
//! 共有ベクタ (`src/__tests__/fixtures/collationKeyVectors.json`) を `include_str!` で
//! 取り込んで突き合わせる。フロント側の対テストは `src/__tests__/collationKeyGolden.test.ts`。
//!
//! `groups` は Rust の近似が ICU と一致する範囲 (コードポイント順で偶然一致する組も含む)。
//! `knownDifferences` は ICU との既知の差で、「今も一致しない」ことを assert する
//! (一致するようになったら `groups` へ移す合図)。

use noobdb_lib::__test_api as t;
use serde::Deserialize;

const VECTORS_JSON: &str = include_str!("../../src/__tests__/fixtures/collationKeyVectors.json");

#[derive(Deserialize)]
struct Vectors {
    groups: Vec<Group>,
    #[serde(rename = "knownDifferences")]
    known_differences: Vec<KnownCase>,
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

#[derive(Deserialize)]
struct KnownCase {
    group: String,
    a: String,
    b: String,
    expected: i32,
}

fn sign(a: &str, b: &str) -> i32 {
    match t::collation_key(a).cmp(&t::collation_key(b)) {
        std::cmp::Ordering::Less => -1,
        std::cmp::Ordering::Equal => 0,
        std::cmp::Ordering::Greater => 1,
    }
}

fn vectors() -> Vectors {
    serde_json::from_str(VECTORS_JSON).expect("collationKeyVectors.json parses")
}

#[test]
fn collation_key_matches_shared_vectors() {
    let vectors = vectors();
    let mut total = 0;
    let mut failures = Vec::new();
    for group in &vectors.groups {
        for case in &group.cases {
            total += 1;
            let got = sign(&case.a, &case.b);
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

#[test]
fn known_differences_still_differ() {
    let vectors = vectors();
    assert!(
        !vectors.known_differences.is_empty(),
        "knownDifferences が空"
    );
    for case in &vectors.known_differences {
        assert_ne!(
            sign(&case.a, &case.b),
            case.expected,
            "[{}] {:?} vs {:?} が ICU と一致するようになった。knownDifferences から groups へ移すこと",
            case.group,
            case.a,
            case.b
        );
    }
}
