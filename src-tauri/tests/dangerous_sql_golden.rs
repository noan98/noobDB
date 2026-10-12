//! 危険文検出のフロント/バック整合性ゴールデンテスト — バック側 (#1535)。
//!
//! フロント (`src/dangerousSql.ts` の `analyzeDangerousSql`) と、スクリプト事前確認
//! (ドライラン) が使うバック (`db::script_analysis::classify_dangerous`) は独立に二重
//! 実装されている。両者が**同一の共有ベクタ**
//! (`src/__tests__/fixtures/dangerousSqlVectors.json`) を読み、各文の判定が期待値と
//! 一致することを検証する。フロント側は `src/__tests__/dangerousSqlGolden.test.ts`。
//! `kind` は標準解釈 (PostgreSQL / SQLite)、MySQL のバックスラッシュエスケープ解釈で
//! 変わるケースだけ `kindMysql` を持つ。

use noobdb_lib::__test_api as t;
use serde::Deserialize;

const VECTORS_JSON: &str = include_str!("../../src/__tests__/fixtures/dangerousSqlVectors.json");

#[derive(Deserialize)]
struct Vectors {
    cases: Vec<VectorCase>,
}

#[derive(Deserialize)]
struct VectorCase {
    sql: String,
    kind: Option<String>,
    /// `Some(None)` = MySQL では危険ではない、`None` = `kind` と同じ。
    #[serde(rename = "kindMysql", default, deserialize_with = "double_option")]
    kind_mysql: Option<Option<String>>,
    note: String,
}

fn double_option<'de, D>(d: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Some(Option::<String>::deserialize(d)?))
}

#[test]
fn dangerous_sql_golden_matches_shared_vectors() {
    let vectors: Vectors = serde_json::from_str(VECTORS_JSON)
        .expect("shared dangerous-sql vectors must be valid JSON");
    assert!(vectors.cases.len() >= 30);
    assert!(vectors.cases.iter().any(|c| c.kind.is_some()));
    assert!(vectors.cases.iter().any(|c| c.kind.is_none()));
    assert!(vectors.cases.iter().any(|c| c.kind_mysql.is_some()));

    let mut failures = Vec::new();
    for case in &vectors.cases {
        let mysql_expected = case.kind_mysql.clone().unwrap_or_else(|| case.kind.clone());
        for driver in [t::DriverKind::Postgres, t::DriverKind::Sqlite] {
            let actual = t::classify_dangerous_kind(driver, &case.sql).map(str::to_string);
            if actual != case.kind {
                failures.push(format!(
                    "  - {:?} (note: {}) [{driver:?}]: expected {:?}, got {:?}",
                    case.sql, case.note, case.kind, actual
                ));
            }
        }
        let actual =
            t::classify_dangerous_kind(t::DriverKind::Mysql, &case.sql).map(str::to_string);
        if actual != mysql_expected {
            failures.push(format!(
                "  - {:?} (note: {}) [Mysql]: expected {:?}, got {:?}",
                case.sql, case.note, mysql_expected, actual
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "dangerous-sql golden mismatches ({}):\n{}",
        failures.len(),
        failures.join("\n")
    );
}
