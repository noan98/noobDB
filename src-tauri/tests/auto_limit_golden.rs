//! 自動行キャップ (`apply_auto_limit_for`) の実装横断ゴールデンテスト — バック側
//! (#990)。
//!
//! `src-tauri/src/db/mod.rs` の自動 LIMIT/TOP 挿入は、末尾に `LIMIT n` を足す
//! 汎用パス (MySQL/PostgreSQL/SQLite/DuckDB が共有) と、`SELECT [DISTINCT]` の
//! 直後に `TOP (n)` を挿入する MSSQL 専用パスの 2 系統に分かれ、それぞれ
//! チェックするキーワード集合も異なる (汎用パスは `limit`/`offset`/`fetch`、
//! MSSQL パスは `top`/`offset`/`fetch`)。#969 (`FETCH FIRST … ROWS ONLY` に
//! `LIMIT` を継ぎ足す不正 SQL) はこの非対称に起因するバグで、既に修正済み。
//!
//! このテストは `src/__tests__/fixtures/autoLimitVectors.json` の共有ベクタを
//! `include_str!` で取り込み、各ケースについて `apply_auto_limit_for` を
//! 5 ドライバすべて (MySQL / PostgreSQL / SQLite / DuckDB / MSSQL) に通して
//! 期待書き換え結果 (または「変更しない」= `null`) と突き合わせる。フロント側の
//! 実装は無いため (#990 のスコープはバックエンドのみ)、対になるフロントテストは
//! 無い — 純粋にこの安全網の書き換えロジックの回帰を固定する。

use noobdb_lib::__test_api as t;
use serde::Deserialize;

const VECTORS_JSON: &str = include_str!("../../src/__tests__/fixtures/autoLimitVectors.json");

#[derive(Deserialize)]
struct Vectors {
    drivers: Vec<String>,
    cases: Vec<VectorCase>,
}

#[derive(Deserialize)]
struct VectorCase {
    sql: String,
    limit: usize,
    note: String,
    expected: ExpectedByDriver,
}

#[derive(Deserialize)]
struct ExpectedByDriver {
    mysql: Option<String>,
    postgres: Option<String>,
    sqlite: Option<String>,
    duckdb: Option<String>,
    mssql: Option<String>,
}

impl ExpectedByDriver {
    fn get(&self, driver: t::DriverKind) -> &Option<String> {
        match driver {
            t::DriverKind::Mysql => &self.mysql,
            t::DriverKind::Postgres => &self.postgres,
            t::DriverKind::Sqlite => &self.sqlite,
            t::DriverKind::DuckDb => &self.duckdb,
            t::DriverKind::Mssql => &self.mssql,
        }
    }
}

const ALL_DRIVERS: [t::DriverKind; 5] = [
    t::DriverKind::Mysql,
    t::DriverKind::Postgres,
    t::DriverKind::Sqlite,
    t::DriverKind::DuckDb,
    t::DriverKind::Mssql,
];

fn load() -> Vectors {
    serde_json::from_str(VECTORS_JSON).expect("shared auto-limit vectors must be valid JSON")
}

#[test]
fn auto_limit_golden_matches_shared_vectors() {
    let vectors = load();

    assert!(
        vectors.cases.len() >= 30,
        "expected at least 30 shared vectors, got {}",
        vectors.cases.len()
    );

    let mut failures = Vec::new();
    for case in &vectors.cases {
        for driver in ALL_DRIVERS {
            let expected = case.expected.get(driver);
            let actual = t::apply_auto_limit_for(driver, &case.sql, case.limit);
            if &actual != expected {
                failures.push(format!(
                    "  - {:?} limit={} (note: {}) [{driver:?}]: expected {:?}, got {:?}",
                    case.sql, case.limit, case.note, expected, actual
                ));
            }
        }
    }

    assert!(
        failures.is_empty(),
        "apply_auto_limit_for diverged from the shared golden vectors:\n{}",
        failures.join("\n")
    );
}

/// 取りこぼし防止: ベクタが `DriverKind` の全バリアントを覆っているか。
#[test]
fn vectors_cover_every_driver() {
    let vectors = load();
    for driver in ALL_DRIVERS {
        assert!(
            vectors.drivers.iter().any(|d| d == driver.as_str()),
            "shared vectors must list {driver:?} in `drivers`"
        );
    }
}

/// ドライバ差 (#990) が形骸化していないことの確認: LIMIT 系 4 ドライバと MSSQL の
/// TOP とで結果が分かれるケースが最低 1 件は残っていること (MSSQL が None を返す
/// のに他が書き換えるケース、またはその逆)。
#[test]
fn vectors_exercise_the_limit_vs_top_dimension() {
    let vectors = load();
    assert!(
        vectors.cases.iter().any(|c| {
            let e = &c.expected;
            e.mssql != e.mysql
                || e.mssql != e.postgres
                || e.mssql != e.sqlite
                || e.mssql != e.duckdb
        }),
        "shared vectors must keep at least one case where MSSQL's TOP diverges from the \
         other drivers' trailing LIMIT (#990)"
    );
}

/// ドライバ差 (#852) が形骸化していないことの確認: MySQL のバックスラッシュ
/// エスケープ解釈が他の標準解釈ドライバと分かれるケースが残っていること。
#[test]
fn vectors_exercise_the_mysql_backslash_dimension() {
    let vectors = load();
    assert!(
        vectors
            .cases
            .iter()
            .any(|c| c.expected.mysql != c.expected.postgres),
        "shared vectors must keep at least one case where MySQL's backslash-escape \
         reading diverges from the standard one (#852)"
    );
}

/// #969 の回帰ケース自体がベクタに残っていることの確認 (テストの土台となる
/// フィクスチャが将来書き換えられて薄まらないようにするための明示的な固定)。
#[test]
fn vectors_include_the_969_regression_case() {
    let vectors = load();
    assert!(
        vectors
            .cases
            .iter()
            .any(|c| c.sql.to_ascii_lowercase().contains("fetch first")
                && c.expected.mysql.is_none()
                && c.expected.mssql.is_none()),
        "shared vectors must keep a `FETCH FIRST … ROWS ONLY` case left untouched on both \
         the LIMIT and TOP paths (#969)"
    );
}
