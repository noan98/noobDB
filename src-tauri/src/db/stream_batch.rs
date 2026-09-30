//! ストリーミング結果の「バッチ合流」と「逐次統計」(#1257)。
//!
//! 3 ドライバの `execute_stream` は固定サイズ (既定 200 行) のバッチごとに
//! `on_batch` を呼ぶ。そのまま IPC `Channel` へ送ると、100 万行の結果では 5,000 回の
//! メッセージ・フロントの state 更新・`ResultGrid` の全行メモ再計算が走る。
//! ここではドライバ非依存 (= `StreamBatch::Rows` を受けるだけ) に次の 2 つを提供する。
//!
//! - [`StreamBatcher`]: 初回バッチは即送信 (最初の行が出るまでの時間を悪化させない)
//!   しつつ、以降は「前回送信から一定時間経過」か「溜まった行数がサイズ上限に到達」の
//!   どちらかで合流して送る。サイズ上限は送信のたびに倍々で伸びる。
//! - [`StreamStats`]: 列ごとの NULL 数・数値列 min/max・行ハッシュ重複フラグを
//!   バッチごとに逐次更新する。フロントは全行を舐め直さずに済む。数値判定は
//!   `cellConditionalFormat.toNumber` (JS の `Number()`) と同じ基準
//!   (`src/__tests__/fixtures/streamStatsVectors.json` で固定)。

use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::types::Value;

/// 合流バッチの最大行数 (倍々で伸びる上限)。
pub const MAX_COALESCED_ROWS: usize = 10_000;
/// 前回送信からこの時間が経過したら、溜まった分を即送る。
pub const COALESCE_INTERVAL: Duration = Duration::from_millis(75);
/// 行ハッシュ重複検出を行う最大行数。超えたら「不明」(`None`) に落とす
/// (ハッシュ集合が無制限にメモリを食わないように)。
pub const DUP_TRACK_LIMIT: usize = 1_000_000;

/// 時間基準 + サイズ倍々のバッチ合流器。
#[derive(Debug)]
pub struct StreamBatcher {
    pending: Vec<Vec<Value>>,
    last_sent: Option<Instant>,
    cap: usize,
    max_cap: usize,
    interval: Duration,
}

impl StreamBatcher {
    /// `chunk` はドライバが 1 回に渡すバッチ行数 (合流サイズ上限の初期値の基準)。
    pub fn new(chunk: usize) -> Self {
        Self::with_limits(chunk, MAX_COALESCED_ROWS, COALESCE_INTERVAL)
    }

    pub fn with_limits(chunk: usize, max_cap: usize, interval: Duration) -> Self {
        let chunk = chunk.max(1);
        Self {
            pending: Vec::new(),
            last_sent: None,
            cap: (chunk * 2).min(max_cap.max(1)),
            max_cap: max_cap.max(1),
            interval,
        }
    }

    /// ドライバからのバッチを受け取る。いま送るべき合流済みバッチがあれば返す。
    /// 最初の呼び出しは必ずそのまま返す (初回バッチは合流させない)。
    pub fn push(&mut self, mut rows: Vec<Vec<Value>>, now: Instant) -> Option<Vec<Vec<Value>>> {
        if rows.is_empty() {
            return None;
        }
        if self.last_sent.is_none() {
            self.last_sent = Some(now);
            return Some(rows);
        }
        if self.pending.is_empty() {
            self.pending = std::mem::take(&mut rows);
        } else {
            self.pending.append(&mut rows);
        }
        let due = self
            .last_sent
            .is_some_and(|t| now.saturating_duration_since(t) >= self.interval);
        if due || self.pending.len() >= self.cap {
            self.last_sent = Some(now);
            self.cap = (self.cap.saturating_mul(2)).min(self.max_cap);
            return Some(std::mem::take(&mut self.pending));
        }
        None
    }

    /// ストリーム終了 (正常・エラー・タイムアウト) 時に残りを吐き出す。
    pub fn finish(&mut self) -> Option<Vec<Vec<Value>>> {
        if self.pending.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.pending))
        }
    }
}

/// フロントへ送る逐次統計のスナップショット (累積)。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamStatsSnapshot {
    /// これまでに観測した総行数。フロントは `rows.length` と一致するときだけ採用する。
    pub row_count: u64,
    /// 列ごとの NULL 数。
    pub null_counts: Vec<u64>,
    /// 列ごとの数値最小 (数値化できる値が無ければ `null`)。
    pub num_min: Vec<Option<f64>>,
    /// 列ごとの数値最大。
    pub num_max: Vec<Option<f64>>,
    /// 全列が同一の行が 2 行以上あるか。追跡上限を超えたら `null` (不明)。
    pub duplicate_rows: Option<bool>,
}

