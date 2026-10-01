//! JS (ブラウザ) の文字列化・数値化・文字列比較を Rust で再現する小さな道具箱 (#1264)。
//!
//! 結果ハンドル経由のソート・フィルタ・検索 (`result_ops`) は、フロントの
//! `ResultGrid.tsx` / `gridFind.ts` (= JS の `String(v)` / `Number(v)` /
//! `Intl.Collator`) と**同じ結果**を返さなければならない。この層は値の型変換だけを担い、
//! 判定ロジックは `result_ops` に置く。
//!
//! - [`value_str`]: `String(v)` (NULL と非有限の浮動小数は `None` = JS の `null`)
//! - [`js_to_number`]: `Number(str)` (`NaN` を含む。空文字列は 0)
//! - [`collation_key`]: `new Intl.Collator(undefined, { numeric: true })` の近似キー
//!
//! **照合順序は完全一致ではない。** ICU の照合 (ロケール依存・Unicode 全域) を再現する
//! 代わりに、ASCII (句読点 < 数字 < 英字、大小は無視して同順位 → 同値なら小文字が先)、
//! 数字列の数値比較、Latin-1 / Latin Extended-A のアクセント付き英字、ひらがな・
//! カタカナの同順位扱いまでを ICU root 照合に揃え、それ以外の文字はコードポイント順に
//! 倒す。詳細な差分は `collation_key` のドキュメントを参照。

use std::borrow::Cow;

use super::stream_batch::is_js_whitespace;
use super::types::Value;

/// JS の `Number.prototype.toString` (基数 10) と同じ表記にする。
///
/// Rust の `{}` は指数表記を使わず、JS は絶対値が 1e21 以上 / 1e-6 未満で指数表記に
/// なるため、最短往復桁 (`{:e}`) を取り出して ECMAScript の規則で組み直す。
pub fn js_number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".to_string();
    }
    if x == 0.0 {
        // -0 も "0" (JS の String(-0) === "0")。
        return "0".to_string();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    let sign = if x < 0.0 { "-" } else { "" };
    let sci = format!("{:e}", x.abs());
    let (mantissa, exp) = match sci.split_once('e') {
        Some((m, e)) => (m, e.parse::<i32>().unwrap_or(0)),
        None => (sci.as_str(), 0),
    };
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    // 値 = 0.d1d2... × 10^n (ECMAScript の n)。
    let n = exp + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        let (int, frac) = digits.split_at(n as usize);
        format!("{int}.{frac}")
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let es = if e < 0 {
            format!("-{}", -e)
        } else {
            format!("+{e}")
        };
        if k == 1 {
            format!("{digits}e{es}")
        } else {
            let (first, rest) = digits.split_at(1);
            format!("{first}.{rest}e{es}")
        }
    };
    format!("{sign}{body}")
}

/// JS の `String(v)` 相当。NULL と非有限の浮動小数 (JSON で `null` になる) は `None`。
pub fn value_str(v: &Value) -> Option<Cow<'_, str>> {
    match v {
        Value::Null => None,
        Value::Bool(b) => Some(Cow::Borrowed(if *b { "true" } else { "false" })),
        Value::Int(i) => Some(Cow::Owned(i.to_string())),
        Value::UInt(u) => Some(Cow::Owned(u.to_string())),
        Value::Float(f) => {
            if f.is_finite() {
                Some(Cow::Owned(js_number_to_string(*f)))
            } else {
                None
            }
        }
        Value::String(s) | Value::Bytes(s) => Some(Cow::Borrowed(s.as_str())),
    }
}

