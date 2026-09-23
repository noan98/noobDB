//! 文境界 (トップレベルの `;` による文分割) のフロント/バック整合性ゴールデン
//! テスト — バック側 (#1074)。
//!
//! フロントの文分割器 (`src/sqlScript.ts` の `splitSqlStatements`) はバッチ実行・
//! カーソル位置の文実行 (#555)・フライトレコーダの単位を決める。これは
//! `maskLiterals` (`src/dangerousSql.ts`) でコメント/リテラルを空白化し、マスク後に
//! 残った `;` の位置で元の SQL を切る実装になっている。バックエンドには同じ
//! マスク (`mask_for_driver`、`maskVectors.json` で一致を固定済み、#988) がある
//! ので、ここでは**バックエンドのマスクで同じ規則の分割**をして、共有ベクタ
//! (`src/__tests__/fixtures/statementSplitVectors.json`) の文境界と一致することを
//! 検証する。マスクのどちらか一方だけが文境界に効く形で変わると、このテストか
//! フロントの `statementSplitGolden.test.ts` のどちらかが落ちる。
//!
//! 加えて、フロントが 2 文以上と見る入力は、バックエンドの stacked 文検出
//! (`has_stacked_statements_for`、`preview_execute_with_limit` などが使う) も
//! 必ず stacked と判定することを確認する (フロントが複数文として扱う入力を
//! バックが単文と見なす食い違いの検出)。
//!
//! ベクタは**ドライバ次元**を持つ (#852 / #1004): `statements` はバックスラッシュを
//! 文字列エスケープと見なさない標準解釈の期待値で、MySQL だけ結果が変わるケース
//! のみ `statementsMysql` を持つ。

use noobdb_lib::__test_api as t;
use serde::Deserialize;

const VECTORS_JSON: &str = include_str!("../../src/__tests__/fixtures/statementSplitVectors.json");

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
    /// MySQL のバックスラッシュエスケープ解釈での期待値 (省略時は `statements`)。
    #[serde(rename = "statementsMysql", default)]
    statements_mysql: Option<Vec<String>>,
}

const ALL_DRIVERS: [t::DriverKind; 5] = [
    t::DriverKind::Mysql,
    t::DriverKind::Postgres,
    t::DriverKind::Sqlite,
    t::DriverKind::DuckDb,
    t::DriverKind::Mssql,
];

fn load() -> Vectors {
    serde_json::from_str(VECTORS_JSON).expect("shared statement-split vectors must be valid JSON")
}

/// フロント `splitSqlStatementRanges` と同じ規則の分割を、バックエンドのマスクの
/// 上で行う。マスク後に残る `;` がトップレベルの区切りで、マスク後の断片が
/// 空白と (MySQL バージョンコメントの素通しされた閉じ) `*/` だけなら文として
/// 数えない。本文は元の SQL の同じ位置をトリムしたもの。
fn split_with_backend_mask(driver: t::DriverKind, sql: &str) -> Vec<String> {
    let orig: Vec<char> = sql.chars().collect();
    let masked: Vec<char> = t::mask_for_driver(driver, sql).chars().collect();
    assert_eq!(masked.len(), orig.len(), "mask must preserve length");

    let mut out = Vec::new();
    let mut push = |start: usize, end: usize| {
        let masked_seg: String = masked[start..end].iter().collect();
        if masked_seg.replace("*/", "").trim().is_empty() {
            return;
        }
        let raw: String = orig[start..end].iter().collect();
        out.push(raw.trim().to_string());
    };
    let mut seg_start = 0;
    for (i, c) in masked.iter().enumerate() {
        if *c == ';' {
            push(seg_start, i);
            seg_start = i + 1;
        }
    }
    push(seg_start, masked.len());
    out
}

#[test]
fn statement_split_golden_matches_shared_vectors() {
    let vectors = load();
    // 取りこぼし防止: フロント側 (statementSplitGolden.test.ts) と同じ下限。
    assert!(
        vectors.cases.len() >= 20,
        "expected at least 20 shared vectors, got {}",
        vectors.cases.len()
    );

    let mut failures = Vec::new();
    for case in &vectors.cases {
        for driver in ALL_DRIVERS {
            let expected = match (driver, &case.statements_mysql) {
                (t::DriverKind::Mysql, Some(m)) => m,
                _ => &case.statements,
            };
            let actual = split_with_backend_mask(driver, &case.sql);
            if &actual != expected {
                failures.push(format!(
                    "  - {:?} (note: {}) [{driver:?}]: expected {:?}, got {:?}",
                    case.sql, case.note, expected, actual
                ));
            }
            // フロントが複数文と見るなら、バックの stacked 検出も必ず true。
            if expected.len() > 1 && !t::has_stacked_statements_for(driver, &case.sql) {
                failures.push(format!(
                    "  - {:?} (note: {}) [{driver:?}]: front splits into {} statements but \
                     has_stacked_statements_for returned false",
                    case.sql,
                    case.note,
                    expected.len()
                ));
            }
        }
    }

    assert!(
        failures.is_empty(),
        "statement boundaries under the backend mask diverged from the shared golden \
         vectors (フロント splitSqlStatements とズレています):\n{}",
        failures.join("\n")
    );
}

/// ドライバ次元 (#1004) が形骸化していないことの確認。
#[test]
fn statement_split_golden_exercises_the_driver_dimension() {
    let vectors = load();
    assert!(
        vectors.cases.iter().any(|c| c
            .statements_mysql
            .as_ref()
            .is_some_and(|m| m != &c.statements)),
        "shared vectors must keep at least one case where MySQL's backslash-escape \
         reading changes the statement boundaries (#1004)"
    );
}

/// ドライバの取りこぼし防止: ベクタが `DriverKind` の全バリアントを覆っているか。
#[test]
fn statement_split_vectors_cover_every_driver() {
    let vectors = load();
    for driver in ALL_DRIVERS {
        assert!(
            vectors.drivers.iter().any(|d| d == driver.as_str()),
            "shared vectors must list {driver:?} in `drivers`"
        );
    }
}
