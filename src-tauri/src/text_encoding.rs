//! SQL ファイルの文字コード対応 (#1535)。
//!
//! 日本語環境では Shift_JIS / EUC-JP のダンプや UTF-16 (BOM 付き) で保存された SQL が
//! 現実に流通する。以前は UTF-8 以外を「エラーで拒否」していたため、開く・実行する
//! 経路のどちらでも別のツールで変換し直す必要があった。ここでは次を提供する。
//!
//! * [`TextEncoding`] — 対応する文字コード (UTF-8 / UTF-8 BOM 付き / UTF-16LE / UTF-16BE /
//!   Shift_JIS / EUC-JP)。IPC ではこの識別子文字列で受け渡す。
//! * [`EncodingDetector`] — **ストリーミング**の自動判定。BOM → UTF-16 の NUL パターン →
//!   UTF-8 として妥当か → Shift_JIS / EUC-JP の順に判定する。GB 級のスクリプトでも
//!   チャンクごとに食わせるだけで全体の妥当性まで確認できる (メモリに全文を持たない)。
//! * [`decode_all`] / [`encode`] — ファイル全体の変換。どちらも**置換しない**
//!   (`without_replacement`): 化けた文字を黙って U+FFFD や `&#NNNN;` にすると、そのまま
//!   保存・実行したときに元へ戻せないため、変換できない文字があればエラーにする。

use encoding_rs::{DecoderResult, EncoderResult, Encoding};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

/// 対応する文字コード。`serde` の名前がそのままフロントとの識別子になる。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TextEncoding {
    #[serde(rename = "utf-8")]
    Utf8,
    /// BOM 付き UTF-8。書き出し時に BOM (EF BB BF) を付ける。
    #[serde(rename = "utf-8-bom")]
    Utf8Bom,
    /// UTF-16LE。書き出し時は BOM (FF FE) を付ける。
    #[serde(rename = "utf-16le")]
    Utf16Le,
    /// UTF-16BE。書き出し時は BOM (FE FF) を付ける。
    #[serde(rename = "utf-16be")]
    Utf16Be,
    /// Shift_JIS (Windows-31J / CP932 互換)。
    #[serde(rename = "shift_jis")]
    ShiftJis,
    #[serde(rename = "euc-jp")]
    EucJp,
}

impl TextEncoding {
    /// 対応する `encoding_rs` のコーデック。
    pub fn codec(self) -> &'static Encoding {
        match self {
            TextEncoding::Utf8 | TextEncoding::Utf8Bom => encoding_rs::UTF_8,
            TextEncoding::Utf16Le => encoding_rs::UTF_16LE,
            TextEncoding::Utf16Be => encoding_rs::UTF_16BE,
            TextEncoding::ShiftJis => encoding_rs::SHIFT_JIS,
            TextEncoding::EucJp => encoding_rs::EUC_JP,
        }
    }

    /// 本文のデコーダ。**自分の BOM だけ**を取り除き、別の BOM を見て文字コードを乗り換える
    /// ことはしない (`new_decoder()` は BOM に従って切り替えるので、手動指定が BOM に負ける)。
    pub fn new_decoder(self) -> encoding_rs::Decoder {
        self.codec().new_decoder_with_bom_removal()
    }

    /// エラーメッセージ用の表示名。
    pub fn label(self) -> &'static str {
        match self {
            TextEncoding::Utf8 => "UTF-8",
            TextEncoding::Utf8Bom => "UTF-8 (BOM)",
            TextEncoding::Utf16Le => "UTF-16LE",
            TextEncoding::Utf16Be => "UTF-16BE",
            TextEncoding::ShiftJis => "Shift_JIS",
            TextEncoding::EucJp => "EUC-JP",
        }
    }
}

