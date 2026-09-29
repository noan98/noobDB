//! Excel (xlsx) インポートのパーサ (#1171)。
//!
//! `commands/import.rs` の CSV / JSON / NDJSON と同じ「行の列 → `Vec<Option<String>>`」
//! に変換するだけの薄い層で、マッピング・NULL トークン・エラー行処理・UPSERT・新規
//! テーブル作成は既存の経路にそのまま合流する。対になるエクスポートは
//! `commands/export_xlsx.rs` (往復は本ファイルのテストで固定する)。
//!
//! ## セルの対応 (エクスポートの値の対応の逆)
//!
//! | xlsx セル | 取り込むテキスト |
//! |---|---|
//! | 空セル | NULL (`None`) |
//! | 文字列 | そのまま (エクスポートは数式に化けない文字列セルで書くので往復で一致) |
//! | 数値 (整数値) | 十進整数 (`42`)。`1.0` を `1.0` にせず Excel の見た目に合わせる |
//! | 数値 (小数) | 最短の十進表記 (`0.1`) |
//! | 真偽 | `true` / `false` |
//! | 日時 | 時刻が 0:00:00 なら `YYYY-MM-DD`、それ以外は `YYYY-MM-DD HH:MM:SS[.fff]` |
//! | 経過時間 | `HH:MM:SS` |
//! | エラー値 (`#DIV/0!` など) | NULL (数値列などへ文字列が混ざって取り込みが失敗するのを避ける) |
//!
//! 数式セルは Excel が保存した**計算済みの値**を読む (数式そのものは取り込まない)。
//!
//! ## 行と列
//!
//! - 列インデックスはシート上の絶対列 (A 列 = 0)。行は完全に空の行を読み飛ばす
//!   (CSV の空行と同じ)。
//! - `line` は Excel 上の 1 始まりの行番号で、エラー行の報告に使う (CSV の行番号に相当)。
//! - シートはセルを行順に 1 つずつ読み進め、プレビューは必要な行数で読み取りを打ち切る
//!   (ファイル全体を行列に展開しない)。取り込み本体は既存の `import_rows` が行を
//!   まとめて受け取る設計なので、ここで読み終えた行は保持する。

use std::io::Cursor;

use calamine::{DataRef, Reader, Xlsx};

use crate::error::{AppError, Result};

/// 1 行ぶんの読み取り結果。
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct XlsxRow {
    /// Excel 上の 1 始まりの行番号。
    pub line: u64,
    /// 絶対列順のセル (最後の非空セルまで。空セルは `None`)。
    pub cells: Vec<Option<String>>,
}

/// [`read_sheet`] の結果。
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct XlsxSheet {
    /// ブック内の全シート名 (ブック順)。
    pub sheets: Vec<String>,
    /// 実際に読んだシート名。
    pub sheet: String,
    pub rows: Vec<XlsxRow>,
    /// `max_rows` に達して読み残した行がある。
    pub truncated: bool,
}

fn xlsx_err(e: calamine::XlsxError) -> AppError {
    AppError::Other(format!("xlsx parse error: {e}"))
}

fn open(data: &[u8]) -> Result<Xlsx<Cursor<&[u8]>>> {
    Xlsx::new(Cursor::new(data)).map_err(xlsx_err)
}

/// 日時セルをテキストにする。時刻が 0:00:00 なら日付のみ。
fn format_datetime(dt: &chrono::NaiveDateTime) -> String {
    use chrono::Timelike;
    if dt.time() == chrono::NaiveTime::MIN {
        dt.format("%Y-%m-%d").to_string()
    } else if dt.nanosecond() == 0 {
        dt.format("%Y-%m-%d %H:%M:%S").to_string()
    } else {
        dt.format("%Y-%m-%d %H:%M:%S%.3f").to_string()
    }
}

fn format_duration(d: &chrono::Duration) -> String {
    let total = d.num_seconds();
    let sign = if total < 0 { "-" } else { "" };
    let t = total.abs();
    format!("{sign}{:02}:{:02}:{:02}", t / 3600, (t / 60) % 60, t % 60)
}

/// セル 1 つ → 取り込むテキスト (`None` = NULL)。対応は冒頭の表。
pub(crate) fn cell_text(cell: &DataRef<'_>) -> Option<String> {
    match cell {
        DataRef::Empty | DataRef::Error(_) => None,
        DataRef::String(s) => Some(s.clone()),
        DataRef::SharedString(s) => Some((*s).to_string()),
        DataRef::Int(i) => Some(i.to_string()),
        // Rust の `{}` は 1.0 を "1"、0.1 を "0.1" と最短表記で出す。
        DataRef::Float(f) => Some(f.to_string()),
        DataRef::Bool(b) => Some(b.to_string()),
        DataRef::DateTime(dt) => {
            if dt.is_duration() {
                dt.as_duration().map(|d| format_duration(&d))
            } else {
                dt.as_datetime().map(|d| format_datetime(&d))
            }
        }
        DataRef::DateTimeIso(s) | DataRef::DurationIso(s) => Some(s.clone()),
    }
}

