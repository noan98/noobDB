//! JS (ブラウザ) の文字列化・数値化・文字列比較を Rust で再現する小さな道具箱 (#1264)。
//!
//! 結果ハンドル経由のソート・フィルタ・検索 (`result_ops`) は、フロントの
//! `ResultGrid.tsx` / `gridFind.ts` (= JS の `String(v)` / `Number(v)` /
//! `Intl.Collator`) と**同じ結果**を返さなければならない。この層は値の型変換だけを担い、
//! 判定ロジックは `result_ops` に置く。
//!
//! - [`value_str`]: `String(v)` (NULL は `None` = JS の `null`)
//! - [`js_to_number`]: `Number(str)` (`NaN` を含む。空文字列は 0)
//! - [`collation_key`]: `new Intl.Collator(undefined, { numeric: true })` の近似キー
//!
//! **照合順序は完全一致ではない。** ICU の照合 (ロケール依存・Unicode 全域) を再現する
//! 代わりに、ASCII (句読点 < 数字 < 英字、大小は無視して同順位 → 同値なら小文字が先)、
//! 数字列の数値比較、Latin-1 / Latin Extended-A / Extended-B (一部) / Extended Additional のアクセント付き英字、ひらがな・
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

/// 整数を 10 進文字列にするための固定長バッファ (ヒープ確保なし)。
/// 結果ハンドルのフィルタ・検索は全行 x 全列で数値セルを文字列化するため、
/// `to_string()` の `String` 確保を避ける (#1610)。
pub struct IntBuf {
    buf: [u8; 40],
    start: usize,
}

impl IntBuf {
    pub fn new(neg: bool, mut mag: u128) -> Self {
        let mut buf = [0u8; 40];
        let mut i = buf.len();
        loop {
            i -= 1;
            buf[i] = b'0' + (mag % 10) as u8;
            mag /= 10;
            if mag == 0 {
                break;
            }
        }
        if neg {
            i -= 1;
            buf[i] = b'-';
        }
        Self { buf, start: i }
    }

    pub fn as_str(&self) -> &str {
        // 書き込んだのは ASCII の数字と '-' だけ。万一不正でも空文字に倒す。
        std::str::from_utf8(&self.buf[self.start..]).unwrap_or("")
    }
}

/// `Int` / `UInt` セルを確保なしで文字列化する。それ以外は `None`。
pub fn int_buf(v: &Value) -> Option<IntBuf> {
    match v {
        Value::Int(i) => Some(IntBuf::new(*i < 0, i.unsigned_abs() as u128)),
        Value::UInt(u) => Some(IntBuf::new(false, *u as u128)),
        _ => None,
    }
}

/// JS の `String(v)` 相当。NULL は `None`。
pub fn value_str(v: &Value) -> Option<Cow<'_, str>> {
    match v {
        Value::Null => None,
        Value::Bool(b) => Some(Cow::Borrowed(if *b { "true" } else { "false" })),
        Value::Int(i) => Some(Cow::Owned(i.to_string())),
        Value::UInt(u) => Some(Cow::Owned(u.to_string())),
        // 非有限値は IPC で `"NaN"` / `"Infinity"` / `"-Infinity"` の文字列になる
        // (`Value` の `Serialize`、#1597) ので、フロントの `String(v)` と同じ綴りを返す。
        Value::Float(f) => Some(Cow::Owned(js_number_to_string(*f))),
        Value::String(s) | Value::Bytes(s) => Some(Cow::Borrowed(s.as_str())),
    }
}