/// 1 チャンクを (置換せずに) デコードして `out` へ入れる。不正なバイトがあれば `false`。
/// 出力バッファが足りなければ確保し直して続きを処理する。
pub fn decode_chunk(
    decoder: &mut encoding_rs::Decoder,
    bytes: &[u8],
    last: bool,
    out: &mut String,
) -> bool {
    out.clear();
    let mut input = bytes;
    loop {
        let need = decoder
            .max_utf8_buffer_length_without_replacement(input.len())
            .unwrap_or_else(|| input.len().saturating_mul(3).saturating_add(16));
        out.reserve(need);
        let (res, read) = decoder.decode_to_string_without_replacement(input, out, last);
        match res {
            DecoderResult::InputEmpty => return true,
            DecoderResult::Malformed(_, _) => return false,
            DecoderResult::OutputFull => input = &input[read..],
        }
    }
}

/// 自動判定の対象にする候補 1 つ分 (デコーダ + 妥当性 + 日本語らしさのスコア)。
struct Candidate {
    encoding: TextEncoding,
    decoder: encoding_rs::Decoder,
    ok: bool,
    /// 日本語として自然な文字の数 − 半角カナ等の不自然な文字の重み付き数。
    score: i64,
}

impl Candidate {
    fn new(encoding: TextEncoding) -> Self {
        Self {
            encoding,
            decoder: encoding.new_decoder(),
            ok: true,
            score: 0,
        }
    }

    fn feed(&mut self, bytes: &[u8], last: bool, buf: &mut String) {
        if !self.ok {
            return;
        }
        if !decode_chunk(&mut self.decoder, bytes, last, buf) {
            self.ok = false;
            return;
        }
        for c in buf.chars() {
            self.score += char_score(c);
        }
    }
}

/// Shift_JIS と EUC-JP の取り違えを見分けるための文字の重み。ひらがな・カタカナ・
/// 漢字は正の重み、半角カナ (誤判定で出やすい) は負の重み。
fn char_score(c: char) -> i64 {
    match c {
        '\u{3040}'..='\u{30FF}' | '\u{4E00}'..='\u{9FFF}' => 1,
        '\u{FF61}'..='\u{FF9F}' => -2,
        '\u{FFFD}' => -4,
        _ => 0,
    }
}

/// 判定できなかったとき。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DetectError {
    /// 明示された (または BOM / NUL パターンで決まった) 文字コードとして不正なバイトがある。
    Invalid(TextEncoding),
    /// UTF-8 でも Shift_JIS でも EUC-JP でもデコードできない。
    Undetected,
    /// 指定した文字コードと先頭の BOM が食い違う (例: UTF-16 の BOM があるのに Shift_JIS 指定)。
    BomMismatch {
        requested: TextEncoding,
        bom: TextEncoding,
    },
    /// 自動判定で UTF-8 / ASCII / 日本語の文字コードとなったが本文に NUL バイトがある
    /// (バイナリ、または判定できなかった UTF-16)。
    NulBytes,
}

impl DetectError {
    pub fn into_app_error(self) -> AppError {
        match self {
            DetectError::Invalid(enc) => AppError::InvalidInput(format!(
                "the file is not valid {}; pick the correct text encoding and try again",
                enc.label()
            )),
            DetectError::BomMismatch { requested, bom } => AppError::InvalidInput(format!(
                "the file starts with a {} byte order mark but {} was selected; pick {} (or auto-detect)",
                bom.label(),
                requested.label(),
                bom.label()
            )),
            DetectError::NulBytes => AppError::InvalidInput(
                "the file contains NUL bytes; it is probably binary or UTF-16 without a BOM; pick the text encoding manually"
                    .into(),
            ),
            DetectError::Undetected => AppError::InvalidInput(
                "could not detect the text encoding (not valid UTF-8 / Shift_JIS / EUC-JP); pick the encoding manually"
                    .into(),
            ),
        }
    }
}

