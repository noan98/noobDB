//! コメント/リテラル・マスキングのフロント/バック整合性ゴールデンテスト — バック側
//! (#988)。
//!
//! read-only 判定・auto-limit・stacked 検出・危険 SQL 検出・preflight の COUNT
//! プローブ・flight recorder といった全安全網は「まずコメント/リテラルをマスクして
//! からキーワード走査する」という同一の土台の上に立つ。この土台がフロント
//! (`src/dangerousSql.ts` の `maskLiterals`) とバック (`src-tauri/src/db/mod.rs` の
//! `mask_for_analysis_conservative` / `mask_for_driver`) で独立に二重実装されている。
//! 両者が**同一の共有ベクタ** (`src/__tests__/fixtures/maskVectors.json`) を読み、
//! 各 SQL のマスク後の文字列が期待値と一致することを検証することで、片方だけ
//! ロジックを変えてもう片方とズレた場合に即座に検出できるようにする。フロント側は
//! 同じ JSON を import して `src/__tests__/maskGolden.test.ts` で対になる検証を行う。
//!
//! ベクタはフロントのテスト資産配下に 1 つだけ置き、ここからは `include_str!` で
//! 取り込む (リポジトリ内の単一ソースを両言語が参照する構成。#444 / #880 と同型)。
//!
//! ベクタは**ドライバ次元**を持つ (#852): `masked` はバックスラッシュを文字列
//! エスケープと見なさない標準解釈 (PostgreSQL / SQLite / DuckDB / MSSQL、および
//! ドライバを渡さない `mask_for_analysis_conservative`) での期待値で、MySQL だけ
//! 判定が変わるケースのみ `masked_mysql` を持つ。

use noobdb_lib::__test_api as t;
use serde::Deserialize;

// フロントのテスト資産配下にある共有ベクタを、このテストファイルからの相対パスで
// 埋め込む。src-tauri/tests/ から見てリポジトリ root の src/__tests__/fixtures/。
const VECTORS_JSON: &str = include_str!("../../src/__tests__/fixtures/maskVectors.json");

#[derive(Deserialize)]
struct Vectors {
    drivers: Vec<String>,
    cases: Vec<VectorCase>,
}

#[derive(Deserialize)]
struct VectorCase {
    sql: String,
    note: String,
    masked: String,
    /// MySQL のバックスラッシュエスケープ解釈での期待値 (省略時は `masked`)。
    #[serde(rename = "maskedMysql", default)]
    masked_mysql: Option<String>,
}

/// 標準的な文字列リテラル解釈を採るドライバ (= `masked` がそのまま期待値)。
const STANDARD_DRIVERS: [t::DriverKind; 4] = [
    t::DriverKind::Postgres,
    t::DriverKind::Sqlite,
    t::DriverKind::DuckDb,
    t::DriverKind::Mssql,
];

fn load() -> Vectors {
    serde_json::from_str(VECTORS_JSON).expect("shared mask vectors must be valid JSON")
}

#[test]
fn mask_golden_matches_shared_vectors() {
    let vectors = load();

    // 取りこぼし防止: フロント側 (maskGolden.test.ts) と同じ下限を要求する。
    assert!(
        vectors.cases.len() >= 15,
        "expected at least 15 shared vectors, got {}",
        vectors.cases.len()
    );

    let mut failures = Vec::new();
    for case in &vectors.cases {
        let mysql_expected = case.masked_mysql.as_deref().unwrap_or(&case.masked);

        // マスク後も長さは常に元の SQL と同じ (キーワードのオフセットが保たれる)。
        assert_eq!(
            case.masked.chars().count(),
            case.sql.chars().count(),
            "vector {:?} (note: {}): `masked` must be the same length as `sql`",
            case.sql,
            case.note
        );
        assert_eq!(
            mysql_expected.chars().count(),
            case.sql.chars().count(),
            "vector {:?} (note: {}): `maskedMysql` must be the same length as `sql`",
            case.sql,
            case.note
        );

        // ドライバ非依存の呼び出し口は保守的 (標準解釈) 側に倒れる。
        let actual = t::mask_for_analysis_conservative(&case.sql);
        if actual != case.masked {
            failures.push(format!(
                "  - {:?} (note: {}) [driver-less/conservative]: expected {:?}, got {:?}",
                case.sql, case.note, case.masked, actual
            ));
        }
        for driver in STANDARD_DRIVERS {
            let actual = t::mask_for_driver(driver, &case.sql);
            if actual != case.masked {
                failures.push(format!(
                    "  - {:?} (note: {}) [{driver:?}]: expected {:?}, got {:?}",
                    case.sql, case.note, case.masked, actual
                ));
            }
        }
        let actual = t::mask_for_driver(t::DriverKind::Mysql, &case.sql);
        if actual != mysql_expected {
            failures.push(format!(
                "  - {:?} (note: {}) [Mysql]: expected {:?}, got {:?}",
                case.sql, case.note, mysql_expected, actual
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "mask_for_driver / mask_for_analysis_conservative diverged from the shared golden \
         vectors (フロント maskLiterals とズレています):\n{}",
        failures.join("\n")
    );
}

/// ドライバ次元 (#852) が形骸化していないことの確認。MySQL だけマスク結果が分かれる
/// ケースが 1 件も無くなると、マスクの取り違えを誰も検出できなくなる。
#[test]
fn mask_golden_exercises_the_driver_dimension() {
    let vectors = load();
    assert!(
        vectors
            .cases
            .iter()
            .any(|c| c.masked_mysql.as_ref().is_some_and(|m| m != &c.masked)),
        "shared vectors must keep at least one case where MySQL's backslash-escape \
         reading diverges from the standard one (#852)"
    );
}

/// ドライバの取りこぼし防止: ベクタが `DriverKind` の全バリアントを覆っているか。
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
