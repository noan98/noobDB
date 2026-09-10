//! `is_query_shape` の実装横断ゴールデンテスト (#971)。
//!
//! ストリーミング実行器が結果セットを返す fetch 経路 (`fetch`/`query`) を通すか、
//! `rows_affected` のみを返す execute 経路を通すかを決める `is_query_shape` は、
//! `is_read_only_sql` (#444) と違って共有関数ではなく、sqlite/mysql/postgres/
//! duckdb/mssql の各 `db/<driver>.rs` にそれぞれ private (現在は `pub(crate)`)
//! 関数として個別実装されている。5 実装が一致すべき境界ケースを共有ベクタ
//! (`src/__tests__/fixtures/queryShapeVectors.json`) に集約し、ここから
//! `include_str!` で読み込んで全ドライバへ通す。片方のドライバだけ実装を
//! 変えて他とズレた場合、このテストが落ちる。
//!
//! フロントエンドには `is_query_shape` に相当する分類ロジックが存在しない
//! (このロジックはバックエンドの実行経路振り分け専用で、フロントは
//! バックエンドが返した `QueryResult` を表示するだけ) ため、対になる Vitest
//! テストは無い — バックエンドのみのゴールデン。

use std::collections::BTreeMap;

use noobdb_lib::__test_api as t;
use serde::Deserialize;

const VECTORS_JSON: &str = include_str!("../../src/__tests__/fixtures/queryShapeVectors.json");

#[derive(Deserialize)]
struct Vectors {
    drivers: Vec<String>,
    cases: Vec<VectorCase>,
}

#[derive(Deserialize)]
struct VectorCase {
    sql: String,
    note: String,
    expected: BTreeMap<String, bool>,
}

fn load() -> Vectors {
    serde_json::from_str(VECTORS_JSON).expect("shared query-shape vectors must be valid JSON")
}

fn driver_of(name: &str) -> t::DriverKind {
    t::DriverKind::parse(name).unwrap_or_else(|| panic!("unknown driver name in vectors: {name}"))
}

#[test]
fn query_shape_golden_matches_shared_vectors() {
    let vectors = load();
    assert!(
        vectors.cases.len() >= 35,
        "expected at least 35 shared vectors, got {}",
        vectors.cases.len()
    );

    let mut failures = Vec::new();
    for case in &vectors.cases {
        for driver_name in &vectors.drivers {
            let expected = case.expected.get(driver_name).unwrap_or_else(|| {
                panic!(
                    "case {:?} (note: {}) is missing an expectation for {driver_name}",
                    case.sql, case.note
                )
            });
            let actual = t::is_query_shape(driver_of(driver_name), &case.sql);
            if actual != *expected {
                failures.push(format!(
                    "  - {:?} (note: {}) [{driver_name}]: expected is_query_shape={expected}, got {actual}",
                    case.sql, case.note
                ));
            }
        }
    }

    assert!(
        failures.is_empty(),
        "is_query_shape diverged from the shared golden vectors across drivers:\n{}",
        failures.join("\n")
    );
}

/// ドライバの取りこぼし防止: ベクタが `DriverKind` の全バリアントを覆っているか。
/// 新ドライバを追加したのにベクタへ足し忘れると、その方言の fetch/execute
/// 振り分けが誰にも検証されないまま出荷されてしまう。
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

/// ドライバ次元が形骸化していないことの確認 (`read_only_golden.rs` の
/// `..._exercises_the_driver_dimension` と同じ意図)。5 ドライバが常に同じ
/// 答えを返すだけのベクタ集合になっていないか — 実際に判定が割れるケース
/// (SHOW / DESCRIBE / EXPLAIN / PRAGMA / SUMMARIZE / VALUES / TABLE の
/// ドライバ固有分岐) が最低 1 件は残っていることを要求する。
#[test]
fn query_shape_golden_exercises_the_driver_dimension() {
    let vectors = load();
    let has_divergent_case = vectors.cases.iter().any(|c| {
        let values: std::collections::HashSet<bool> = c.expected.values().copied().collect();
        values.len() > 1
    });
    assert!(
        has_divergent_case,
        "shared vectors must keep at least one case where the 5 drivers' is_query_shape \
         actually disagree (otherwise the driver dimension is pointless)"
    );
}