/// ストリーミングの文字コード判定器。ファイルをチャンクごとに [`feed`](Self::feed)
/// し、最後に [`finish`](Self::finish) で結果を得る。判定と同時に**ファイル全体が
/// その文字コードとして妥当か**も確かめる (実行前に不正バイトを見つけるため)。
pub struct EncodingDetector {
    requested: Option<TextEncoding>,
    started: bool,
    /// ここまでが全部 ASCII なら、候補デコーダはまだ作らない (どの候補でも同じ結果のため)。
    non_ascii_seen: bool,
    candidates: Vec<Candidate>,
    /// 先頭チャンクで BOM / UTF-16 パターンにより確定した文字コード、または明示指定。
    fixed: Option<TextEncoding>,
    /// 手動指定と先頭の BOM が食い違っていたときの BOM 側。
    bom_mismatch: Option<TextEncoding>,
    /// 自動判定の対象に NUL バイトがあったか。
    nul_seen: bool,
    buf: String,
}

/// UTF-16 判定に使う先頭サンプルの最大バイト数。
const UTF16_SAMPLE_BYTES: usize = 4096;

impl EncodingDetector {
    /// `requested` が `Some` ならその文字コードで全体を検証するだけ (自動判定しない)。
    pub fn new(requested: Option<TextEncoding>) -> Self {
        Self {
            requested,
            started: false,
            non_ascii_seen: false,
            candidates: Vec::new(),
            fixed: requested,
            bom_mismatch: None,
            nul_seen: false,
            buf: String::new(),
        }
    }

    pub fn feed(&mut self, bytes: &[u8], last: bool) {
        if !self.started {
            self.started = true;
            match self.requested {
                None => self.fixed = sniff_prefix(bytes),
                Some(req) => {
                    // 手動指定でも先頭の BOM は無視しない。食い違えばエラー (戻り値の文字コードが
                    // 実際の中身と一致しなくなるため)。UTF-8 の指定だけは BOM の有無を実際に合わせる。
                    if let Some(bom) = sniff_bom(bytes) {
                        let utf8_family = |e: TextEncoding| {
                            matches!(e, TextEncoding::Utf8 | TextEncoding::Utf8Bom)
                        };
                        if utf8_family(req) && utf8_family(bom) {
                            self.fixed = Some(bom);
                        } else if req != bom {
                            self.bom_mismatch = Some(bom);
                        }
                    } else if req == TextEncoding::Utf8Bom {
                        self.fixed = Some(TextEncoding::Utf8);
                    }
                }
            }
            if let Some(enc) = self.fixed {
                self.candidates.push(Candidate::new(enc));
            }
        }
        if self.fixed.is_some() {
            for cand in &mut self.candidates {
                cand.feed(bytes, last, &mut self.buf);
            }
            return;
        }
        // 自動判定 (BOM なし・UTF-16 パターンなし)。
        if self.requested.is_none() && !self.nul_seen && bytes.contains(&0) {
            self.nul_seen = true;
        }
        if !self.non_ascii_seen {
            if bytes.is_ascii() {
                return;
            }
            self.non_ascii_seen = true;
            self.candidates = vec![
                Candidate::new(TextEncoding::Utf8),
                Candidate::new(TextEncoding::ShiftJis),
                Candidate::new(TextEncoding::EucJp),
            ];
        }
        for cand in &mut self.candidates {
            cand.feed(bytes, last, &mut self.buf);
        }
    }

