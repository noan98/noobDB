//! 読み取り専用判定のフロント/バック整合性ゴールデンテスト (#444) — バック側。
//!
//! フロント (`src/dangerousSql.ts` の `isReadOnlySql`) とバック
//! (`src-tauri/src/db/mod.rs` の `is_read_only_sql`) は読み取り専用ガードを独立に
//! 二重実装している。両者が**同一の共有ベクタ**
//! (`src/__tests__/fixtures/readOnlySqlVectors.json`) を読み、各 SQL の判定が
//! 期待値と一致することを検証することで、片方だけロジックを変えてもう片方とズレた
//! 場合に即座に検出できるようにする。フロント側は同じ JSON を import して
//! `src/__tests__/readOnlyGolden.test.ts` で対になる検証を行う。
//!
//! ベクタはフロントのテスト資産配下に 1 つだけ置き、ここからは `include_str!` で
//! 取り込む (リポジトリ内の単一ソースを両言語が参照する構成)。

use noobdb_lib::__test_api as t;
use serde::Deserialize;

// フロントのテスト資産配下にある共有ベクタを、このテストファイルからの相対パスで
// 埋め込む。src-tauri/tests/ から見てリポジトリ root の src/__tests__/fixtures/。
const VECTORS_JSON: &str = include_str!("../../src/__tests__/fixtures/readOnlySqlVectors.json");

#[derive(Deserialize)]
struct Vectors {
    cases: Vec<VectorCase>,
}

#[derive(Deserialize)]
struct VectorCase {
    sql: String,
    #[serde(rename = "readOnly")]
    read_only: bool,
    note: String,
}

#[test]
fn read_only_golden_matches_shared_vectors() {
    let vectors: Vectors =
        serde_json::from_str(VECTORS_JSON).expect("shared read-only vectors must be valid JSON");

    // 取りこぼし防止: フロント側 (readOnlyGolden.test.ts) と同じ下限を要求する。
    assert!(
        vectors.cases.len() >= 30,
        "expected at least 30 shared vectors, got {}",
        vectors.cases.len()
    );

    let mut failures = Vec::new();
    for case in &vectors.cases {
        let actual = t::is_read_only_sql(&case.sql);
        if actual != case.read_only {
            failures.push(format!(
                "  - {:?} (note: {}): expected read_only={}, got {}",
                case.sql, case.note, case.read_only, actual
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "is_read_only_sql diverged from the shared golden vectors (フロント isReadOnlySql とズレています):\n{}",
        failures.join("\n")
    );
}