/// JS の `Number(str)` 相当 (`NaN` を返しうる)。前後の空白は JS の WhiteSpace /
/// LineTerminator 集合で除去し、空文字列は 0、16/8/2 進接頭辞・`Infinity` を受理する。
pub fn js_to_number(s: &str) -> f64 {
    let t = s.trim_matches(is_js_whitespace);
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let bytes = t.as_bytes();
    if bytes.len() > 2 && bytes[0] == b'0' {
        let radix = match bytes[1] {
            b'x' | b'X' => Some(16),
            b'o' | b'O' => Some(8),
            b'b' | b'B' => Some(2),
            _ => None,
        };
        if let Some(radix) = radix {
            let mut acc: f64 = 0.0;
            for c in t[2..].chars() {
                match c.to_digit(radix) {
                    Some(d) => acc = acc * f64::from(radix) + f64::from(d),
                    None => return f64::NAN,
                }
            }
            return acc;
        }
    }
    // 10 進リテラル。Rust の f64 パーサは `inf` / `nan` / `infinity` も受理するので、
    // 符号を除いた先頭が数字か `.` のときだけ通す。
    let rest = t.strip_prefix(['+', '-']).unwrap_or(t);
    match rest.chars().next() {
        Some(c) if c.is_ascii_digit() || c == '.' => t.parse::<f64>().unwrap_or(f64::NAN),
        _ => f64::NAN,
    }
}

/// JS の `Number(v)` 相当 (セル値から)。NULL と非有限の浮動小数は `None`。
pub fn value_number(v: &Value) -> Option<f64> {
    match v {
        Value::Null => None,
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::Int(i) => Some(*i as f64),
        Value::UInt(u) => Some(*u as f64),
        Value::Float(f) => f.is_finite().then_some(*f),
        Value::String(s) | Value::Bytes(s) => Some(js_to_number(s)),
    }
}

/// JS の `String.prototype.trim()` と同じ空白除去。
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

/// `haystack.toLowerCase().includes(needle_lower)`。`needle_lower` は小文字化済み。
/// 両方 ASCII のときは確保なしで比較する。
pub fn contains_ci(haystack: &str, needle_lower: &str) -> bool {
    if needle_lower.is_empty() {
        return true;
    }
    if haystack.is_ascii() && needle_lower.is_ascii() {
        let h = haystack.as_bytes();
        let n = needle_lower.as_bytes();
        if n.len() > h.len() {
            return false;
        }
        return h
            .windows(n.len())
            .any(|w| w.iter().zip(n).all(|(a, b)| a.to_ascii_lowercase() == *b));
    }
    haystack.to_lowercase().contains(needle_lower)
}

// ─────────────────────────────────────────────────────────────────────────────
// 照合キー (Intl.Collator numeric の近似)
// ─────────────────────────────────────────────────────────────────────────────

/// ICU root 照合での ASCII 記号の並び (空白が最小、その後に数字・英字が続く)。
const PUNCT_ORDER: &[u8] = b"\t\n\x0b\x0c\r _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";

/// 区切りと開始バイト。トークンの種別バイトは 1 以上にして、0 を終端に使う。
const T_PUNCT: u8 = 0x01;
const T_NUM: u8 = 0x02;
const T_LETTER: u8 = 0x03;
const T_OTHER: u8 = 0x04;

/// Latin-1 Supplement (U+00C0..=U+00FF) の基底文字。`_` は英字ではない記号。
/// `ae` / `ss` / `th` は展開 (ICU でも Æ → ae, ß → ss)。
const LATIN1_BASE: [&str; 64] = [
    "a", "a", "a", "a", "a", "a", "ae", "c", "e", "e", "e", "e", "i", "i", "i", "i", // C0..CF
    "d", "n", "o", "o", "o", "o", "o", "_", "o", "u", "u", "u", "u", "y", "th",
    "ss", // D0..DF
    "a", "a", "a", "a", "a", "a", "ae", "c", "e", "e", "e", "e", "i", "i", "i", "i", // E0..EF
    "d", "n", "o", "o", "o", "o", "o", "_", "o", "u", "u", "u", "u", "y", "th", "y", // F0..FF
];

/// Latin Extended-A (U+0100..=U+017F) の基底文字。
const LATIN_EXT_A_BASE: [&str; 128] = [
    "a", "a", "a", "a", "a", "a", "c", "c", "c", "c", "c", "c", "c", "c", "d", "d", // 100
    "d", "d", "e", "e", "e", "e", "e", "e", "e", "e", "e", "e", "g", "g", "g", "g", // 110
    "g", "g", "g", "g", "h", "h", "h", "h", "i", "i", "i", "i", "i", "i", "i", "i", // 120
    "i", "i", "ij", "ij", "j", "j", "k", "k", "k", "l", "l", "l", "l", "l", "l", "l", // 130
    "l", "l", "l", "n", "n", "n", "n", "n", "n", "n", "n", "n", "o", "o", "o", "o", // 140
    "o", "o", "oe", "oe", "r", "r", "r", "r", "r", "r", "s", "s", "s", "s", "s", "s", // 150
    "s", "s", "t", "t", "t", "t", "t", "t", "u", "u", "u", "u", "u", "u", "u", "u", // 160
    "u", "u", "u", "u", "w", "w", "y", "y", "y", "z", "z", "z", "z", "z", "z", "s", // 170
];