    /// 判定結果。全チャンクを `last = true` の呼び出しまで含めて食わせたあとに呼ぶ。
    pub fn finish(self) -> std::result::Result<TextEncoding, DetectError> {
        if let (Some(req), Some(bom)) = (self.requested, self.bom_mismatch) {
            return Err(DetectError::BomMismatch {
                requested: req,
                bom,
            });
        }
        if self.requested.is_none() && self.fixed.is_none() && self.nul_seen {
            return Err(DetectError::NulBytes);
        }
        if let Some(enc) = self.fixed {
            return match self.candidates.first() {
                Some(c) if c.ok => Ok(enc),
                Some(_) => Err(DetectError::Invalid(enc)),
                // 空ファイル (チャンクが 1 度も来ない) は指定どおり / UTF-8。
                None => Ok(enc),
            };
        }
        if !self.non_ascii_seen {
            return Ok(TextEncoding::Utf8);
        }
        let utf8_ok = self
            .candidates
            .iter()
            .any(|c| c.encoding == TextEncoding::Utf8 && c.ok);
        if utf8_ok {
            return Ok(TextEncoding::Utf8);
        }
        let mut best: Option<&Candidate> = None;
        for c in self.candidates.iter().filter(|c| c.ok) {
            // 同点なら先に並べた方 (Shift_JIS) を優先する。
            if best.map_or(true, |b| c.score > b.score) {
                best = Some(c);
            }
        }
        best.map(|c| c.encoding).ok_or(DetectError::Undetected)
    }
}

/// 先頭バイト列から BOM / BOM なし UTF-16 を判定する。
fn sniff_bom(bytes: &[u8]) -> Option<TextEncoding> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return Some(TextEncoding::Utf8Bom);
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return Some(TextEncoding::Utf16Le);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return Some(TextEncoding::Utf16Be);
    }
    None
}

fn sniff_prefix(bytes: &[u8]) -> Option<TextEncoding> {
    if let Some(bom) = sniff_bom(bytes) {
        return Some(bom);
    }
    // BOM なしの UTF-16: ASCII 主体の SQL なら、片方の偶奇位置にだけ NUL が並ぶ。
    let sample = &bytes[..bytes.len().min(UTF16_SAMPLE_BYTES)];
    if sample.len() < 4 {
        return None;
    }
    let (mut even, mut odd) = (0usize, 0usize);
    for (i, b) in sample.iter().enumerate() {
        if *b == 0 {
            if i % 2 == 0 {
                even += 1;
            } else {
                odd += 1;
            }
        }
    }
    // 比率で判定する: 片側の位置に NUL が十分多く (全体の 1/8 以上かつ 2 個以上)、反対側は
    // その 1/8 以下。日本語主体の UTF-16 は ASCII が少なく NUL も少ないので閾値を低めにし、
    // 数個の混入 NUL だけで UTF-16 とは見なさない。最終的な妥当性は全体のデコードで確かめる。
    let slots = sample.len() / 2;
    if odd >= 2 && odd * 8 >= slots && even * 8 <= odd {
        return Some(TextEncoding::Utf16Le);
    }
    if even >= 2 && even * 8 >= slots && odd * 8 <= even {
        return Some(TextEncoding::Utf16Be);
    }
    None
}

/// バイト列全体の文字コードを判定する (ファイル全体がメモリにある場合、テスト用)。
#[cfg(test)]
pub fn detect(bytes: &[u8]) -> std::result::Result<TextEncoding, DetectError> {
    detect_with(bytes, None)
}

/// [`detect`] に手動指定を加えたもの。`requested` が `Some` なら自動判定せずその文字コードで
/// 全体を検証し、BOM が食い違えばエラー。返す文字コードは実際の中身と一致する。
pub fn detect_with(
    bytes: &[u8],
    requested: Option<TextEncoding>,
) -> std::result::Result<TextEncoding, DetectError> {
    let mut d = EncodingDetector::new(requested);
    d.feed(bytes, true);
    d.finish()
}

/// バイト列全体を `encoding` でデコードする。先頭の BOM は取り除く。不正なバイトが
/// あればエラー (置換しない)。
pub fn decode_all(bytes: &[u8], encoding: TextEncoding) -> Result<String> {
    let mut decoder = encoding.new_decoder();
    let mut out = String::new();
    if decode_chunk(&mut decoder, bytes, true, &mut out) {
        Ok(out)
    } else {
        Err(DetectError::Invalid(encoding).into_app_error())
    }
}

