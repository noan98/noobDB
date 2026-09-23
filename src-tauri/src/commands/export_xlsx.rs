//! Excel (xlsx) エクスポート (#711)。
//!
//! `commands/export.rs` の在グリッド経路 (`export_query_result`) とストリーミング経路
//! (`export_query_stream`) の**両方**から、この 1 つの [`XlsxSheetWriter`] を通して
//! 書き出す (同じ入力なら同じセルになる)。書き込みは `rust_xlsxwriter` の定数メモリ
//! モードで、行を書くたびに一時ファイルへ逐次フラッシュするため、100 万行級の結果でも
//! メモリに溜めない。
//!
//! ## 値の対応 (情報を丸めで失わないことを最優先にする)
//!
//! | `Value` | セル |
//! |---|---|
//! | `Null` | 空セル |
//! | `Bool` | 真偽セル (`TRUE` / `FALSE`) |
//! | `Int` / `UInt` | 絶対値が 15 桁以下 (`<= 999_999_999_999_999`) なら数値セル、それ以上は**十進の文字列セル** |
//! | `Float` | 有限なら数値セル (IEEE754 倍精度のまま格納され Excel も倍精度で保持する)。`NaN` / `±inf` は文字列セル |
//! | `String` | 文字列セル。ただし**列の型が数値型** (DECIMAL / NUMERIC / BIGINT …) で、値が素の十進リテラルかつ有効桁が 15 桁以下のときだけ数値セル |
//! | `Bytes` | CSV と同じ `0x...` の 16 進文字列セル |
//!
//! - **15 桁の根拠**: Excel は数値を倍精度で持つが、表示・再入力の精度は有効数字
//!   15 桁で、それを超える桁は `0` に落ちる (例: `12345678901234567` は
//!   `12345678901234500` と表示され、セルを編集して確定するとその値で上書きされる)。
//!   ID・口座番号・JAN コードのような桁の多い整数がこれで静かに化けるのを防ぐため、
//!   15 桁を超える整数・十進数は**数値にせず文字列セルで出す**。
//! - **日時は文字列のまま**: ドライバが返す日時文字列をそのまま文字列セルにし、
//!   タイムゾーン・書式の暗黙変換をしない (日時セル化は需要を見て拡張)。
//! - **数式にならない**: 文字列はすべて `write_string` (共有/インライン文字列) で書くため、
//!   `=HYPERLINK(...)` のような値でも数式として評価されない。CSV の
//!   `mitigate_formula_injection` のような値の書き換えは不要なので行わない。
//! - 空文字列は Excel の仕様上 NULL と同じ空セルになる (xlsx に「空文字列のセル」を
//!   区別して置く一般的な手段が無い)。
//!
//! ## Excel の上限
//!
//! - **行数**: 1 シート 1,048,576 行 (ヘッダ 1 行 + データ 1,048,575 行)。超えた行は
//!   エラーにせず**書き出さずに数え**、[`ExportTruncation`] で「何行書いて何行
//!   落としたか」を返す (UI が警告として表示する)。
//! - **セル文字数**: 32,767 文字。超える文字列は上限で切り詰め、切り詰めたセル数を
//!   [`ExportTruncation::truncated_cells`] で返す。
//! - **列数**: 16,384 列。超える結果は書き出し自体をエラーにする (列を黙って落とすと
//!   どの列が欠けたか分からなくなるため)。

use std::borrow::Cow;
use std::io::Write;

use rust_xlsxwriter::{Format, Workbook, XlsxError};
use serde::Serialize;

use crate::db::types::{Column, Value};
use crate::error::{AppError, Result};

