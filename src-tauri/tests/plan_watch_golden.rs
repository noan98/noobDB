//! 実行計画ウォッチ (#743 / #1260) のフロント/バック整合性ゴールデンテスト — バック側。
//!
//! 計画の正規化 (`PlanOp`)・フィンガープリント・2 世代の比較は、フロント
//! (`src/components/explainPlan.ts` / `planDiff.ts`) とバック (`src-tauri/src/plan_watch`)
//! で独立に二重実装されている。両者が**同一の共有ベクタ**
//! (`src/__tests__/fixtures/planWatchVectors.json`) を読み、期待値と一致することを検証
//! することで、片方だけロジックを変えてもう片方とズレた場合に即座に検出する。期待値は
//! フロントの実出力から生成した。フロント側は同じ JSON を import して
//! `src/__tests__/planWatchGolden.test.ts` で対になる検証を行う。

use noobdb_lib::__test_api as t;
use serde::Deserialize;
use serde_json::Value;

const VECTORS_JSON: &str = include_str!("../../src/__tests__/fixtures/planWatchVectors.json");

#[derive(Deserialize)]
struct Vectors {
    ops: Vec<OpsCase>,
    compare: Vec<CompareCase>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Snap {
    driver: String,
    payload_kind: String,
    payload: String,
}

#[derive(Deserialize)]
struct OpsCase {
    name: String,
    #[serde(flatten)]
    snap: Snap,
    ops: Value,
    fingerprint: String,
}

#[derive(Deserialize)]
struct CompareCase {
    name: String,
    prev: Snap,
    next: Snap,
    changes: Value,
}

fn kind_of(s: &str) -> t::PlanPayloadKind {
    match s {
        "json" => t::PlanPayloadKind::Json,
        "sqliteRows" => t::PlanPayloadKind::SqliteRows,
        other => panic!("unknown payload kind {other}"),
    }
}

fn ops_of(s: &Snap) -> Vec<t::PlanOp> {
    t::ops_from_payload(&s.driver, kind_of(&s.payload_kind), &s.payload)
}

/// JSON の数値を f64 に揃える (`1000` と `1000.0` を同一視する)。
fn canon(v: Value) -> Value {
    match v {
        Value::Number(n) => n
            .as_f64()
            .and_then(serde_json::Number::from_f64)
            .map_or(Value::Null, Value::Number),
        Value::Array(a) => Value::Array(a.into_iter().map(canon).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (k, canon(v))).collect()),
        other => other,
    }
}

#[test]
fn ops_and_fingerprints_match_the_shared_vectors() {
    let vectors: Vectors = serde_json::from_str(VECTORS_JSON).expect("vectors parse");
    assert!(vectors.ops.len() >= 30, "vectors look truncated");
    for case in &vectors.ops {
        let ops = ops_of(&case.snap);
        let got = canon(serde_json::to_value(&ops).expect("ops serialize"));
        assert_eq!(got, canon(case.ops.clone()), "ops: {}", case.name);
        assert_eq!(
            t::plan_fingerprint(&ops),
            case.fingerprint,
            "fingerprint: {}",
            case.name
        );
    }
}

#[test]
fn comparisons_match_the_shared_vectors() {
    let vectors: Vectors = serde_json::from_str(VECTORS_JSON).expect("vectors parse");
    assert!(vectors.compare.len() >= 20, "vectors look truncated");
    for case in &vectors.compare {
        let changes = t::compare_plans(
            &ops_of(&case.prev),
            &ops_of(&case.next),
            t::DEFAULT_ROW_FACTOR,
        );
        let got = canon(serde_json::to_value(&changes).expect("changes serialize"));
        assert_eq!(got, canon(case.changes.clone()), "compare: {}", case.name);
    }
}