/// ブック内のシート名 (ブック順) を返す。
#[cfg(test)]
pub(crate) fn sheet_names(data: &[u8]) -> Result<Vec<String>> {
    Ok(open(data)?.sheet_names())
}

/// `sheet` (省略時は先頭シート) を読む。`max_rows` は読む行数の上限 (空行を除く)。
/// 超える行があれば読み取りを打ち切って `truncated` を立てる。
pub(crate) fn read_sheet(
    data: &[u8],
    sheet: Option<&str>,
    max_rows: Option<usize>,
) -> Result<XlsxSheet> {
    let mut wb = open(data)?;
    let sheets = wb.sheet_names();
    let name = match sheet {
        Some(s) if !s.is_empty() => {
            if !sheets.iter().any(|n| n == s) {
                return Err(AppError::InvalidInput(format!(
                    "sheet not found in workbook: {s}"
                )));
            }
            s.to_string()
        }
        _ => sheets
            .first()
            .cloned()
            .ok_or_else(|| AppError::InvalidInput("workbook has no sheets".into()))?,
    };

    let mut reader = wb.worksheet_cells_reader(&name).map_err(xlsx_err)?;
    let mut rows: Vec<XlsxRow> = Vec::new();
    let mut truncated = false;
    // 読み進め中の行 (行番号は 0 始まり)。
    let mut current: Option<(u32, Vec<Option<String>>)> = None;

    let flush = |current: &mut Option<(u32, Vec<Option<String>>)>, rows: &mut Vec<XlsxRow>| {
        if let Some((r, cells)) = current.take() {
            if cells.iter().any(Option::is_some) {
                rows.push(XlsxRow {
                    line: u64::from(r) + 1,
                    cells,
                });
            }
        }
    };

    while let Some(cell) = reader.next_cell().map_err(xlsx_err)? {
        let (row, col) = cell.get_position();
        let text = cell_text(cell.get_value());
        if current.as_ref().map(|(r, _)| *r) != Some(row) {
            flush(&mut current, &mut rows);
            if max_rows.is_some_and(|m| rows.len() >= m) {
                // 上限まで読み終えた後にまだ行が続く。空の行は数えない
                // ので、続きの行が実際に値を持つときだけ truncated にする。
                if text.is_some() {
                    truncated = true;
                    break;
                }
                continue;
            }
            current = Some((row, Vec::new()));
        }
        if let Some((_, cells)) = current.as_mut() {
            if text.is_some() {
                let col = col as usize;
                if cells.len() <= col {
                    cells.resize(col + 1, None);
                }
                cells[col] = text;
            }
        }
    }
    if !truncated {
        flush(&mut current, &mut rows);
    }

    Ok(XlsxSheet {
        sheets,
        sheet: name,
        rows,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::export_xlsx::write_xlsx;
    use crate::db::types::{Column, Value};
    use rust_xlsxwriter::{ExcelDateTime, Format, Workbook};

    fn col(name: &str, ty: &str) -> Column {
        Column {
            name: name.into(),
            type_name: ty.into(),
        }
    }

    fn export(columns: &[Column], rows: &[Vec<Value>]) -> Vec<u8> {
        let mut buf = Vec::new();
        write_xlsx(&mut buf, columns, rows).unwrap();
        buf
    }

    fn s(v: &str) -> Option<String> {
        Some(v.to_string())
    }

    /// エクスポートの出力をそのまま取り込める (往復)。NULL / 空文字列は空セルに
    /// なり、数値・真偽・文字列・大きな整数 (文字列セル) が同じテキストで戻る。
    #[test]
    fn roundtrip_of_exported_workbook() {
        let cols = vec![
            col("id", "INT"),
            col("name", "TEXT"),
            col("price", "DECIMAL(10,2)"),
            col("flag", "BOOLEAN"),
            col("big", "BIGINT"),
            col("note", "TEXT"),
        ];
        let rows = vec![
            vec![
                Value::Int(1),
                Value::String("Alice".into()),
                Value::String("12.50".into()),
                Value::Bool(true),
                Value::Int(12_345_678_901_234_567),
                Value::Null,
            ],
            vec![
                Value::Int(-2),
                Value::String("日本語 = \"x\"".into()),
                Value::Float(0.1),
                Value::Bool(false),
                Value::Int(3),
                Value::String("=HYPERLINK(\"http://x\")".into()),
            ],
        ];
        let bytes = export(&cols, &rows);
        assert_eq!(sheet_names(&bytes).unwrap().len(), 1);
        let r = read_sheet(&bytes, None, None).unwrap();
        assert!(!r.truncated);
        assert_eq!(r.rows.len(), 3);
        assert_eq!(r.rows[0].line, 1);
        assert_eq!(
            r.rows[0].cells,
            vec![
                s("id"),
                s("name"),
                s("price"),
                s("flag"),
                s("big"),
                s("note")
            ]
        );
        assert_eq!(
            r.rows[1].cells,
            vec![
                s("1"),
                s("Alice"),
                s("12.5"),
                s("true"),
                s("12345678901234567"),
                // 末尾の空セル (NULL) は行の長さに含めない。
            ]
        );
        assert_eq!(
            r.rows[2].cells,
            vec![
                s("-2"),
                s("日本語 = \"x\""),
                s("0.1"),
                s("false"),
                s("3"),
                s("=HYPERLINK(\"http://x\")")
            ]
        );
    }

    #[test]
    fn max_rows_truncates_and_skips_blank_rows() {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.write_string(0, 0, "h").unwrap();
        ws.write_string(1, 0, "a").unwrap();
        // 3 行目は完全に空 (書式だけのセルを置く)。
        ws.write_blank(2, 0, &Format::new().set_bold()).unwrap();
        ws.write_string(3, 0, "b").unwrap();
        ws.write_string(4, 0, "c").unwrap();
        let bytes = wb.save_to_buffer().unwrap();

        let all = read_sheet(&bytes, None, None).unwrap();
        let lines: Vec<u64> = all.rows.iter().map(|r| r.line).collect();
        assert_eq!(lines, vec![1, 2, 4, 5]);
        assert!(!all.truncated);

        let two = read_sheet(&bytes, None, Some(2)).unwrap();
        assert_eq!(two.rows.len(), 2);
        assert!(two.truncated);
        let exact = read_sheet(&bytes, None, Some(4)).unwrap();
        assert_eq!(exact.rows.len(), 4);
        assert!(!exact.truncated);
    }

    #[test]
    fn selects_sheet_by_name_and_rejects_unknown() {
        let mut wb = Workbook::new();
        wb.add_worksheet()
            .set_name("first")
            .unwrap()
            .write_string(0, 0, "x")
            .unwrap();
        wb.add_worksheet()
            .set_name("second")
            .unwrap()
            .write_string(0, 0, "y")
            .unwrap();
        let bytes = wb.save_to_buffer().unwrap();

        let first = read_sheet(&bytes, None, None).unwrap();
        assert_eq!(first.sheet, "first");
        assert_eq!(
            first.sheets,
            vec!["first".to_string(), "second".to_string()]
        );
        let second = read_sheet(&bytes, Some("second"), None).unwrap();
        assert_eq!(second.rows[0].cells, vec![s("y")]);
        assert!(read_sheet(&bytes, Some("nope"), None).is_err());
        // 空文字列は「指定なし」と同じ扱い。
        assert_eq!(read_sheet(&bytes, Some(""), None).unwrap().sheet, "first");
    }

    #[test]
    fn dates_formulas_and_absolute_columns() {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        let date = Format::new().set_num_format("yyyy-mm-dd");
        let dt = Format::new().set_num_format("yyyy-mm-dd hh:mm:ss");
        // B 列から始まる (A 列は空)。
        ws.write_datetime_with_format(0, 1, ExcelDateTime::from_ymd(2024, 3, 5).unwrap(), &date)
            .unwrap();
        ws.write_datetime_with_format(
            0,
            2,
            ExcelDateTime::from_ymd(2024, 3, 5)
                .unwrap()
                .and_hms(13, 4, 5)
                .unwrap(),
            &dt,
        )
        .unwrap();
        ws.write_formula_with_format(0, 3, "=1+2", &Format::new())
            .unwrap();
        ws.write_number(0, 4, 42.0).unwrap();
        let bytes = wb.save_to_buffer().unwrap();
        let r = read_sheet(&bytes, None, None).unwrap();
        assert_eq!(
            r.rows[0].cells,
            vec![
                None,
                s("2024-03-05"),
                s("2024-03-05 13:04:05"),
                s("0"),
                s("42")
            ]
        );
    }

    #[test]
    fn invalid_bytes_is_error() {
        assert!(read_sheet(b"not a zip", None, None).is_err());
    }
}
