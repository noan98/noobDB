//! 取り込みファイルのストリーミング文字コード変換 (#1258)。
//!
//! 従来のプレビューは `read_import_file` で全体 (最大 512MB) を読み、`decode_bytes`
//! で全体を UTF-8 へ変換してから先頭 50 行だけを使っていた。[`DecodingReader`] は
//! `encoding_rs::Decoder` をチャンク単位で回す `Read` 実装で、ファイルの先頭から
//! 必要なぶんだけ読んで UTF-8 に変換する。デコーダが状態を持つので、チャンク境界が
//! マルチバイト文字の途中に来ても正しく復号される (途中で切れた文字が置換文字に
//! 化けない)。BOM の判定・不正バイトの置換文字化は `Encoding::decode` と同じ。

use std::io::{self, Read};

/// 1 回に読むバイト数。
const DEFAULT_CHUNK_BYTES: usize = 64 * 1024;

pub(crate) struct DecodingReader<R: Read> {
    inner: R,
    decoder: encoding_rs::Decoder,
    input: Vec<u8>,
    output: Vec<u8>,
    pos: usize,
    finished: bool,
}

impl<R: Read> DecodingReader<R> {
    /// `encoding` は `encoding_rs` のラベル。未知のラベルは UTF-8 にフォールバックする
    /// (`decode_bytes` と同じ)。
    pub(crate) fn new(inner: R, encoding: &str) -> Self {
        Self::with_chunk_size(inner, encoding, DEFAULT_CHUNK_BYTES)
    }

    pub(crate) fn with_chunk_size(inner: R, encoding: &str, chunk: usize) -> Self {
        let enc =
            encoding_rs::Encoding::for_label(encoding.as_bytes()).unwrap_or(encoding_rs::UTF_8);
        Self {
            inner,
            decoder: enc.new_decoder(),
            input: vec![0u8; chunk.max(1)],
            output: Vec::new(),
            pos: 0,
            finished: false,
        }
    }

    /// 次のチャンクを読んで `output` へ変換する。EOF に達したら `finished` を立てる。
    fn refill(&mut self) -> io::Result<()> {
        let n = loop {
            match self.inner.read(&mut self.input) {
                Ok(n) => break n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            }
        };
        let last = n == 0;
        let cap = self
            .decoder
            .max_utf8_buffer_length(n)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "decode buffer overflow"))?;
        self.output.clear();
        self.output.resize(cap, 0);
        let (_result, _read, written, _errors) =
            self.decoder
                .decode_to_utf8(&self.input[..n], &mut self.output, last);
        self.output.truncate(written);
        self.pos = 0;
        if last {
            self.finished = true;
        }
        Ok(())
    }
}

impl<R: Read> Read for DecodingReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        while self.pos >= self.output.len() {
            if self.finished {
                return Ok(0);
            }
            self.refill()?;
        }
        let n = buf.len().min(self.output.len() - self.pos);
        buf[..n].copy_from_slice(&self.output[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_all(bytes: &[u8], label: &str, chunk: usize) -> String {
        let mut r = DecodingReader::with_chunk_size(bytes, label, chunk);
        let mut out = String::new();
        r.read_to_string(&mut out).unwrap();
        out
    }

    fn reference(bytes: &[u8], label: &str) -> String {
        let enc = encoding_rs::Encoding::for_label(label.as_bytes()).unwrap_or(encoding_rs::UTF_8);
        enc.decode(bytes).0.into_owned()
    }

    #[test]
    fn matches_whole_buffer_decode_at_every_chunk_size() {
        let text = "名前,値\nあいうえお,1\n日本語のテキスト,2\nabc,3\n";
        let cases: Vec<(&str, Vec<u8>)> = vec![
            ("utf-8", text.as_bytes().to_vec()),
            (
                "shift_jis",
                encoding_rs::SHIFT_JIS.encode(text).0.into_owned(),
            ),
            ("euc-jp", encoding_rs::EUC_JP.encode(text).0.into_owned()),
            ("utf-16le", {
                let mut v = vec![0xff, 0xfe];
                v.extend(text.encode_utf16().flat_map(|u| u.to_le_bytes()));
                v
            }),
            // BOM 付き UTF-8 は BOM が取り除かれる。
            ("utf-8", {
                let mut v = vec![0xef, 0xbb, 0xbf];
                v.extend_from_slice(text.as_bytes());
                v
            }),
            // 不正な UTF-8 は置換文字になる (全体 decode と同じ)。
            ("utf-8", vec![b'a', 0xff, 0xfe, b'b', 0xe3, 0x81]),
        ];
        for (label, bytes) in cases {
            let want = reference(&bytes, label);
            for chunk in [1, 2, 3, 5, 7, 64, 1 << 16] {
                assert_eq!(
                    decode_all(&bytes, label, chunk),
                    want,
                    "{label} chunk={chunk}"
                );
            }
        }
    }

    #[test]
    fn unknown_label_falls_back_to_utf8() {
        assert_eq!(decode_all("héllo".as_bytes(), "no-such-enc", 4), "héllo");
    }

    #[test]
    fn empty_input_yields_nothing() {
        assert_eq!(decode_all(b"", "utf-8", 8), "");
    }
}