/// xlsx 1 シートの最大行数 (ヘッダ行を含む)。
pub(crate) const XLSX_MAX_SHEET_ROWS: u64 = 1_048_576;
/// xlsx 1 シートの最大列数。
pub(crate) const XLSX_MAX_COLUMNS: usize = 16_384;
/// xlsx 1 セルの最大文字数。Excel は UTF-16 のコード単位で数えるため、こちらも
/// UTF-16 単位で判定する (`rust_xlsxwriter` の Unicode スカラ値での判定より厳しい
/// 側に倒れるので、両方の上限を同時に満たす)。
pub(crate) const XLSX_MAX_CELL_CHARS: usize = 32_767;
/// Excel が数値を正確に表示・再入力できる有効数字の桁数。
pub(crate) const XLSX_MAX_EXACT_DIGITS: usize = 15;
/// 15 桁に収まる整数の最大絶対値 (`10^15 - 1`)。
const XLSX_MAX_EXACT_INT: u64 = 999_999_999_999_999;

/// Excel の上限に当たって**出力が元データから欠けた**ことの報告。どちらも 0 の
/// ときは `None` で表す ([`XlsxSheetWriter::finish_report`])。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ExportTruncation {
    /// 実際にシートへ書いたデータ行数 (ヘッダを除く)。
    #[serde(rename = "writtenRows")]
    pub written_rows: u64,
    /// 行数上限 (ヘッダ込み [`XLSX_MAX_SHEET_ROWS`] = データ 1,048,575 行) を超えたため書き出さなかった行数。
    #[serde(rename = "droppedRows")]
    pub dropped_rows: u64,
    /// 文字数上限 ([`XLSX_MAX_CELL_CHARS`]) で切り詰めたセル数。
    #[serde(rename = "truncatedCells")]
    pub truncated_cells: u64,
}

/// 1 つの値をどのセル種別で書くか。[`xlsx_cell`] が決め、書き込み側は従うだけ
/// (判定を純関数に閉じてテスト可能にする)。
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum XlsxCell<'a> {
    Blank,
    Bool(bool),
    Number(f64),
    Text(Cow<'a, str>),
}

/// 値 + 列 → セル種別。値の対応はモジュール冒頭の表を参照。
pub(crate) fn xlsx_cell<'a>(value: &'a Value, column: Option<&Column>) -> XlsxCell<'a> {
    match value {
        Value::Null => XlsxCell::Blank,
        Value::Bool(b) => XlsxCell::Bool(*b),
        Value::Int(i) => {
            if i.unsigned_abs() <= XLSX_MAX_EXACT_INT {
                XlsxCell::Number(*i as f64)
            } else {
                XlsxCell::Text(Cow::Owned(i.to_string()))
            }
        }
        Value::UInt(u) => {
            if *u <= XLSX_MAX_EXACT_INT {
                XlsxCell::Number(*u as f64)
            } else {
                XlsxCell::Text(Cow::Owned(u.to_string()))
            }
        }
        Value::Float(f) => {
            if f.is_finite() {
                XlsxCell::Number(*f)
            } else {
                // CSV と同じ表記 (`NaN` / `inf` / `-inf`) の文字列にする。数値セルに
                // 入れると Excel では #NUM! になり元の値が分からなくなる。
                XlsxCell::Text(Cow::Owned(f.to_string()))
            }
        }
        // 空文字列は xlsx に置けない (書いても空セルになる) ので、明示的に空セルとする。
        Value::String(s) if s.is_empty() => XlsxCell::Blank,
        Value::String(s) => {
            if column.is_some_and(|c| is_numeric_type(&c.type_name)) {
                if let Some(n) = exact_decimal_to_f64(s) {
                    return XlsxCell::Number(n);
                }
            }
            XlsxCell::Text(Cow::Borrowed(s.as_str()))
        }
        Value::Bytes(hex) => XlsxCell::Text(Cow::Owned(format!("0x{hex}"))),
    }
}