/// 2 の冪基数 (16/8/2 進) の桁列を、最後に 1 回だけ丸めて f64 にする (JS の `Number("0x…")` 相当)。
/// 1 桁ずつ f64 で積むと 2^53 超で丸めが重なってずれる (#1983)。128 bit に収まる値は `u128` で
/// 正確に積んでから変換し、超える値は上位 64 bit + 下位の sticky ビット (round-to-odd) で
/// 二重丸めを避ける。
fn pow2_digits_to_f64(digits: &[u32], bits_per_digit: u32) -> f64 {
    let mut bits: Vec<bool> = Vec::with_capacity(digits.len() * bits_per_digit as usize);
    for &d in digits {
        for i in (0..bits_per_digit).rev() {
            bits.push((d >> i) & 1 == 1);
        }
    }
    let start = bits.iter().position(|&b| b).unwrap_or(bits.len());
    let bits = &bits[start..];
    if bits.len() <= 128 {
        let v = bits.iter().fold(0u128, |a, &b| (a << 1) | u128::from(b));
        return v as f64;
    }
    let extra = bits.len() - 64;
    let top = bits[..64]
        .iter()
        .fold(0u64, |a, &b| (a << 1) | u64::from(b));
    let sticky = bits[64..].iter().any(|&b| b);
    let m = top | u64::from(sticky);
    // 指数が f64 の範囲を超えるときは powi が inf になり、結果も inf になる。
    (m as f64) * 2f64.powi(i32::try_from(extra).unwrap_or(i32::MAX))
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
            let mut digits: Vec<u32> = Vec::with_capacity(t.len() - 2);
            for c in t[2..].chars() {
                match c.to_digit(radix) {
                    Some(d) => digits.push(d),
                    None => return f64::NAN,
                }
            }
            return pow2_digits_to_f64(&digits, radix.trailing_zeros());
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

/// JS の `Number(v)` 相当 (セル値から)。NULL は `None`。非有限の浮動小数は IPC で文字列になる (#1597) ので `Number("NaN")` 等と同じく `NaN` / ±`Infinity`。
pub fn value_number(v: &Value) -> Option<f64> {
    match v {
        Value::Null => None,
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::Int(i) => Some(*i as f64),
        Value::UInt(u) => Some(*u as f64),
        Value::Float(f) => Some(*f),
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

/// 二次(アクセント)レベルへ 2 バイトで積む。Latin Extended Additional (U+1E00..) の
/// コードポイント差は 1 バイトに収まらないため、(上位, 下位) の 7bit ずつにして
/// 各バイトを 1 以上に保つ (終端の 0 と衝突させない)。
fn push_accent(out: &mut Vec<u8>, accent: u16) {
    out.push((accent >> 7) as u8 + 1);
    out.push((accent & 0x7F) as u8 + 1);
}

/// Latin Extended-B (一部) と Latin Extended Additional (U+1E00..=U+1EFF) の基底文字。
/// 表にない文字は `None` (コードポイント順に倒す)。ベトナム語の `ễ` / `ạ`、
/// ルーマニア語の `ș` / `ț` などを基底文字の近くに並べる。
/// ICU が基底文字と**別の一次キー**を持たせる文字 (`ƀ` `Ƒ` `ƒ` `Ɨ` `Ƙ` `ƙ` `ƚ` `Ʈ`
/// `Ƶ` `ƶ` `ẚ` など。横線・フック付きで別字扱い) は表に入れない。入れると JS と順序が逆になる。
fn latin_extended_base(cp: u32) -> Option<&'static str> {
    let b = match cp {
        0x1A0..=0x1A1 => "o",
        0x1AF..=0x1B0 => "u",
        0x1CD..=0x1CE => "a",
        0x1CF..=0x1D0 => "i",
        0x1D1..=0x1D2 => "o",
        0x1D3..=0x1DC => "u",
        0x1DE..=0x1E1 => "a",
        0x1E2..=0x1E3 | 0x1FC..=0x1FD => "ae",
        0x1E6..=0x1E7 | 0x1F4..=0x1F5 => "g",
        0x1E8..=0x1E9 => "k",
        0x1EA..=0x1ED | 0x1FE..=0x1FF => "o",
        0x1F8..=0x1F9 => "n",
        0x1FA..=0x1FB | 0x200..=0x203 | 0x226..=0x227 => "a",
        0x204..=0x207 | 0x228..=0x229 => "e",
        0x208..=0x20B => "i",
        0x20C..=0x20F | 0x22A..=0x231 => "o",
        0x210..=0x213 => "r",
        0x214..=0x217 => "u",
        0x218..=0x219 => "s",
        0x21A..=0x21B => "t",
        0x21E..=0x21F => "h",
        0x232..=0x233 => "y",
        0x1E00..=0x1E01 | 0x1EA0..=0x1EB7 => "a",
        0x1E02..=0x1E07 => "b",
        0x1E08..=0x1E09 => "c",
        0x1E0A..=0x1E13 => "d",
        0x1E14..=0x1E1D | 0x1EB8..=0x1EC7 => "e",
        0x1E1E..=0x1E1F => "f",
        0x1E20..=0x1E21 => "g",
        0x1E22..=0x1E2B | 0x1E96 => "h",
        0x1E2C..=0x1E2F | 0x1EC8..=0x1ECB => "i",
        0x1E30..=0x1E35 => "k",
        0x1E36..=0x1E3D => "l",
        0x1E3E..=0x1E43 => "m",
        0x1E44..=0x1E4B => "n",
        0x1E4C..=0x1E53 | 0x1ECC..=0x1EE3 => "o",
        0x1E54..=0x1E57 => "p",
        0x1E58..=0x1E5F => "r",
        0x1E60..=0x1E69 | 0x1E9B => "s",
        0x1E6A..=0x1E71 | 0x1E97 => "t",
        0x1E72..=0x1E7B | 0x1EE4..=0x1EF1 => "u",
        0x1E7C..=0x1E7F => "v",
        0x1E80..=0x1E89 | 0x1E98 => "w",
        0x1E8A..=0x1E8D => "x",
        0x1E8E..=0x1E8F | 0x1E99 | 0x1EF2..=0x1EF9 => "y",
        0x1E90..=0x1E95 => "z",
        0x1E9E => "ss",
        _ => return None,
    };
    Some(b)
}

fn push_letter(out: &mut (Vec<u8>, Vec<u8>, Vec<u8>), base: u8, accent: u16, upper: bool) {
    out.0.push(T_LETTER);
    out.0.push(base - b'a');
    push_accent(&mut out.1, accent);
    out.2.push(if upper { 2 } else { 1 });
}

/// `Intl.Collator(undefined, { numeric: true })` に近い照合キーを作る。バイト列の
/// 辞書順比較が照合順序になる。
///
/// 再現する範囲:
/// - 一次: 制御文字は無視。空白・ASCII 記号 < 数字列 < 英字 (大小同順位) < その他。
///   数字列は先頭のゼロを無視した数値順 (`"a2" < "a10"`、`"01"` と `"1"` は同値)。
/// - 二次: Latin-1 / Latin Extended-A / Extended-B (一部) / Extended Additional のアクセント付き英字は基底文字と同順位で、
///   アクセント無し < 有り。`ß` は `ss`、`æ` は `ae`、`œ` は `oe` に展開する。
/// - 三次: 小文字 < 大文字、ひらがな < カタカナ。
///
/// **再現しない範囲 (ICU との既知の差)**: 上記以外の非 ASCII 文字 (キリル・ギリシャ・
/// 漢字・合成済みでない結合文字など) はコードポイント順。ロケール固有の照合
/// (スウェーデン語の `ä` が `z` の後 等)、全角/半角の同一視、`ignorePunctuation` 系、
/// 数字以外の Unicode 10 進数字の数値化は扱わない。
///
/// 異なるダイアクリティカル同士 (`é` と `è`、`ạ` と `ả`) の二次順序は ICU と逆になる
/// (共有ゴールデン `collationKeyVectors.json` の `knownDifferences`)。
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
            push_accent(&mut out.1, 1);
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
                push_accent(&mut out.1, 1);
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
            .filter(|l| (0xC0..=0x1EFF).contains(l))
            .unwrap_or(cp);
        let base = match cp {
            0xC0..=0xFF => Some((LATIN1_BASE[(cp - 0xC0) as usize], lower_cp - 0xC0)),
            0x100..=0x17F => Some((LATIN_EXT_A_BASE[(cp - 0x100) as usize], lower_cp - 0xC0)),
            _ => latin_extended_base(cp).map(|b| (b, lower_cp - 0xC0)),
        };
        if let Some((base, accent_id)) = base {
            if base == "_" {
                // × ÷ は記号。ASCII 記号のすぐ後 (数字の前) に置く。
                out.0.push(T_PUNCT);
                out.0.push(0xF0);
                push_accent(&mut out.1, 1);
                out.2.push(1);
                continue;
            }
            let upper = c.is_uppercase();
            for (j, b) in base.bytes().enumerate() {
                // 展開した 2 文字目以降には二次差を付けない (ß は 1 文字目で ss と区別)。
                let accent = if j == 0 { 2 + accent_id as u16 } else { 1 };
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
        push_accent(&mut out.1, 1);
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
    fn int_buf_matches_to_string() {
        for i in [0i64, 1, -1, 9, 10, -10, i64::MAX, i64::MIN, 1234567890123] {
            let b = int_buf(&Value::Int(i)).expect("int");
            assert_eq!(b.as_str(), i.to_string());
        }
        for u in [0u64, 7, u64::MAX] {
            let b = int_buf(&Value::UInt(u)).expect("uint");
            assert_eq!(b.as_str(), u.to_string());
        }
        assert!(int_buf(&Value::Null).is_none());
    }

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

    #[test]
    fn collation_places_latin_extended_near_base_letter() {
        use std::cmp::Ordering::*;
        // ベトナム語 (Latin Extended Additional): ễ は e の近く、z より前。
        assert_eq!(cmp("Nguyễn", "Nguyz"), Less);
        assert_eq!(cmp("Nguyễn", "Nguyen"), Greater);
        assert_eq!(cmp("ạ", "b"), Less);
        assert_eq!(cmp("ạ", "a"), Greater);
        // ルーマニア語 (Latin Extended-B): ș / ț は s / t の近く。
        assert_eq!(cmp("Ștefan", "Sz"), Less);
        assert_eq!(cmp("ț", "u"), Less);
        assert_eq!(cmp("ș", "s"), Greater);
        // 大小は三次差 (小文字が先)。
        assert_eq!(cmp("ễ", "Ễ"), Less);
        // 異なるアクセントは区別する。
        assert_ne!(cmp("ạ", "ả"), Equal);
    }
}
