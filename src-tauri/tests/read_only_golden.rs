//! 読み取り専用判定のフロント/バック整合性ゴールデンテスト — バック側。
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
//!
//! ベクタは**ドライバ次元**を持つ (#852): `readOnly` はバックスラッシュを文字列
//! エスケープと見なさない標準解釈 (PostgreSQL / SQLite / DuckDB / MSSQL、および
//! ドライバを渡さない `is_read_only_sql`) での期待値で、MySQL だけ判定が変わる
//! ケースのみ `readOnlyMysql` を持つ。

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
    /// MySQL のバックスラッシュエスケープ解釈での期待値 (省略時は `read_only`)。
    #[serde(rename = "readOnlyMysql", default)]
    read_only_mysql: Option<bool>,
    note: String,
}

/// 標準的な文字列リテラル解釈を採るドライバ (= `readOnly` がそのまま期待値)。
const STANDARD_DRIVERS: [t::DriverKind; 4] = [
    t::DriverKind::Postgres,
    t::DriverKind::Sqlite,
    t::DriverKind::DuckDb,
    t::DriverKind::Mssql,
];

fn load() -> Vectors {
    serde_json::from_str(VECTORS_JSON).expect("shared read-only vectors must be valid JSON")
}

#[test]
fn read_only_golden_matches_shared_vectors() {
    let vectors = load();

    // 取りこぼし防止: フロント側 (readOnlyGolden.test.ts) と同じ下限を要求する。
    assert!(
        vectors.cases.len() >= 30,
        "expected at least 30 shared vectors, got {}",
        vectors.cases.len()
    );

    let mut failures = Vec::new();
    for case in &vectors.cases {
        let mysql_expected = case.read_only_mysql.unwrap_or(case.read_only);

        // ドライバ非依存の呼び出し口は保守的 (標準解釈) 側に倒れる。
        let actual = t::is_read_only_sql(&case.sql);
        if actual != case.read_only {
            failures.push(format!(
                "  - {:?} (note: {}) [driver-less]: expected read_only={}, got {}",
                case.sql, case.note, case.read_only, actual
            ));
        }
        for driver in STANDARD_DRIVERS {
            let actual = t::is_read_only_sql_for(driver, &case.sql);
            if actual != case.read_only {
                failures.push(format!(
                    "  - {:?} (note: {}) [{driver:?}]: expected read_only={}, got {}",
                    case.sql, case.note, case.read_only, actual
                ));
            }
        }
        let actual = t::is_read_only_sql_for(t::DriverKind::Mysql, &case.sql);
        if actual != mysql_expected {
            failures.push(format!(
                "  - {:?} (note: {}) [Mysql]: expected read_only={mysql_expected}, got {actual}",
                case.sql, case.note
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "is_read_only_sql diverged from the shared golden vectors (フロント isReadOnlySql とズレています):\n{}",
        failures.join("\n")
    );
}

/// ドライバ次元 (#852) が形骸化していないことの確認。MySQL だけ判定が分かれる
/// ケースが 1 件も無くなると、マスクの取り違えを誰も検出できなくなる。
#[test]
fn read_only_golden_exercises_the_driver_dimension() {
    let vectors = load();
    assert!(
        vectors
            .cases
            .iter()
            .any(|c| c.read_only_mysql.is_some_and(|m| m != c.read_only)),
        "shared vectors must keep at least one case where MySQL's backslash-escape \
         reading diverges from the standard one (#852)"
    );
}