/// 列の型名が「数値を文字列で運ぶことがある」数値型か。DECIMAL / NUMERIC は各
/// ドライバが桁あふれ防止に文字列で返し、2^53 を超える整数も `from_*_lossless` で
/// 文字列になる。型名は方言ごとに `DECIMAL(10,2)` / `numeric` / `BIGINT UNSIGNED` /
/// `int8` のように揺れるので、括弧以降と符号指定を落とした基底名で判定する。
/// `contains("int")` のような部分一致は `INTERVAL` / `POINT` を誤検出するので使わない。
pub(crate) fn is_numeric_type(type_name: &str) -> bool {
    let lower = type_name.trim().to_ascii_lowercase();
    let base = lower.split('(').next().unwrap_or("").trim();
    let base = base
        .strip_suffix(" unsigned")
        .or_else(|| base.strip_suffix(" signed"))
        .unwrap_or(base)
        .trim();
    matches!(
        base,
        "decimal"
            | "dec"
            | "numeric"
            | "number"
            | "money"
            | "smallmoney"
            | "int"
            | "integer"
            | "bigint"
            | "smallint"
            | "tinyint"
            | "mediumint"
            | "int1"
            | "int2"
            | "int4"
            | "int8"
            | "hugeint"
            | "uhugeint"
            | "ubigint"
            | "uinteger"
            | "usmallint"
            | "utinyint"
    )
}

/// 素の十進リテラル (`-123.4500` など。指数表記・空白・`NaN` は対象外) で、有効数字が
/// [`XLSX_MAX_EXACT_DIGITS`] 桁以下のときだけ `f64` を返す。それ以外は `None`
/// (= 文字列セルのまま)。
///
/// 有効数字は「先頭の 0 と末尾の 0 を除いた数字列の長さ」で数える。末尾の 0 は
/// `1000` (整数部) でも `1.2300` (小数部) でも倍精度・Excel の表示で値を変えない
/// ため桁数に数えない。15 桁以下の十進数は倍精度への変換で最近接値になり、Excel が
/// 15 桁で表示・再入力しても元の十進表記と一致する。
pub(crate) fn exact_decimal_to_f64(s: &str) -> Option<f64> {
    let unsigned = s.strip_prefix(['-', '+']).unwrap_or(s);
    let (int_part, frac_part) = match unsigned.split_once('.') {
        Some((i, f)) => (i, f),
        None => (unsigned, ""),
    };
    if int_part.is_empty() && frac_part.is_empty() {
        return None;
    }
    if !int_part.bytes().all(|b| b.is_ascii_digit())
        || !frac_part.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let digits: String = int_part.chars().chain(frac_part.chars()).collect();
    let significant = digits.trim_start_matches('0').trim_end_matches('0');
    if significant.len() > XLSX_MAX_EXACT_DIGITS {
        return None;
    }
    let n: f64 = s.parse().ok()?;
    n.is_finite().then_some(n)
}

/// 文字列を [`XLSX_MAX_CELL_CHARS`] (UTF-16 単位) に収める。切り詰めたら `true`。
/// サロゲートペアの途中では切らない (文字境界で止める)。
pub(crate) fn clamp_cell_text(s: &str) -> (Cow<'_, str>, bool) {
    // UTF-16 長は UTF-8 のバイト長以下なので、バイト長が上限以下なら確実に収まる
    // (大多数のセルはここで借用のまま返る)。
    if s.len() <= XLSX_MAX_CELL_CHARS {
        return (Cow::Borrowed(s), false);
    }
    let mut units = 0usize;
    for (idx, ch) in s.char_indices() {
        let w = ch.len_utf16();
        if units + w > XLSX_MAX_CELL_CHARS {
            return (Cow::Owned(s[..idx].to_string()), true);
        }
        units += w;
    }
    (Cow::Borrowed(s), false)
}

fn xlsx_err(e: XlsxError) -> AppError {
    AppError::Other(format!("xlsx export failed: {e}"))
}

/// xlsx 1 シートへの逐次ライタ。`write_header` → `write_rows` (何度でも) →
/// `finish_*` の順に呼ぶ。行は常に昇順に書く (定数メモリモードの前提)。
pub(crate) struct XlsxSheetWriter {
    workbook: Workbook,
    header_format: Format,
    column_count: usize,
    /// 次に書くシート上の行番号 (0 始まり。0 はヘッダ)。
    next_row: u32,
    report: ExportTruncation,
}

