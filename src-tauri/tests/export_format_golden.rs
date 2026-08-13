//! エクスポート書式のフロント↔バック共有ゴールデンテスト — バック側 (#879)。
//!
//! フロントの `src/components/exportPreview.ts::buildExportContent` は、
//! エクスポートモーダルのプレビューと「全文コピー」のために、バックエンドの
//! `commands/export.rs` の書き出しと**バイト一致**するよう独立に再実装されている。
//! 両者に個別テストはあったが、同一入力を両実装へ通して突き合わせる共有ゴールデンが
//! 無く、浮動小数の書式・JSON キーのソート順・CSV インジェクション緩和といった
//! 既知のドリフト源が「プレビューと実ファイルが食い違う」形で静かに壊れうる状態だった。
//!
//! ここは実ファイル出力と**同じ** `write_export_to` を `Vec<u8>` 相手に通すので、
//! 検証対象は「実際に書き出されるバイト列」そのもの。フロント側の対テストは
//! `src/__tests__/exportFormatGolden.test.ts`。
//!
//! ベクタ (`src/__tests__/fixtures/exportFormatVectors.json`) はフロントのテスト資産
//! 配下に 1 つだけ置き、ここからは `include_str!` で取り込む。

use noobdb_lib::__test_api as t;
use serde::Deserialize;
use std::collections::BTreeMap;

const VECTORS_JSON: &str = include_str!("../../src/__tests__/fixtures/exportFormatVectors.json");

/// ベクタが覆う書式。`ExportFormat` の全バリアントと一致していること。
const FORMATS: [(&str, t::ExportFormat); 5] = [
    ("csv", t::ExportFormat::Csv),
    ("json", t::ExportFormat::Json),
    ("ndjson", t::ExportFormat::Ndjson),
    ("markdown", t::ExportFormat::Markdown),
    ("sql", t::ExportFormat::Sql),
];

#[derive(Deserialize)]
struct Vectors {
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    note: String,
    columns: Vec<ColumnSpec>,
    rows: Vec<Vec<CellSpec>>,
    #[serde(default)]
    query: Option<String>,
    sql: SqlSpec,
    #[serde(default)]
    expected: BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct ColumnSpec {
    name: String,
    #[serde(rename = "typeName")]
    type_name: String,
}

#[derive(Deserialize)]
struct CellSpec {
    kind: String,
    #[serde(default)]
    value: serde_json::Value,
}

#[derive(Deserialize)]
struct SqlSpec {
    driver: String,
    table: String,
    #[serde(rename = "batchSize")]
    batch_size: usize,
}

fn load() -> Vectors {
    serde_json::from_str(VECTORS_JSON).expect("shared export vectors must be valid JSON")
}

fn cell(spec: &CellSpec) -> t::Value {
    let v = &spec.value;
    match spec.kind.as_str() {
        "null" => t::Value::Null,
        "bool" => t::Value::Bool(v.as_bool().expect("bool cell needs a bool value")),
        "int" => t::Value::Int(v.as_i64().expect("int cell needs an integer value")),
        "uint" => t::Value::UInt(v.as_u64().expect("uint cell needs an unsigned value")),
        "float" => t::Value::Float(v.as_f64().expect("float cell needs a number value")),
        "string" => t::Value::String(v.as_str().expect("string cell needs a string").to_string()),
        "bytes" => t::Value::Bytes(
            v.as_str()
                .expect("bytes cell needs a hex string")
                .to_string(),
        ),
        other => panic!("unknown cell kind in vectors: {other}"),
    }
}

fn render(case: &Case, format: t::ExportFormat) -> String {
    let columns: Vec<t::Column> = case
        .columns
        .iter()
        .map(|c| t::Column {
            name: c.name.clone(),
            type_name: c.type_name.clone(),
        })
        .collect();
    let rows: Vec<Vec<t::Value>> = case
        .rows
        .iter()
        .map(|r| r.iter().map(cell).collect())
        .collect();
    let driver = t::DriverKind::parse(&case.sql.driver)
        .unwrap_or_else(|| panic!("unknown driver in vectors: {}", case.sql.driver));
    let bytes = t::export_bytes(
        format,
        &columns,
        &rows,
        case.query.as_deref(),
        Some(driver),
        Some(case.sql.table.clone()),
        Some(case.sql.batch_size),
    )
    .expect("export must succeed for in-memory vectors");
    String::from_utf8(bytes).expect("export output must be valid UTF-8")
}

#[test]
fn export_formats_match_shared_vectors() {
    let vectors = load();
    assert!(
        vectors.cases.len() >= 5,
        "expected at least 5 export vectors, got {}",
        vectors.cases.len()
    );

    let mut failures = Vec::new();
    for case in &vectors.cases {
        for (name, format) in FORMATS {
            let expected = case.expected.get(name).unwrap_or_else(|| {
                panic!(
                    "export vector {:?} is missing an expectation for {name}",
                    case.name
                )
            });
            let actual = render(case, format);
            if &actual != expected {
                failures.push(format!(
                    "  - {} / {name} (note: {})\n      expected: {expected:?}\n      actual:   {actual:?}",
                    case.name, case.note
                ));
            }
        }
    }

    assert!(
        failures.is_empty(),
        "export output diverged from the shared golden vectors (フロント buildExportContent とズレています):\n{}",
        failures.join("\n")
    );
}

/// 既知のドリフト源 (#879 が名指しする浮動小数・キーのソート順・CSV インジェクション
/// 緩和) がベクタから抜け落ちていないことの確認。ケース名で緩く固定しておくことで、
/// 「ベクタを整理したら肝心の境界が消えていた」を防ぐ。
#[test]
fn vectors_keep_the_known_drift_sources() {
    let vectors = load();
    for required in [
        "csv-formula-injection",
        "sorted-keys-and-unicode",
        "blob-known-divergence",
        "empty-rows",
        "json-with-query",
    ] {
        assert!(
            vectors.cases.iter().any(|c| c.name == required),
            "shared export vectors must keep the {required:?} case"
        );
    }
}

/// ベクタ生成補助: `EXPORT_GOLDEN_DUMP=1` を付けて実行すると、各ケース × 各書式の
/// 実出力を JSON で標準出力へ書き出す (`cargo test --test export_format_golden
/// dump_export_golden -- --nocapture`)。期待値を手計算せずに起こすためのもので、
/// 通常実行では何もしない。
#[test]
fn dump_export_golden() {
    if std::env::var("EXPORT_GOLDEN_DUMP").is_err() {
        return;
    }
    let vectors = load();
    let mut out = serde_json::Map::new();
    for case in &vectors.cases {
        let mut per_format = serde_json::Map::new();
        for (name, format) in FORMATS {
            per_format.insert(name.to_string(), render(case, format).into());
        }
        out.insert(case.name.clone(), per_format.into());
    }
    println!(
        "EXPORT_GOLDEN_JSON_BEGIN\n{}\nEXPORT_GOLDEN_JSON_END",
        serde_json::to_string_pretty(&out).unwrap_or_default()
    );
}