fn push_letter(out: &mut (Vec<u8>, Vec<u8>, Vec<u8>), base: u8, accent: u8, upper: bool) {
    out.0.push(T_LETTER);
    out.0.push(base - b'a');
    out.1.push(accent);
    out.2.push(if upper { 2 } else { 1 });
}

/// `Intl.Collator(undefined, { numeric: true })` に近い照合キーを作る。バイト列の
/// 辞書順比較が照合順序になる。
///
/// 再現する範囲:
/// - 一次: 制御文字は無視。空白・ASCII 記号 < 数字列 < 英字 (大小同順位) < その他。
///   数字列は先頭のゼロを無視した数値順 (`"a2" < "a10"`、`"01"` と `"1"` は同値)。
/// - 二次: Latin-1 / Latin Extended-A のアクセント付き英字は基底文字と同順位で、
///   アクセント無し < 有り。`ß` は `ss`、`æ` は `ae`、`œ` は `oe` に展開する。
/// - 三次: 小文字 < 大文字、ひらがな < カタカナ。
///
/// **再現しない範囲 (ICU との既知の差)**: 上記以外の非 ASCII 文字 (キリル・ギリシャ・
/// 漢字・合成済みでない結合文字など) はコードポイント順。ロケール固有の照合
/// (スウェーデン語の `ä` が `z` の後 等)、全角/半角の同一視、`ignorePunctuation` 系、
/// 数字以外の Unicode 10 進数字の数値化は扱わない。
pub fn collation_key(s: &str) -> Box<[u8]> {
    let mut out = (Vec::with_capacity(s.len() * 2 + 2), Vec::new(), Vec::new());
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let cp = c as u32;
        if c.is_ascii_digit() {
            let start = i;
            while i < chars.len() && chars[i].is_ascii_digit() {
                i += 1;
            }
            let run: String = chars[start..i].iter().collect();
            let trimmed = run.trim_start_matches('0');
            let digits = if trimmed.is_empty() { "0" } else { trimmed };
            let len = digits.len().min(0xFFFF) as u16;
            out.0.push(T_NUM);
            out.0.extend_from_slice(&len.to_be_bytes());
            out.0.extend_from_slice(digits.as_bytes());
            out.1.push(1);
            out.2.push(1);
            continue;
        }
        i += 1;
        if c.is_ascii() {
            if c.is_ascii_alphabetic() {
                push_letter(
                    &mut out,
                    c.to_ascii_lowercase() as u8,
                    1,
                    c.is_ascii_uppercase(),
                );
            } else if let Some(rank) = PUNCT_ORDER.iter().position(|b| *b == c as u8) {
                out.0.push(T_PUNCT);
                out.0.push(rank as u8 + 1);
                out.1.push(1);
                out.2.push(1);
            }
            // それ以外の ASCII 制御文字は完全に無視する。
            continue;
        }
        // アクセントの二次差は大小に依存させない (É と é は同じアクセント、差は三次の大小)。
        let lower_cp = c
            .to_lowercase()
            .next()
            .map(|l| l as u32)
            .filter(|l| (0xC0..=0x17F).contains(l))
            .unwrap_or(cp);
        let base = match cp {
            0xC0..=0xFF => Some((LATIN1_BASE[(cp - 0xC0) as usize], lower_cp - 0xC0)),
            0x100..=0x17F => Some((LATIN_EXT_A_BASE[(cp - 0x100) as usize], lower_cp - 0xC0)),
            _ => None,
        };
        if let Some((base, accent_id)) = base {
            if base == "_" {
                // × ÷ は記号。ASCII 記号のすぐ後 (数字の前) に置く。
                out.0.push(T_PUNCT);
                out.0.push(0xF0);
                out.1.push(1);
                out.2.push(1);
                continue;
            }
            let upper = c.is_uppercase();
            for (j, b) in base.bytes().enumerate() {
                // 展開した 2 文字目以降には二次差を付けない (ß は 1 文字目で ss と区別)。
                let accent = if j == 0 { 2 + accent_id as u8 } else { 1 };
                push_letter(&mut out, b, accent, upper);
            }
            continue;
        }
        // ひらがな・カタカナは一次で同順位 (ひらがなを先にする三次差だけ付ける)。
        let (other, tertiary) = match cp {
            0x3041..=0x3096 => (cp, 1),
            0x30A1..=0x30F6 => (cp - 0x60, 2),
            _ => (cp, 1),
        };
        out.0.push(T_OTHER);
        out.0.extend_from_slice(&other.to_be_bytes()[1..]);
        out.1.push(1);
        out.2.push(tertiary);
    }
    // 一次 | 0 | 二次 | 0 | 三次。各レベルの値は 1 以上なので終端 0 と衝突しない。
    let mut key = out.0;
    key.push(0);
    key.extend_from_slice(&out.1);
    key.push(0);
    key.extend_from_slice(&out.2);
    key.into_boxed_slice()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_to_string_matches_ecmascript() {
        let cases: &[(f64, &str)] = &[
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-1.5, "-1.5"),
            (0.1 + 0.2, "0.30000000000000004"),
            (123456789012345680000.0, "123456789012345680000"),
            (1e21, "1e+21"),
            (1.5e21, "1.5e+21"),
            (1e-6, "0.000001"),
            (1e-7, "1e-7"),
            (1.234e-7, "1.234e-7"),
            (100.0, "100"),
            (0.5, "0.5"),
            (f64::MAX, "1.7976931348623157e+308"),
            (5e-324, "5e-324"),
        ];
        for (x, want) in cases {
            assert_eq!(js_number_to_string(*x), *want, "{x:e}");
        }
    }

    #[test]
    fn to_number_matches_js() {
        assert_eq!(js_to_number(""), 0.0);
        assert_eq!(js_to_number("  12 "), 12.0);
        assert_eq!(js_to_number("0x1f"), 31.0);
        assert!(js_to_number("-0x10").is_nan());
        assert_eq!(js_to_number("1e3"), 1000.0);
        assert_eq!(js_to_number(".5"), 0.5);
        assert_eq!(js_to_number("5."), 5.0);
        assert!(js_to_number("abc").is_nan());
        assert!(js_to_number("inf").is_nan());
        assert!(js_to_number("nan").is_nan());
        assert!(js_to_number("1e").is_nan());
        assert_eq!(js_to_number("-Infinity"), f64::NEG_INFINITY);
        assert!(js_to_number("1 2").is_nan());
    }

    fn cmp(a: &str, b: &str) -> std::cmp::Ordering {
        collation_key(a).cmp(&collation_key(b))
    }

    #[test]
    fn collation_orders_like_icu_for_common_cases() {
        use std::cmp::Ordering::*;
        assert_eq!(cmp("a", "A"), Less);
        assert_eq!(cmp("A", "b"), Less);
        assert_eq!(cmp("01", "1"), Equal);
        assert_eq!(cmp("a2", "a10"), Less);
        assert_eq!(cmp("ab", "a b"), Greater);
        assert_eq!(cmp("_a", "a"), Less);
        assert_eq!(cmp("1", "a"), Less);
        assert_eq!(cmp("", "a"), Less);
        assert_eq!(cmp("a", "ab"), Less);
        assert_eq!(cmp("é", "f"), Less);
        assert_eq!(cmp("é", "e"), Greater);
        assert_eq!(cmp("é", "ez"), Less);
        assert_eq!(cmp("ß", "ss"), Greater);
        assert_eq!(cmp("é", "É"), Less);
        assert_eq!(cmp("あ", "ア"), Less);
        assert_eq!(cmp("ア", "い"), Less);
        assert_eq!(cmp("a", "あ"), Less);
        assert_eq!(cmp("$", "1"), Less);
        assert_eq!(cmp("$", "_"), Greater);
    }
}