#[derive(Debug, Default)]
pub struct StreamStats {
    row_count: u64,
    null_counts: Vec<u64>,
    num_min: Vec<Option<f64>>,
    num_max: Vec<Option<f64>>,
    seen: HashSet<u128>,
    duplicate: bool,
    dup_overflow: bool,
}

impl StreamStats {
    pub fn new() -> Self {
        Self::default()
    }

    fn ensure_width(&mut self, width: usize) {
        if self.null_counts.len() < width {
            self.null_counts.resize(width, 0);
            self.num_min.resize(width, None);
            self.num_max.resize(width, None);
        }
    }

    pub fn observe(&mut self, rows: &[Vec<Value>]) {
        for row in rows {
            self.ensure_width(row.len());
            for (i, v) in row.iter().enumerate() {
                match v {
                    Value::Null => self.null_counts[i] += 1,
                    // serde_json は非有限の浮動小数を null にする (= JS 側では null)。
                    Value::Float(f) if !f.is_finite() => self.null_counts[i] += 1,
                    other => {
                        if let Some(n) = value_to_number(other) {
                            let lo = &mut self.num_min[i];
                            if lo.map_or(true, |m| n < m) {
                                *lo = Some(n);
                            }
                            let hi = &mut self.num_max[i];
                            if hi.map_or(true, |m| n > m) {
                                *hi = Some(n);
                            }
                        }
                    }
                }
            }
            self.row_count += 1;
            if !self.duplicate && !self.dup_overflow {
                if self.seen.len() >= DUP_TRACK_LIMIT {
                    self.dup_overflow = true;
                    self.seen = HashSet::new();
                } else if !self.seen.insert(hash_values(row.iter())) {
                    self.duplicate = true;
                    self.seen = HashSet::new();
                }
            }
        }
    }

    pub fn snapshot(&self) -> StreamStatsSnapshot {
        StreamStatsSnapshot {
            row_count: self.row_count,
            null_counts: self.null_counts.clone(),
            num_min: self.num_min.clone(),
            num_max: self.num_max.clone(),
            duplicate_rows: if self.duplicate {
                Some(true)
            } else if self.dup_overflow {
                None
            } else {
                Some(false)
            },
        }
    }
}

/// `cellConditionalFormat.toNumber` と同じ基準でセル値を数値へ寄せる。
/// 数値型はそのまま (非有限は対象外)、文字列は JS の `Number(trimmed)`、
/// 真偽値・NULL は対象外。
pub(crate) fn value_to_number(v: &Value) -> Option<f64> {
    match v {
        Value::Int(i) => Some(*i as f64),
        Value::UInt(u) => Some(*u as f64),
        Value::Float(f) => f.is_finite().then_some(*f),
        Value::String(s) | Value::Bytes(s) => js_number(s),
        Value::Bool(_) | Value::Null => None,
    }
}

pub(crate) fn is_js_whitespace(c: char) -> bool {
    // ECMAScript の WhiteSpace + LineTerminator。Rust の `char::is_whitespace` とは
    // BOM (U+FEFF) の扱いが異なるので自前で定義する。
    matches!(
        c,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// JS `Number(str.trim())` 相当 (有限値のみ `Some`)。空文字は対象外。
pub fn js_number(s: &str) -> Option<f64> {
    let t = s.trim_matches(is_js_whitespace);
    let first = t.chars().next()?;
    // 数値になりうる先頭文字だけ通す (長い非数値文字列の解析を避ける高速パス)。
    if !(first.is_ascii_digit() || matches!(first, '+' | '-' | '.')) {
        return None;
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
                let d = c.to_digit(radix)?;
                acc = acc * f64::from(radix) + f64::from(d);
            }
            return acc.is_finite().then_some(acc);
        }
    }
    // Rust の f64 パーサは JS の StrDecimalLiteral と「inf / nan / infinity」
    // (先頭文字フィルタで除外済み) 以外ほぼ同じ文法。"5." や ".5" も両方 OK。
    let n: f64 = t.parse().ok()?;
    n.is_finite().then_some(n)
}