/// 文字コード選び直し UI (#1627) のプレビューで、各候補に使う先頭のバイト数。
pub const PREVIEW_BYTES: usize = 4096;
/// プレビューに出す最大行数。
const PREVIEW_LINES: usize = 5;
/// プレビュー 1 行の最大文字数 (超えた分は `…` で省く)。
const PREVIEW_LINE_CHARS: usize = 160;

/// 候補 1 つ分のプレビュー (#1627)。`valid` はその文字コードとして先頭バイトに不正が
/// 無かったか、`lines` は不正バイトを U+FFFD に置換して読んだ先頭の数行。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct EncodingPreview {
    pub encoding: TextEncoding,
    pub valid: bool,
    pub lines: Vec<String>,
}

/// 全ての対応文字コードで先頭 [`PREVIEW_BYTES`] を読んだ結果を返す。実際の読み込み
/// ([`decode_all`]) と違い、化けた文字も置換して見せる (どの候補が自然かを人が選ぶため)。
/// 読み込み自体はこの関数を使わず、利用者が選んだ文字コードで `read_sql_file` が行う。
pub fn preview_candidates(bytes: &[u8]) -> Vec<EncodingPreview> {
    let end = bytes.len().min(PREVIEW_BYTES);
    let last = bytes.len() <= PREVIEW_BYTES;
    [
        TextEncoding::Utf8,
        TextEncoding::Utf8Bom,
        TextEncoding::ShiftJis,
        TextEncoding::EucJp,
        TextEncoding::Utf16Le,
        TextEncoding::Utf16Be,
    ]
    .into_iter()
    .map(|encoding| {
        let mut decoder = encoding.codec().new_decoder_without_bom_handling();
        let prefix = &bytes[..end];
        let need = decoder
            .max_utf8_buffer_length(prefix.len())
            .unwrap_or_else(|| prefix.len().saturating_mul(3).saturating_add(16));
        let mut out = String::with_capacity(need);
        let (_, _, had_errors) = decoder.decode_to_string(prefix, &mut out, last);
        let text = out.strip_prefix('\u{feff}').unwrap_or(&out);
        let lines = text
            .lines()
            .take(PREVIEW_LINES)
            .map(|l| {
                if l.chars().count() > PREVIEW_LINE_CHARS {
                    let cut: String = l.chars().take(PREVIEW_LINE_CHARS).collect();
                    format!("{cut}…")
                } else {
                    l.to_string()
                }
            })
            .collect();
        EncodingPreview {
            encoding,
            valid: !had_errors,
            lines,
        }
    })
    .collect()
}

