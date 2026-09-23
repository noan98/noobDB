//! スクリプト文分割のフロント/バック整合性ゴールデン — バック側 (#973)。
//!
//! エディタのバッチ実行はフロント `src/sqlScript.ts` の `splitSqlStatements` で、
//! `.sql` ファイルのスクリプトランナーはバック `src-tauri/src/db/script.rs` の
//! `ScriptSplitter` (チャンク単位で読み進めるストリーミング実装) で文を切り出す。
//! 両者は独立した二重実装なので、同じ共有ベクタ
//! (`src/__tests__/fixtures/scriptSplitVectors.json`) を読んで同じ結果になることを
//! ここ (Rust) と `src/__tests__/scriptSplitGolden.test.ts` (フロント) の両方で固定する。
//!
//! ベクタは `maskVectors.json` と同じくドライバ次元を持つ: `statements` は MySQL 以外
//! (バックスラッシュを文字列エスケープとみなさない) での期待値、MySQL だけ結果が
//! 変わるケースは `statementsMysql` を持つ。

use noobdb_lib::__test_api as t;
use serde::Deserialize;

const VECTORS_JSON: &str = include_str!("../../src/__tests__/fixtures/scriptSplitVectors.json");

#[derive(Deserialize)]
struct Vectors {
    drivers: Vec<String>,
    cases: Vec<VectorCase>,
}

#[derive(Deserialize)]
struct VectorCase {
    sql: String,
    note: String,
    statements: Vec<String>,
    #[serde(rename = "statementsMysql", default)]
    statements_mysql: Option<Vec<String>>,
}

#[test]
fn script_split_matches_shared_vectors() {
    let vectors: Vectors =
        serde_json::from_str(VECTORS_JSON).expect("shared script split vectors must be valid JSON");
    assert!(vectors.cases.len() >= 15, "ベクタが想定より少ない");
    for name in &vectors.drivers {
        let driver = t::DriverKind::parse(name).expect("known driver name");
        for case in &vectors.cases {
            let expected = if driver == t::DriverKind::Mysql {
                case.statements_mysql.as_ref().unwrap_or(&case.statements)
            } else {
                &case.statements
            };
            assert_eq!(
                &t::split_script(driver, &case.sql),
                expected,
                "driver={name} note={} sql={:?}",
                case.note,
                case.sql
            );
        }
    }
}
