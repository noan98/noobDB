//! 自動行キャップ (`apply_auto_limit_for`) の実装横断ゴールデンテスト — バック側
//! (#990)。
//!
//! `src-tauri/src/db/mod.rs` の自動 LIMIT 挿入は、末尾に `LIMIT n` を足す
//! 汎用パス (MySQL/PostgreSQL/SQLite が共有) で、チェックするキーワード集合は
//! `limit`/`offset`/`fetch`。#969 (`FETCH FIRST … ROWS ONLY` に `LIMIT` を
//! 継ぎ足す不正 SQL) は既に修正済み。
//!
//! このテストは `src/__tests__/fixtures/autoLimitVectors.json` の共有ベクタを
//! `include_str!` で取り込み、各ケースについて `apply_auto_limit_for` を
//! 3 ドライバすべて (MySQL / PostgreSQL / SQLite) に通して期待書き換え結果
//! (または「変更しない」= `null`) と突き合わせる。フロント側の実装は無いため
//! (#990 のスコープはバックエンドのみ)、対になるフロントテストは無い —
//! 純粋にこの安全網の書き換えロジックの回帰を固定する。

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
}

impl ExpectedByDriver {
    fn get(&self, driver: t::DriverKind) -> &Option<String> {
        match driver {
            t::DriverKind::Mysql => &self.mysql,
            t::DriverKind::Postgres => &self.postgres,
            t::DriverKind::Sqlite => &self.sqlite,
        }
    }
}

const ALL_DRIVERS: [t::DriverKind; 3] = [
    t::DriverKind::Mysql,
    t::DriverKind::Postgres,
    t::DriverKind::Sqlite,
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
                && c.expected.mysql.is_none()),
        "shared vectors must keep a `FETCH FIRST … ROWS ONLY` case left untouched on the \
         LIMIT path (#969)"
    );
}