/// `text` を `encoding` のバイト列にする。UTF-8 BOM / UTF-16 は BOM を付ける。
/// その文字コードで表せない文字があればエラー (`&#NNNN;` 等へ置換しない)。
pub fn encode(text: &str, encoding: TextEncoding) -> Result<Vec<u8>> {
    match encoding {
        TextEncoding::Utf8 => Ok(text.as_bytes().to_vec()),
        TextEncoding::Utf8Bom => {
            let mut out = Vec::with_capacity(text.len() + 3);
            out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            out.extend_from_slice(text.as_bytes());
            Ok(out)
        }
        TextEncoding::Utf16Le => {
            let mut out = Vec::with_capacity(text.len() * 2 + 2);
            out.extend_from_slice(&[0xFF, 0xFE]);
            for u in text.encode_utf16() {
                out.extend_from_slice(&u.to_le_bytes());
            }
            Ok(out)
        }
        TextEncoding::Utf16Be => {
            let mut out = Vec::with_capacity(text.len() * 2 + 2);
            out.extend_from_slice(&[0xFE, 0xFF]);
            for u in text.encode_utf16() {
                out.extend_from_slice(&u.to_be_bytes());
            }
            Ok(out)
        }
        TextEncoding::ShiftJis | TextEncoding::EucJp => {
            let mut encoder = encoding.codec().new_encoder();
            let mut out: Vec<u8> = Vec::new();
            let mut input = text;
            loop {
                let need = encoder
                    .max_buffer_length_from_utf8_without_replacement(input.len())
                    .unwrap_or_else(|| input.len().saturating_mul(3).saturating_add(16));
                out.reserve(need);
                let (res, read) =
                    encoder.encode_from_utf8_to_vec_without_replacement(input, &mut out, true);
                match res {
                    EncoderResult::InputEmpty => return Ok(out),
                    EncoderResult::Unmappable(c) => {
                        return Err(AppError::InvalidInput(format!(
                            "the text contains a character that cannot be represented in {}: '{}' (U+{:04X}); choose UTF-8 or another encoding",
                            encoding.label(),
                            c,
                            c as u32
                        )))
                    }
                    EncoderResult::OutputFull => input = &input[read..],
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const JP: &str = "-- 日本語のコメント\nINSERT INTO t VALUES ('こんにちは世界', 'ｱｲｳ');\n";

    #[test]
    fn ascii_and_utf8_are_utf8() {
        assert_eq!(detect(b"SELECT 1;").unwrap(), TextEncoding::Utf8);
        assert_eq!(detect(JP.as_bytes()).unwrap(), TextEncoding::Utf8);
        assert_eq!(detect(b"").unwrap(), TextEncoding::Utf8);
    }

    #[test]
    fn bom_decides_the_encoding() {
        let mut b = vec![0xEF, 0xBB, 0xBF];
        b.extend_from_slice(b"SELECT 1;");
        assert_eq!(detect(&b).unwrap(), TextEncoding::Utf8Bom);
        assert_eq!(decode_all(&b, TextEncoding::Utf8Bom).unwrap(), "SELECT 1;");
        let le = encode("SELECT '日本';", TextEncoding::Utf16Le).unwrap();
        assert_eq!(detect(&le).unwrap(), TextEncoding::Utf16Le);
        assert_eq!(
            decode_all(&le, TextEncoding::Utf16Le).unwrap(),
            "SELECT '日本';"
        );
        let be = encode("SELECT '日本';", TextEncoding::Utf16Be).unwrap();
        assert_eq!(detect(&be).unwrap(), TextEncoding::Utf16Be);
        assert_eq!(
            decode_all(&be, TextEncoding::Utf16Be).unwrap(),
            "SELECT '日本';"
        );
    }

    #[test]
    fn utf16_without_bom_is_detected_by_nul_pattern() {
        let mut le = Vec::new();
        for u in "SELECT * FROM users WHERE id = 1;".encode_utf16() {
            le.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(detect(&le).unwrap(), TextEncoding::Utf16Le);
        let mut be = Vec::new();
        for u in "SELECT * FROM users WHERE id = 1;".encode_utf16() {
            be.extend_from_slice(&u.to_be_bytes());
        }
        assert_eq!(detect(&be).unwrap(), TextEncoding::Utf16Be);
    }

    #[test]
    fn utf16_without_bom_is_detected_by_ratio_even_with_stray_nul_or_cjk() {
        // 日本語主体 (ASCII が少ない) でも検出できる。
        let mut le = Vec::new();
        for u in "INSERT INTO t VALUES ('日本語の長いテキストです');".encode_utf16() {
            le.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(detect(&le).unwrap(), TextEncoding::Utf16Le);
        // 偶数側に 1 つ NUL が混ざっても、反対側が十分多ければ UTF-16LE。
        let mut le2 = Vec::new();
        for u in "SELECT * FROM users WHERE id = 1 AND name = 'x';".encode_utf16() {
            le2.extend_from_slice(&u.to_le_bytes());
        }
        le2[10] = 0;
        assert_eq!(detect(&le2).unwrap(), TextEncoding::Utf16Le);
    }

    #[test]
    fn nul_bytes_in_utf8_or_ascii_are_rejected() {
        assert_eq!(detect(b"SELECT 1;\0 SELECT 2;"), Err(DetectError::NulBytes));
        assert_eq!(
            detect("SELECT '日本';\0".as_bytes()),
            Err(DetectError::NulBytes)
        );
        // 明示指定ならこの検査はしない (従来どおりデコードの妥当性だけ)。
        assert_eq!(
            detect_with(b"SELECT 1;\0", Some(TextEncoding::Utf8)),
            Ok(TextEncoding::Utf8)
        );
    }

    #[test]
    fn explicit_encoding_conflicting_with_the_bom_is_an_error() {
        let le = encode("SELECT 1;", TextEncoding::Utf16Le).unwrap();
        assert_eq!(
            detect_with(&le, Some(TextEncoding::ShiftJis)),
            Err(DetectError::BomMismatch {
                requested: TextEncoding::ShiftJis,
                bom: TextEncoding::Utf16Le
            })
        );
        assert!(detect_with(&le, Some(TextEncoding::Utf16Be)).is_err());
        assert_eq!(
            detect_with(&le, Some(TextEncoding::Utf16Le)),
            Ok(TextEncoding::Utf16Le)
        );
        // UTF-8 系は BOM の有無を実際に合わせて返す。
        let bom8 = encode("SELECT 1;", TextEncoding::Utf8Bom).unwrap();
        assert_eq!(
            detect_with(&bom8, Some(TextEncoding::Utf8)),
            Ok(TextEncoding::Utf8Bom)
        );
        assert_eq!(
            detect_with(b"SELECT 1;", Some(TextEncoding::Utf8Bom)),
            Ok(TextEncoding::Utf8)
        );
    }

    #[test]
    fn shift_jis_and_euc_jp_are_told_apart() {
        let text = "INSERT INTO 顧客 (名前, 住所) VALUES ('山田太郎', '東京都千代田区');\n";
        let sj = encode(text, TextEncoding::ShiftJis).unwrap();
        assert_eq!(detect(&sj).unwrap(), TextEncoding::ShiftJis);
        assert_eq!(decode_all(&sj, TextEncoding::ShiftJis).unwrap(), text);
        let euc = encode(text, TextEncoding::EucJp).unwrap();
        assert_eq!(detect(&euc).unwrap(), TextEncoding::EucJp);
        assert_eq!(decode_all(&euc, TextEncoding::EucJp).unwrap(), text);
    }

    #[test]
    fn detection_works_across_chunk_boundaries() {
        let text = "-- ヘッダ\n".repeat(2000) + "INSERT INTO t VALUES ('漢字');\n";
        let sj = encode(&text, TextEncoding::ShiftJis).unwrap();
        let mut d = EncodingDetector::new(None);
        let chunks: Vec<&[u8]> = sj.chunks(7).collect();
        let n = chunks.len();
        for (i, c) in chunks.into_iter().enumerate() {
            d.feed(c, i + 1 == n);
        }
        assert_eq!(d.finish().unwrap(), TextEncoding::ShiftJis);
    }

    #[test]
    fn late_non_ascii_after_long_ascii_prefix_is_still_detected() {
        let text = "SELECT 1;\n".repeat(100_000) + "INSERT INTO t VALUES ('日本語テキスト');\n";
        let sj = encode(&text, TextEncoding::ShiftJis).unwrap();
        let mut d = EncodingDetector::new(None);
        let chunks: Vec<&[u8]> = sj.chunks(64 * 1024).collect();
        let n = chunks.len();
        for (i, c) in chunks.into_iter().enumerate() {
            d.feed(c, i + 1 == n);
        }
        assert_eq!(d.finish().unwrap(), TextEncoding::ShiftJis);
    }

    #[test]
    fn explicit_encoding_rejects_invalid_bytes() {
        let sj = encode("日本語", TextEncoding::ShiftJis).unwrap();
        assert!(decode_all(&sj, TextEncoding::Utf8).is_err());
        let mut d = EncodingDetector::new(Some(TextEncoding::Utf8));
        d.feed(&sj, true);
        assert_eq!(d.finish(), Err(DetectError::Invalid(TextEncoding::Utf8)));
    }

    #[test]
    fn undecodable_bytes_are_reported() {
        // 単独の継続バイト + 未割り当てリード: どの候補でも不正。
        let bytes = [0x80, 0x80, 0xFF, 0xFF];
        assert!(detect(&bytes).is_err());
    }

    #[test]
    fn encode_rejects_unmappable_characters() {
        // 絵文字は Shift_JIS / EUC-JP に無い。
        let err = encode("SELECT '😀'", TextEncoding::ShiftJis).unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
        assert!(encode("SELECT '😀'", TextEncoding::Utf16Le).is_ok());
    }

    #[test]
    fn encode_round_trips_every_encoding() {
        for enc in [
            TextEncoding::Utf8,
            TextEncoding::Utf8Bom,
            TextEncoding::Utf16Le,
            TextEncoding::Utf16Be,
            TextEncoding::ShiftJis,
            TextEncoding::EucJp,
        ] {
            let bytes = encode(JP, enc).unwrap();
            assert_eq!(decode_all(&bytes, enc).unwrap(), JP, "{}", enc.label());
        }
    }

    #[test]
    fn preview_candidates_shows_every_encoding_and_flags_invalid() {
        let sj = encode("SELECT '日本語';\nSELECT 2;", TextEncoding::ShiftJis).unwrap();
        let previews = preview_candidates(&sj);
        assert_eq!(previews.len(), 6);
        let by = |e: TextEncoding| previews.iter().find(|p| p.encoding == e).unwrap();
        let s = by(TextEncoding::ShiftJis);
        assert!(s.valid);
        assert_eq!(s.lines, vec!["SELECT '日本語';", "SELECT 2;"]);
        // UTF-8 としては不正で、置換文字が混じる。
        let u = by(TextEncoding::Utf8);
        assert!(!u.valid);
        assert!(u.lines[0].contains('\u{fffd}'));
    }

    #[test]
    fn preview_candidates_strips_bom_and_limits_lines() {
        let text = (1..=20)
            .map(|i| format!("SELECT {i};"))
            .collect::<Vec<_>>()
            .join("\n");
        let bytes = encode(&text, TextEncoding::Utf8Bom).unwrap();
        let p = preview_candidates(&bytes);
        let u = p
            .iter()
            .find(|p| p.encoding == TextEncoding::Utf8Bom)
            .unwrap();
        assert!(u.valid);
        assert_eq!(u.lines.len(), 5);
        assert_eq!(u.lines[0], "SELECT 1;");
    }

    #[test]
    fn preview_candidates_tolerates_a_multibyte_char_cut_at_the_boundary() {
        // 先頭 4096 バイトの境界で多バイト文字が切れても「不正」とは扱わない。
        let text = "あ".repeat(3000);
        let bytes = encode(&text, TextEncoding::Utf8).unwrap();
        assert!(bytes.len() > PREVIEW_BYTES && PREVIEW_BYTES % 3 != 0);
        let p = preview_candidates(&bytes);
        assert!(
            p.iter()
                .find(|p| p.encoding == TextEncoding::Utf8)
                .unwrap()
                .valid
        );
    }

    #[test]
    fn serde_uses_stable_identifiers() {
        let s = serde_json::to_string(&TextEncoding::ShiftJis).unwrap();
        assert_eq!(s, "\"shift_jis\"");
        let e: TextEncoding = serde_json::from_str("\"utf-16le\"").unwrap();
        assert_eq!(e, TextEncoding::Utf16Le);
        assert!(serde_json::from_str::<TextEncoding>("\"latin1\"").is_err());
    }
}