impl XlsxSheetWriter {
    /// 定数メモリモードのシートを 1 枚持つブックを作る。
    ///
    /// `rust_xlsxwriter` の定数メモリモードはシート作成時に OS の一時ディレクトリへ
    /// 一時ファイルを作り、失敗すると**ライブラリ内部で panic する**。そのため先に
    /// `set_tempdir` (書き込み可能かを実際にファイルを作って検査し、失敗を `Err` で
    /// 返す) で同じディレクトリを検証してから作成する。
    pub(crate) fn new() -> Result<Self> {
        let mut workbook = Workbook::new();
        workbook
            .set_tempdir(std::env::temp_dir())
            .map_err(xlsx_err)?;
        workbook.add_worksheet_with_constant_memory();
        Ok(Self {
            workbook,
            header_format: Format::new().set_bold(),
            column_count: 0,
            next_row: 0,
            report: ExportTruncation::default(),
        })
    }

    /// ヘッダ行 (列名 + 太字) を書く。列数が Excel の上限を超えるならエラー。
    pub(crate) fn write_header(&mut self, columns: &[Column]) -> Result<()> {
        if columns.len() > XLSX_MAX_COLUMNS {
            return Err(AppError::InvalidInput(format!(
                "xlsx supports at most {XLSX_MAX_COLUMNS} columns, but the result has {}",
                columns.len()
            )));
        }
        self.column_count = columns.len();
        let row = self.next_row;
        let sheet = self.workbook.worksheet_from_index(0).map_err(xlsx_err)?;
        for (i, col) in columns.iter().enumerate() {
            let (text, truncated) = clamp_cell_text(&col.name);
            if truncated {
                self.report.truncated_cells += 1;
            }
            // 列数は上で XLSX_MAX_COLUMNS (= u16 に収まる) 以下と確認済み。
            let c =
                u16::try_from(i).map_err(|_| AppError::Other("column index overflow".into()))?;
            sheet
                .write_string_with_format(row, c, text.as_ref(), &self.header_format)
                .map_err(xlsx_err)?;
        }
        self.next_row += 1;
        Ok(())
    }

    /// データ行を書く。行数上限を超えた分は書かずに `dropped_rows` へ数える。
    pub(crate) fn write_rows(&mut self, columns: &[Column], rows: &[Vec<Value>]) -> Result<()> {
        let sheet = self.workbook.worksheet_from_index(0).map_err(xlsx_err)?;
        for row in rows {
            if u64::from(self.next_row) >= XLSX_MAX_SHEET_ROWS {
                self.report.dropped_rows += 1;
                continue;
            }
            let r = self.next_row;
            for i in 0..self.column_count {
                let value = row.get(i).unwrap_or(&Value::Null);
                let c = u16::try_from(i)
                    .map_err(|_| AppError::Other("column index overflow".into()))?;
                match xlsx_cell(value, columns.get(i)) {
                    XlsxCell::Blank => {}
                    XlsxCell::Bool(b) => {
                        sheet.write_boolean(r, c, b).map_err(xlsx_err)?;
                    }
                    XlsxCell::Number(n) => {
                        sheet.write_number(r, c, n).map_err(xlsx_err)?;
                    }
                    XlsxCell::Text(s) => {
                        let (text, truncated) = clamp_cell_text(&s);
                        if truncated {
                            self.report.truncated_cells += 1;
                        }
                        sheet.write_string(r, c, text.as_ref()).map_err(xlsx_err)?;
                    }
                }
            }
            self.next_row += 1;
            self.report.written_rows += 1;
        }
        Ok(())
    }

    /// 上限に当たって欠けた出力があればその報告を返す (無ければ `None`)。
    pub(crate) fn finish_report(&self) -> Option<ExportTruncation> {
        (self.report.dropped_rows > 0 || self.report.truncated_cells > 0)
            .then(|| self.report.clone())
    }

    /// ブックを `w` へ書き出す。xlsx は ZIP なので全体を閉じるまで有効なファイルに
    /// ならない — 途中で失敗した出力の後始末は呼び出し側 (`PartialFileCleanup`) が持つ。
    pub(crate) fn save_to<W: Write + Send>(&mut self, w: W) -> Result<Option<ExportTruncation>> {
        // ヘッダが一度も書かれていない (列イベントが来なかった) 場合も、空シートの
        // 有効な xlsx を出す。
        self.workbook.save_to_writer(w).map_err(xlsx_err)?;
        Ok(self.finish_report())
    }
}

