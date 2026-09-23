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
//!
//! **xlsx (#711)** はバイナリ (ZIP) でフロントにプレビュー実装が無いため、テキストの
//! `expected` ではなく各ケースの `xlsxCells` (セル種別 + 値の 2 次元配列。表記は
//! `__test_api::xlsx_cell_repr`) で固定する。検証は 2 段: (1) 判定関数 `xlsx_cell` が
//! `xlsxCells` と一致すること、(2) 実際に `write_export_to` が書いた xlsx を展開し、
//! シート XML から読み戻したセルも `xlsxCells` と一致すること (= 判定どおりに
//! 書かれている)。

use noobdb_lib::__test_api as t;
use serde::Deserialize;
use std::collections::BTreeMap;

const VECTORS_JSON: &str = include_str!("../../src/__tests__/fixtures/exportFormatVectors.json");

/// ベクタの `expected` が覆うテキスト書式。`ExportFormat` のうち xlsx 以外の全
/// バリアントと一致していること (xlsx は `xlsxCells` で別途固定する。
/// [`every_export_format_is_covered`] がバリアント追加時の取りこぼしを検出する)。
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
    /// xlsx のセル (ヘッダ行を含む)。表記は `t::xlsx_cell_repr`。
    #[serde(default, rename = "xlsxCells")]
    xlsx_cells: Option<Vec<Vec<String>>>,
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

fn columns_of(case: &Case) -> Vec<t::Column> {
    case.columns
        .iter()
        .map(|c| t::Column {
            name: c.name.clone(),
            type_name: c.type_name.clone(),
        })
        .collect()
}

fn rows_of(case: &Case) -> Vec<Vec<t::Value>> {
    case.rows
        .iter()
        .map(|r| r.iter().map(cell).collect())
        .collect()
}

fn render_bytes(case: &Case, format: t::ExportFormat) -> Vec<u8> {
    let columns = columns_of(case);
    let rows = rows_of(case);
    let driver = t::DriverKind::parse(&case.sql.driver)
        .unwrap_or_else(|| panic!("unknown driver in vectors: {}", case.sql.driver));
    t::export_bytes(
        format,
        &columns,
        &rows,
        case.query.as_deref(),
        Some(driver),
        Some(case.sql.table.clone()),
        Some(case.sql.batch_size),
    )
    .expect("export must succeed for in-memory vectors")
}

fn render(case: &Case, format: t::ExportFormat) -> String {
    String::from_utf8(render_bytes(case, format)).expect("export output must be valid UTF-8")
}

/// 判定関数 (`xlsx_cell`) から見た xlsx のセル。1 行目はヘッダ (列名の文字列セル)。
fn xlsx_cells(case: &Case) -> Vec<Vec<String>> {
    let columns = columns_of(case);
    let mut out = vec![columns
        .iter()
        .map(|c| t::xlsx_cell_repr(&t::Value::String(c.name.clone()), None))
        .collect::<Vec<_>>()];
    for row in rows_of(case) {
        out.push(
            columns
                .iter()
                .enumerate()
                .map(|(i, c)| t::xlsx_cell_repr(row.get(i).unwrap_or(&t::Value::Null), Some(c)))
                .collect(),
        );
    }
    out
}

/// 実際に書き出した xlsx を展開し、シート XML からセルを読み戻す。
/// `rust_xlsxwriter` の定数メモリモードの出力 (インライン文字列 `t="inlineStr"`・
/// 真偽 `t="b"`・数値は型属性なし) だけを読めればよい最小パーサ。
fn read_back_xlsx(bytes: &[u8], width: usize) -> Vec<Vec<String>> {
    use std::io::Read;
    let mut archive =
        zip::ZipArchive::new(std::io::Cursor::new(bytes)).expect("xlsx must be a valid zip");
    // Excel / LibreOffice が要求する最小構成が揃っていること。
    for required in [
        "[Content_Types].xml",
        "_rels/.rels",
        "xl/workbook.xml",
        "xl/_rels/workbook.xml.rels",
        "xl/styles.xml",
    ] {
        assert!(
            archive.by_name(required).is_ok(),
            "xlsx is missing {required}"
        );
    }
    let mut xml = String::new();
    archive
        .by_name("xl/worksheets/sheet1.xml")
        .expect("sheet1.xml")
        .read_to_string(&mut xml)
        .expect("sheet1.xml must be UTF-8");

    let mut rows: Vec<Vec<String>> = Vec::new();
    for row_xml in xml.split("<row ").skip(1) {
        let row_xml = row_xml.split("</row>").next().unwrap_or("");
        let mut cells = vec!["-".to_string(); width];
        for cell_xml in row_xml.split("<c ").skip(1) {
            let (attrs, body) = cell_xml.split_once('>').expect("cell tag");
            let r = attr(attrs, "r").expect("cell ref");
            let col = r
                .chars()
                .take_while(|c| c.is_ascii_uppercase())
                .fold(0usize, |acc, c| acc * 26 + (c as usize - 'A' as usize + 1))
                - 1;
            let repr = match attr(attrs, "t").as_deref() {
                Some("inlineStr") => format!("s:{}", unescape_xml(&between(body, "<t", "</t>"))),
                Some("b") => format!("b:{}", between(body, "<v", "</v>") == "1"),
                None => {
                    let v: f64 = between(body, "<v", "</v>").parse().expect("numeric cell");
                    format!("n:{v}")
                }
                Some(other) => panic!("unexpected cell type {other:?} in {cell_xml}"),
            };
            cells[col] = repr;
        }
        rows.push(cells);
    }
    rows
}