/// 値の列を 128bit にハッシュする (2 本の SipHash を別シードで回す)。行全体 (重複
/// 行検出) と主キー列だけ (自動リフレッシュ差分 `refresh_diff`) の両方で使う。
/// `rowEditKey` と同じ等価性を持つ: 型タグで数値 1 / 文字列 "1" / 真偽値 / NULL を
/// 区別し、Int(1) と Float(1.0) は同一視する (JS では両方 `1`)。
pub(crate) fn hash_values<'a>(values: impl Iterator<Item = &'a Value>) -> u128 {
    let mut a = FastHasher::new(0x9E37_79B9_7F4A_7C15);
    let mut b = FastHasher::new(0xC2B2_AE3D_27D4_EB4F);
    for v in values {
        hash_value(v, &mut a);
        hash_value(v, &mut b);
    }
    (u128::from(a.finish()) << 64) | u128::from(b.finish())
}

/// 行ごとに大量に回すための軽量ハッシャ (FxHash 系の積み上げ + 仕上げに splitmix64)。
/// SipHash より数倍速く、2 本を別シードで回して 128bit にすれば衝突は実用上無視できる。
/// HashDoS 耐性は不要 (キーはサーバから来た自分のデータで、結果は警告表示・差分の
/// 最適化にしか使わない)。
struct FastHasher {
    state: u64,
}

impl FastHasher {
    const K: u64 = 0x517C_C1B7_2722_0A95;

    fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    #[inline]
    fn add(&mut self, word: u64) {
        self.state = (self.state.rotate_left(5) ^ word).wrapping_mul(Self::K);
    }
}

impl Hasher for FastHasher {
    fn write(&mut self, bytes: &[u8]) {
        let mut chunks = bytes.chunks_exact(8);
        for c in &mut chunks {
            let mut w = [0u8; 8];
            w.copy_from_slice(c);
            self.add(u64::from_le_bytes(w));
        }
        let rest = chunks.remainder();
        if !rest.is_empty() {
            let mut w = [0u8; 8];
            w[..rest.len()].copy_from_slice(rest);
            self.add(u64::from_le_bytes(w) ^ ((rest.len() as u64) << 56));
        }
    }

    fn write_u8(&mut self, i: u8) {
        self.add(u64::from(i));
    }

    fn write_u64(&mut self, i: u64) {
        self.add(i);
    }

    fn write_usize(&mut self, i: usize) {
        self.add(i as u64);
    }

