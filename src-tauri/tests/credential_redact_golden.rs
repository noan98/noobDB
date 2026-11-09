//! SQL 中の資格情報リテラルの伏せ字化 ゴールデンテスト — バック側 (#2174)。
//!
//! フロント (`src/sqlCredentials.ts`) とバック (`src-tauri/src/sql_credentials.rs`) は判定を
//! 二重実装している。両者が同一の共有ベクタ
//! (`src/__tests__/fixtures/credentialRedactVectors.json`) を読み、同じ結果になることを固定する。
//! フロント側は `src/__tests__/credentialRedactGolden.test.ts`。
//! `mysql` / `postgres` が無いケースは「そのドライバでは変更なし」、SQLite は常に変更なし。

use noobdb_lib::__test_api as t;
use serde::Deserialize;

const VECTORS_JSON: &str =
    include_str!("../../src/__tests__/fixtures/credentialRedactVectors.json");

#[derive(Deserialize)]
struct Vectors {
    drivers: Vec<String>,
    placeholder: String,
    cases: Vec<VectorCase>,
    #[serde(rename = "errorCases")]
    error_cases: Vec<ErrorCase>,
}

#[derive(Deserialize)]
struct ErrorCase {
    note: String,
    sql: String,
    error: String,
    mysql: String,
    postgres: String,
}

#[derive(Deserialize)]
struct VectorCase {
    sql: String,
    note: String,
    #[serde(default)]
    mysql: Option<String>,
    #[serde(default)]
    postgres: Option<String>,
}

#[test]
fn credential_redact_matches_shared_vectors() {
    let vectors: Vectors =
        serde_json::from_str(VECTORS_JSON).expect("shared credential vectors must be valid JSON");
    assert_eq!(vectors.drivers, ["mysql", "postgres", "sqlite"]);
    assert_eq!(vectors.placeholder, "'********'");
    assert!(
        vectors.cases.len() >= 40,
        "expected at least 40 shared vectors, got {}",
        vectors.cases.len()
    );

    let mut failures = Vec::new();
    for case in &vectors.cases {
        let expected = [
            (
                t::DriverKind::Mysql,
                case.mysql.as_deref().unwrap_or(&case.sql),
            ),
            (
                t::DriverKind::Postgres,
                case.postgres.as_deref().unwrap_or(&case.sql),
            ),
            (t::DriverKind::Sqlite, case.sql.as_str()),
        ];
        for (driver, want) in expected {
            let got = t::redact_credentials(driver, &case.sql);
            if got != want {
                failures.push(format!(
                    "  - {:?} (note: {}) [{driver:?}]: expected {:?}, got {:?}",
                    case.sql, case.note, want, got
                ));
            }
            // 冪等 (伏せ済みをもう一度通しても変わらない)。
            let again = t::redact_credentials(driver, &got);
            if again != got {
                failures.push(format!(
                    "  - {:?} (note: {}) [{driver:?}]: not idempotent: {:?} -> {:?}",
                    case.sql, case.note, got, again
                ));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "redact_credentials diverged from the shared golden vectors (フロント redactCredentials とズレています):\n{}",
        failures.join("\n")
    );
}

#[test]
fn credential_error_text_matches_shared_vectors() {
    let vectors: Vectors =
        serde_json::from_str(VECTORS_JSON).expect("shared credential vectors must be valid JSON");
    assert!(vectors.error_cases.len() >= 5);
    let mut failures = Vec::new();
    for case in &vectors.error_cases {
        let expected = [
            (t::DriverKind::Mysql, case.mysql.as_str()),
            (t::DriverKind::Postgres, case.postgres.as_str()),
            (t::DriverKind::Sqlite, case.error.as_str()),
        ];
        for (driver, want) in expected {
            let got = t::redact_error_text(driver, &case.error, &case.sql);
            if got != want {
                failures.push(format!(
                    "  - {:?} (note: {}) [{driver:?}]: expected {:?}, got {:?}",
                    case.error, case.note, want, got
                ));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "redact_error_text diverged from the shared golden vectors:\n{}",
        failures.join("\n")
    );
}