fn attr(attrs: &str, name: &str) -> Option<String> {
    let key = format!(" {name}=\"");
    let start = format!(" {attrs}").find(&key)? + key.len() - 1;
    let rest = &attrs[start..];
    Some(rest[..rest.find('"')?].to_string())
}

/// `<t ...>本文</t>` / `<v>値</v>` の本文を取り出す (開きタグの属性は読み飛ばす)。
fn between(body: &str, open: &str, close: &str) -> String {
    let after_open = body
        .split_once(open)
        .map(|(_, rest)| rest)
        .unwrap_or_else(|| panic!("missing {open} in {body}"));
    let (_, content) = after_open.split_once('>').expect("open tag end");
    content.split(close).next().unwrap_or("").to_string()
}

fn unescape_xml(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
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

/// `ExportFormat` にバリアントを足したら、ここ (網羅 match) がコンパイルエラーになり、
/// テキスト書式なら `FORMATS`、バイナリ書式なら専用のゴールデンへの追加を促す。
#[test]
fn every_export_format_is_covered() {
    fn covered(f: t::ExportFormat) -> bool {
        match f {
            t::ExportFormat::Csv
            | t::ExportFormat::Json
            | t::ExportFormat::Ndjson
            | t::ExportFormat::Markdown
            | t::ExportFormat::Sql => FORMATS
                .iter()
                .any(|(_, g)| std::mem::discriminant(g) == std::mem::discriminant(&f)),
            // xlsx は `xlsx_cells_match_shared_vectors` / `xlsx_file_matches_shared_vectors`。
            t::ExportFormat::Xlsx => true,
        }
    }
    for (_, f) in FORMATS {
        assert!(covered(f));
    }
    assert!(covered(t::ExportFormat::Xlsx));
}

/// xlsx (#711): 値 → セル種別の判定がベクタの `xlsxCells` と一致する。
#[test]
fn xlsx_cells_match_shared_vectors() {
    let vectors = load();
    let mut failures = Vec::new();
    for case in &vectors.cases {
        let expected = case
            .xlsx_cells
            .as_ref()
            .unwrap_or_else(|| panic!("export vector {:?} is missing xlsxCells", case.name));
        let actual = xlsx_cells(case);
        if &actual != expected {
            failures.push(format!(
                "  - {} (note: {})\n      expected: {expected:?}\n      actual:   {actual:?}",
                case.name, case.note
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "xlsx cell mapping diverged from the shared golden vectors:\n{}",
        failures.join("\n")
    );
}

/// xlsx (#711): 実ファイルと同じ `write_export_to` が書いた xlsx を展開して読み戻した
/// セルが `xlsxCells` と一致する (判定どおりに書かれ、ZIP として有効)。
#[test]
fn xlsx_file_matches_shared_vectors() {
    let vectors = load();
    for case in &vectors.cases {
        let Some(expected) = case.xlsx_cells.as_ref() else {
            continue;
        };
        let bytes = render_bytes(case, t::ExportFormat::Xlsx);
        let actual = read_back_xlsx(&bytes, case.columns.len());
        assert_eq!(
            &actual, expected,
            "xlsx file content diverged for vector {:?}",
            case.name
        );
    }
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
        "xlsx-precision-boundaries",
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
        per_format.insert(
            "xlsxCells".to_string(),
            serde_json::to_value(xlsx_cells(case)).unwrap_or_default(),
        );
        // `EXPORT_GOLDEN_XLSX_DIR=<dir>` を付けると各ケースの xlsx を実ファイルとして
        // 書き出す (LibreOffice / Excel で警告なく開けるかを手で確認するため)。
        if let Ok(dir) = std::env::var("EXPORT_GOLDEN_XLSX_DIR") {
            let path = std::path::Path::new(&dir).join(format!("{}.xlsx", case.name));
            std::fs::write(&path, render_bytes(case, t::ExportFormat::Xlsx))
                .expect("write sample xlsx");
        }
        out.insert(case.name.clone(), per_format.into());
    }
    println!(
        "EXPORT_GOLDEN_JSON_BEGIN\n{}\nEXPORT_GOLDEN_JSON_END",
        serde_json::to_string_pretty(&out).unwrap_or_default()
    );
}