    fn finish(&self) -> u64 {
        // splitmix64 の仕上げで下位/上位ビットを攪拌する。
        let mut z = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
}

fn hash_value<H: Hasher>(v: &Value, h: &mut H) {
    match v {
        Value::Null => 0u8.hash(h),
        Value::Float(f) if !f.is_finite() => 0u8.hash(h),
        Value::Bool(b) => {
            1u8.hash(h);
            b.hash(h);
        }
        Value::Int(i) => hash_number(*i as f64, h),
        Value::UInt(u) => hash_number(*u as f64, h),
        Value::Float(f) => hash_number(*f, h),
        Value::String(s) | Value::Bytes(s) => {
            3u8.hash(h);
            s.len().hash(h);
            s.hash(h);
        }
    }
}

fn hash_number<H: Hasher>(n: f64, h: &mut H) {
    2u8.hash(h);
    // -0 は JS の String(-0) が "0" なので 0 と同一視する。
    let n = if n == 0.0 { 0.0 } else { n };
    n.to_bits().hash(h);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(n: i64) -> Vec<Vec<Value>> {
        (0..n).map(|i| vec![Value::Int(i)]).collect()
    }

    #[test]
    fn first_batch_is_sent_immediately() {
        let mut b = StreamBatcher::with_limits(200, 10_000, Duration::from_millis(75));
        let t0 = Instant::now();
        let out = b.push(r(200), t0).expect("初回は即送信");
        assert_eq!(out.len(), 200);
    }

    #[test]
    fn small_batches_are_merged_until_size_cap() {
        let mut b = StreamBatcher::with_limits(200, 10_000, Duration::from_secs(3600));
        let t0 = Instant::now();
        assert!(b.push(r(200), t0).is_some());
        // cap は 400。2 回目 (200) は溜まるだけ、3 回目 (400) で送出。
        assert!(b.push(r(200), t0).is_none());
        let out = b.push(r(200), t0).expect("サイズ上限で送出");
        assert_eq!(out.len(), 400);
        // cap は 800 に倍増。
        assert!(b.push(r(200), t0).is_none());
        assert!(b.push(r(200), t0).is_none());
        assert!(b.push(r(200), t0).is_none());
        assert_eq!(b.push(r(200), t0).map(|o| o.len()), Some(800));
    }

    #[test]
    fn cap_is_bounded_by_max() {
        let mut b = StreamBatcher::with_limits(200, 500, Duration::from_secs(3600));
        let t0 = Instant::now();
        b.push(r(200), t0);
        assert!(b.push(r(200), t0).is_none());
        assert_eq!(b.push(r(200), t0).map(|o| o.len()), Some(400));
        // 以降の上限は 500 で頭打ち。
        assert!(b.push(r(200), t0).is_none());
        assert_eq!(b.push(r(400), t0).map(|o| o.len()), Some(600));
    }

    #[test]
    fn time_based_flush() {
        let mut b = StreamBatcher::with_limits(200, 10_000, Duration::from_millis(75));
        let t0 = Instant::now();
        assert!(b.push(r(200), t0).is_some());
        assert!(b.push(r(200), t0 + Duration::from_millis(10)).is_none());
        let out = b
            .push(r(200), t0 + Duration::from_millis(80))
            .expect("時間経過で送出");
        assert_eq!(out.len(), 400);
    }

    #[test]
    fn finish_flushes_remainder_once() {
        let mut b = StreamBatcher::with_limits(200, 10_000, Duration::from_secs(3600));
        let t0 = Instant::now();
        b.push(r(200), t0);
        assert!(b.push(r(50), t0).is_none());
        assert_eq!(b.finish().map(|o| o.len()), Some(50));
        assert!(b.finish().is_none());
    }

    #[test]
    fn empty_batches_are_ignored() {
        let mut b = StreamBatcher::new(200);
        assert!(b.push(Vec::new(), Instant::now()).is_none());
        // 空バッチは「初回」を消費しない。
        assert!(b.push(r(1), Instant::now()).is_some());
    }

    #[test]
    fn js_number_matches_to_number_vectors() {
        let raw = include_str!("../../../src/__tests__/fixtures/streamStatsVectors.json");
        let v: serde_json::Value = serde_json::from_str(raw).expect("vectors parse");
        for case in v["toNumber"].as_array().expect("toNumber array") {
            let input = &case["input"];
            let expected = case["expected"].as_f64();
            let got = match input {
                serde_json::Value::String(s) => js_number(s),
                serde_json::Value::Number(n) => {
                    let f = n.as_f64().expect("f64");
                    value_to_number(&Value::Float(f))
                }
                serde_json::Value::Bool(_) | serde_json::Value::Null => None,
                _ => panic!("unsupported input"),
            };
            assert_eq!(got, expected, "input = {input}");
        }
    }

    #[test]
    fn stats_counts_nulls_minmax_and_duplicates() {
        let mut s = StreamStats::new();
        s.observe(&[
            vec![Value::Int(3), Value::String("a".into()), Value::Null],
            vec![Value::String("1.5".into()), Value::Null, Value::Bool(true)],
        ]);
        s.observe(&[vec![
            Value::Float(-2.0),
            Value::String("b".into()),
            Value::Null,
        ]]);
        let snap = s.snapshot();
        assert_eq!(snap.row_count, 3);
        assert_eq!(snap.null_counts, vec![0, 1, 2]);
        assert_eq!(snap.num_min, vec![Some(-2.0), None, None]);
        assert_eq!(snap.num_max, vec![Some(3.0), None, None]);
        assert_eq!(snap.duplicate_rows, Some(false));
    }

    #[test]
    fn duplicate_detection_uses_type_domains() {
        let mut s = StreamStats::new();
        // 数値 1 / 文字列 "1" / 真偽値 true / NULL はすべて別物。
        s.observe(&[
            vec![Value::Int(1)],
            vec![Value::String("1".into())],
            vec![Value::Bool(true)],
            vec![Value::Null],
        ]);
        assert_eq!(s.snapshot().duplicate_rows, Some(false));
        // Int(1) と Float(1.0) は JS 上で同じ値。
        s.observe(&[vec![Value::Float(1.0)]]);
        assert_eq!(s.snapshot().duplicate_rows, Some(true));
    }

    #[test]
    fn duplicate_detection_spans_batches() {
        let mut s = StreamStats::new();
        s.observe(&[vec![Value::Int(1), Value::String("x".into())]]);
        s.observe(&[vec![Value::Int(1), Value::String("x".into())]]);
        assert_eq!(s.snapshot().duplicate_rows, Some(true));
    }

    #[test]
    fn empty_stats_snapshot() {
        let snap = StreamStats::new().snapshot();
        assert_eq!(snap.row_count, 0);
        assert!(snap.null_counts.is_empty());
        assert_eq!(snap.duplicate_rows, Some(false));
    }
}