/// 在グリッド経路 (`write_export_to`) 用: 全行を書いて `w` へ保存する。
pub(crate) fn write_xlsx<W: Write + Send>(
    w: W,
    columns: &[Column],
    rows: &[Vec<Value>],
) -> Result<Option<ExportTruncation>> {
    let mut sheet = XlsxSheetWriter::new()?;
    sheet.write_header(columns)?;
    sheet.write_rows(columns, rows)?;
    sheet.save_to(w)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, type_name: &str) -> Column {
        Column {
            name: name.into(),
            type_name: type_name.into(),
        }
    }

    fn text(s: &str) -> XlsxCell<'static> {
        XlsxCell::Text(Cow::Owned(s.to_string()))
    }

    #[test]
    fn null_bool_and_bytes() {
        let c = col("c", "TEXT");
        assert_eq!(xlsx_cell(&Value::Null, Some(&c)), XlsxCell::Blank);
        assert_eq!(
            xlsx_cell(&Value::Bool(true), Some(&c)),
            XlsxCell::Bool(true)
        );
        assert_eq!(
            xlsx_cell(&Value::Bytes("00ff".into()), Some(&c)),
            text("0x00ff")
        );
    }

    #[test]
    fn integers_up_to_15_digits_are_numbers() {
        assert_eq!(xlsx_cell(&Value::Int(0), None), XlsxCell::Number(0.0));
        assert_eq!(
            xlsx_cell(&Value::Int(999_999_999_999_999), None),
            XlsxCell::Number(999_999_999_999_999.0)
        );
        assert_eq!(
            xlsx_cell(&Value::Int(-999_999_999_999_999), None),
            XlsxCell::Number(-999_999_999_999_999.0)
        );
        assert_eq!(
            xlsx_cell(&Value::UInt(999_999_999_999_999), None),
            XlsxCell::Number(999_999_999_999_999.0)
        );
    }

    #[test]
    fn integers_over_15_digits_become_text() {
        // 16 桁: 倍精度では正確だが Excel は 15 桁で丸めて表示・再入力する。
        assert_eq!(
            xlsx_cell(&Value::Int(1_000_000_000_000_000), None),
            text("1000000000000000")
        );
        assert_eq!(
            xlsx_cell(&Value::Int(-1_000_000_000_000_000), None),
            text("-1000000000000000")
        );
        // JS の安全整数の上限 (2^53 - 1)。Int のまま届く最大値。
        assert_eq!(
            xlsx_cell(&Value::Int(9_007_199_254_740_991), None),
            text("9007199254740991")
        );
        assert_eq!(
            xlsx_cell(&Value::Int(i64::MIN), None),
            text("-9223372036854775808")
        );
        assert_eq!(
            xlsx_cell(&Value::UInt(u64::MAX), None),
            text("18446744073709551615")
        );
    }

    #[test]
    fn lossless_big_ints_stay_text_even_in_numeric_columns() {
        // `from_i64_lossless` で文字列になった 2^53 超の整数は、BIGINT 列でも
        // 15 桁を超えるので数値化しない。
        let c = col("id", "BIGINT UNSIGNED");
        let v = Value::from_u64_lossless(18_446_744_073_709_551_615);
        assert_eq!(xlsx_cell(&v, Some(&c)), text("18446744073709551615"));
    }

    #[test]
    fn floats_are_numbers_but_non_finite_are_text() {
        assert_eq!(xlsx_cell(&Value::Float(1.5), None), XlsxCell::Number(1.5));
        let tricky = 0.1 + 0.2;
        assert_eq!(
            xlsx_cell(&Value::Float(tricky), None),
            XlsxCell::Number(tricky)
        );
        assert_eq!(xlsx_cell(&Value::Float(f64::NAN), None), text("NaN"));
        assert_eq!(xlsx_cell(&Value::Float(f64::INFINITY), None), text("inf"));
        assert_eq!(
            xlsx_cell(&Value::Float(f64::NEG_INFINITY), None),
            text("-inf")
        );
    }

    #[test]
    fn strings_stay_text_outside_numeric_columns() {
        // 先頭ゼロ (郵便番号・社員番号)、日時、数式風の値はすべて文字列のまま。
        let c = col("zip", "VARCHAR(10)");
        assert_eq!(
            xlsx_cell(&Value::String("00123".into()), Some(&c)),
            text("00123")
        );
        let d = col("at", "DATETIME");
        assert_eq!(
            xlsx_cell(&Value::String("2024-01-02 03:04:05".into()), Some(&d)),
            text("2024-01-02 03:04:05")
        );
        assert_eq!(
            xlsx_cell(&Value::String("=1+1".into()), Some(&c)),
            text("=1+1")
        );
        // 空文字列は空セル (Excel では NULL と区別できない)。
        assert_eq!(
            xlsx_cell(&Value::String(String::new()), Some(&c)),
            XlsxCell::Blank
        );
        // 列情報が無いときも文字列。
        assert_eq!(xlsx_cell(&Value::String("12".into()), None), text("12"));
    }

    #[test]
    fn decimal_strings_in_numeric_columns() {
        let c = col("amount", "DECIMAL(20,4)");
        assert_eq!(
            xlsx_cell(&Value::String("123.4500".into()), Some(&c)),
            XlsxCell::Number(123.45)
        );
        assert_eq!(
            xlsx_cell(&Value::String("-0.001".into()), Some(&c)),
            XlsxCell::Number(-0.001)
        );
        // 有効数字 15 桁ちょうどは数値、16 桁は文字列。
        assert_eq!(
            xlsx_cell(&Value::String("1234567890.12345".into()), Some(&c)),
            XlsxCell::Number(1_234_567_890.123_45)
        );
        assert_eq!(
            xlsx_cell(&Value::String("1234567890.123456".into()), Some(&c)),
            text("1234567890.123456")
        );
        // 非数 (PostgreSQL numeric の NaN)・指数表記は文字列のまま。
        assert_eq!(
            xlsx_cell(&Value::String("NaN".into()), Some(&c)),
            text("NaN")
        );
        assert_eq!(
            xlsx_cell(&Value::String("1e5".into()), Some(&c)),
            text("1e5")
        );
    }

    #[test]
    fn exact_decimal_digit_counting() {
        assert_eq!(exact_decimal_to_f64("0"), Some(0.0));
        assert_eq!(exact_decimal_to_f64("-0.50"), Some(-0.5));
        assert_eq!(exact_decimal_to_f64(".5"), Some(0.5));
        assert_eq!(exact_decimal_to_f64("5."), Some(5.0));
        // 末尾の 0 は有効数字に数えない (値を変えない)。
        assert_eq!(exact_decimal_to_f64("100000000000000000000"), Some(1e20));
        assert_eq!(exact_decimal_to_f64("0.000000000000000000001"), Some(1e-21));
        assert_eq!(
            exact_decimal_to_f64("123456789012345"),
            Some(123_456_789_012_345.0)
        );
        assert_eq!(exact_decimal_to_f64("1234567890123456"), None);
        assert_eq!(exact_decimal_to_f64("-"), None);
        assert_eq!(exact_decimal_to_f64("."), None);
        assert_eq!(exact_decimal_to_f64(""), None);
        assert_eq!(exact_decimal_to_f64("1,000"), None);
        assert_eq!(exact_decimal_to_f64(" 1"), None);
        assert_eq!(exact_decimal_to_f64("1.2.3"), None);
    }

    #[test]
    fn numeric_type_detection() {
        for t in [
            "DECIMAL(10,2)",
            "numeric",
            "NUMBER(38)",
            "money",
            "BIGINT",
            "bigint unsigned",
            "INT8",
            "int",
            "HUGEINT",
            "UBIGINT",
        ] {
            assert!(is_numeric_type(t), "{t} should be numeric");
        }
        for t in [
            "INTERVAL",
            "POINT",
            "VARCHAR(10)",
            "TEXT",
            "DATETIME",
            "",
            "float",
        ] {
            assert!(!is_numeric_type(t), "{t} should not be numeric");
        }
    }

    #[test]
    fn clamp_keeps_short_text_and_cuts_long_text_on_char_boundary() {
        let (s, t) = clamp_cell_text("日本語");
        assert_eq!((s.as_ref(), t), ("日本語", false));

        let exact = "a".repeat(XLSX_MAX_CELL_CHARS);
        let (s, t) = clamp_cell_text(&exact);
        assert_eq!((s.len(), t), (XLSX_MAX_CELL_CHARS, false));

        let over = "a".repeat(XLSX_MAX_CELL_CHARS + 1);
        let (s, t) = clamp_cell_text(&over);
        assert_eq!((s.len(), t), (XLSX_MAX_CELL_CHARS, true));

        // 非 BMP 文字は UTF-16 で 2 単位。上限をまたぐ絵文字は丸ごと落とす。
        let emoji = format!("{}😀", "a".repeat(XLSX_MAX_CELL_CHARS - 1));
        let (s, t) = clamp_cell_text(&emoji);
        assert!(t);
        assert_eq!(s.encode_utf16().count(), XLSX_MAX_CELL_CHARS - 1);

        // マルチバイトでもバイト長では判定しない (32,767 文字の日本語は収まる)。
        let jp = "あ".repeat(XLSX_MAX_CELL_CHARS);
        let (s, t) = clamp_cell_text(&jp);
        assert_eq!((s.chars().count(), t), (XLSX_MAX_CELL_CHARS, false));
    }

    #[test]
    fn row_limit_drops_and_counts_excess_rows() {
        let cols = vec![col("n", "INT")];
        let mut w = XlsxSheetWriter::new().expect("writer");
        w.write_header(&cols).expect("header");
        // 上限直前までを 1 回で書くと重いので、行カウンタを上限手前へ進めて境界だけ検証する。
        w.next_row = u32::try_from(XLSX_MAX_SHEET_ROWS - 2).expect("fits");
        let rows: Vec<Vec<Value>> = (0..5).map(|i| vec![Value::Int(i)]).collect();
        w.write_rows(&cols, &rows).expect("rows");
        let report = w.finish_report().expect("truncated");
        // 残り 2 行 (最終行番号 1,048,574 と 1,048,575) だけ書き、3 行を落とす。
        assert_eq!(report.written_rows, 2);
        assert_eq!(report.dropped_rows, 3);
        assert_eq!(report.truncated_cells, 0);
        // 以降のバッチもすべて落とす。
        w.write_rows(&cols, &rows).expect("rows");
        let report = w.finish_report().expect("truncated");
        assert_eq!(report.dropped_rows, 8);
        let mut buf = std::io::Cursor::new(Vec::new());
        w.save_to(&mut buf).expect("save");
        assert!(buf.get_ref().starts_with(b"PK"));
    }

    #[test]
    fn no_report_when_nothing_was_lost() {
        let cols = vec![col("n", "INT")];
        let mut buf = std::io::Cursor::new(Vec::new());
        let report = write_xlsx(&mut buf, &cols, &[vec![Value::Int(1)]]).expect("xlsx");
        assert_eq!(report, None);
    }

    #[test]
    fn long_cells_are_truncated_and_reported() {
        let cols = vec![col("t", "TEXT")];
        let long = Value::String("x".repeat(XLSX_MAX_CELL_CHARS + 10));
        let mut buf = std::io::Cursor::new(Vec::new());
        let report = write_xlsx(&mut buf, &cols, &[vec![long.clone()], vec![long]])
            .expect("xlsx")
            .expect("truncated");
        assert_eq!(report.written_rows, 2);
        assert_eq!(report.dropped_rows, 0);
        assert_eq!(report.truncated_cells, 2);
    }

    #[test]
    fn too_many_columns_is_an_error() {
        let cols: Vec<Column> = (0..=XLSX_MAX_COLUMNS)
            .map(|i| col(&format!("c{i}"), "INT"))
            .collect();
        let mut w = XlsxSheetWriter::new().expect("writer");
        assert!(matches!(
            w.write_header(&cols),
            Err(AppError::InvalidInput(_))
        ));
    }
}
