//! スキーマ変更検出のフロント/バック整合性ゴールデンテスト — バック側 (#1221)。
//!
//! フロント (`src/dangerousSql.ts` の `isSchemaMutatingSql`) とバック
//! (`src-tauri/src/db/mod.rs` の `sql_may_change_schema`、Schema Cache の invalidate
//! 判定) は独立に二重実装されている。両者が**同一の共有ベクタ**
//! (`src/__tests__/fixtures/schemaMutatingVectors.json`) を読み、各 SQL の判定が
//! 期待値と一致することを検証することで、片方だけ変えてズレた場合に即座に検出する。
//! フロント側は同じ JSON を import して `src/__tests__/schemaMutatingGolden.test.ts`
//! で対になる検証を行う。
//!
//! ベクタは**ドライバ次元**を持つ (#852): `schemaMutates` はバックスラッシュを文字列
//! エスケープと見なさない標準解釈 (PostgreSQL / SQLite) での期待値で、MySQL だけ判定が
//! 変わるケースのみ `schemaMutatesMysql` を持つ。

use noobdb_lib::__test_api as t;
use serde::Deserialize;

const VECTORS_JSON: &str = include_str!("../../src/__tests__/fixtures/schemaMutatingVectors.json");

#[derive(Deserialize)]
struct Vectors {
    cases: Vec<VectorCase>,
}

#[derive(Deserialize)]
struct VectorCase {
    sql: String,
    #[serde(rename = "schemaMutates")]
    schema_mutates: bool,
    /// MySQL のバックスラッシュエスケープ解釈での期待値 (省略時は `schema_mutates`)。
    #[serde(rename = "schemaMutatesMysql", default)]
    schema_mutates_mysql: Option<bool>,
    note: String,
}

const STANDARD_DRIVERS: [t::DriverKind; 2] = [t::DriverKind::Postgres, t::DriverKind::Sqlite];

fn load() -> Vectors {
    serde_json::from_str(VECTORS_JSON).expect("shared schema-mutating vectors must be valid JSON")
}

#[test]
fn schema_mutating_golden_matches_shared_vectors() {
    let vectors = load();

    // 取りこぼし防止: フロント側 (schemaMutatingGolden.test.ts) と同じ下限を要求する。
    assert!(
        vectors.cases.len() >= 40,
        "expected at least 40 shared vectors, got {}",
        vectors.cases.len()
    );
    assert!(vectors.cases.iter().any(|c| c.schema_mutates));
    assert!(vectors.cases.iter().any(|c| !c.schema_mutates));
    assert!(
        vectors
            .cases
            .iter()
            .any(|c| c.schema_mutates_mysql.is_some()),
        "driver dimension must stay exercised (#852)"
    );

    let mut failures = Vec::new();
    for case in &vectors.cases {
        let mysql_expected = case.schema_mutates_mysql.unwrap_or(case.schema_mutates);
        for driver in STANDARD_DRIVERS {
            let actual = t::sql_may_change_schema(driver, &case.sql);
            if actual != case.schema_mutates {
                failures.push(format!(
                    "  - {:?} (note: {}) [{driver:?}]: expected schemaMutates={}, got {}",
                    case.sql, case.note, case.schema_mutates, actual
                ));
            }
        }
        let actual = t::sql_may_change_schema(t::DriverKind::Mysql, &case.sql);
        if actual != mysql_expected {
            failures.push(format!(
                "  - {:?} (note: {}) [Mysql]: expected schemaMutates={}, got {}",
                case.sql, case.note, mysql_expected, actual
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "schema-mutating golden mismatches ({}):\n{}",
        failures.len(),
        failures.join("\n")
    );
}
