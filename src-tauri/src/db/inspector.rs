//! ライブクエリ・インスペクタ (#746) のドライバ非依存ロジック (#1259 で JS から移管)。
//!
//! - [`normalize_sql_fingerprint`]: ライブテール用のリテラル非依存フィンガープリント。
//!   旧 `queryInspector.ts` の正規表現実装をそのまま手書きスキャナへ移したもので、
//!   `src/__tests__/fixtures/sqlFingerprintVectors.json` (旧 JS 実装を oracle に生成した
//!   ゴールデンベクタ) で出力の一致を固定する。正規表現クレートを増やさず、先読みや
//!   バックトラックの癖 (`'a'' from t` → `?' from t` など) も含めて再現している。
//! - [`InspectorState`]: セッションごとに baseline と直前スナップショットを保持して
//!   digest 差分 (calls > 0 の行) を返す。**サーバ側カウンタをリセットしない**設計
//!   (権限不要) は従来どおり — 累積値の引き算をクライアントではなくここで行うだけ。
//!   SQL 本文 (fingerprint) は digest の初出時のみ返し、以降は省く。

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::db::types::StatementStat;

// ── フィンガープリント正規化 ─────────────────────────────────────────────

/// JS の `\s` 相当 (正規表現・`trim()` が空白とみなす文字)。
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// JS の行終端文字 (`.` がマッチせず、複数行モードの `$` が手前でマッチする)。
fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// JS の `\w` (ASCII のみ)。
fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn boundary_before(s: &[char], i: usize) -> bool {
    // 直後が単語構成文字であることを呼び出し側が保証している前提: 直前が非単語なら境界。
    i == 0 || !is_word(s[i - 1])
}

fn boundary_after_word(s: &[char], end: usize) -> bool {
    // 直前 (end - 1) が単語構成文字であることを呼び出し側が保証している前提。
    end >= s.len() || !is_word(s[end])
}

/// `/\*[\s\S]*?\*\//g` → `" "`。
fn strip_block_comments(s: &[char]) -> Vec<char> {
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if s[i] == '/' && s.get(i + 1) == Some(&'*') {
            // 最短一致: 直後以降で最初の `*/`。
            let mut j = i + 2;
            let mut found = None;
            while j + 1 < s.len() {
                if s[j] == '*' && s[j + 1] == '/' {
                    found = Some(j + 2);
                    break;
                }
                j += 1;
            }
            if let Some(end) = found {
                out.push(' ');
                i = end;
                continue;
            }
        }
        out.push(s[i]);
        i += 1;
    }
    out
}

/// `/--(?=\s|$).*$/gm` → `" "` (`--` の直後が空白か行末のときだけ行末までをコメント扱い)。
fn strip_dash_comments(s: &[char]) -> Vec<char> {
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if s[i] == '-'
            && s.get(i + 1) == Some(&'-')
            && s.get(i + 2).map_or(true, |c| is_js_space(*c))
        {
            let mut j = i + 2;
            while j < s.len() && !is_line_terminator(s[j]) {
                j += 1;
            }
            out.push(' ');
            i = j;
            continue;
        }
        out.push(s[i]);
        i += 1;
    }
    out
}

/// `/#.*$/gm` → `" "`。
fn strip_hash_comments(s: &[char]) -> Vec<char> {
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if s[i] == '#' {
            let mut j = i + 1;
            while j < s.len() && !is_line_terminator(s[j]) {
                j += 1;
            }
            out.push(' ');
            i = j;
            continue;
        }
        out.push(s[i]);
        i += 1;
    }
    out
}

/// `q(?:[^q\\]|\\[\s\S]|qq)*q` の一致終端 (排他的) を返す。`start` は開きクォートの位置。
/// 貪欲に進み、閉じクォートに届かなければ最後の `qq` (二重化) の 1 文字目を閉じとして
/// バックトラックする — 正規表現の挙動と同じ。
fn match_quoted(s: &[char], start: usize, q: char) -> Option<usize> {
    let mut j = start + 1;
    let mut last_pair: Option<usize> = None;
    loop {
        match s.get(j) {
            None => break,
            Some(&c) if c == q => {
                if s.get(j + 1) == Some(&q) {
                    last_pair = Some(j);
                    j += 2;
                } else {
                    return Some(j + 1);
                }
            }
            Some('\\') => {
                if j + 1 < s.len() {
                    j += 2;
                } else {
                    break;
                }
            }
            Some(_) => j += 1,
        }
    }
    last_pair.map(|p| p + 1)
}

fn replace_quoted(s: &[char], q: char) -> Vec<char> {
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if s[i] == q {
            if let Some(end) = match_quoted(s, i, q) {
                out.push('?');
                i = end;
                continue;
            }
        }
        out.push(s[i]);
        i += 1;
    }
    out
}

/// `/\b0x[0-9a-fA-F]+\b/g` → `"?"`。
fn replace_hex_literals(s: &[char]) -> Vec<char> {
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if s[i] == '0' && matches!(s.get(i + 1), Some('x')) && boundary_before(s, i) {
            let mut j = i + 2;
            while j < s.len() && s[j].is_ascii_hexdigit() {
                j += 1;
            }
            if j > i + 2 && boundary_after_word(s, j) {
                out.push('?');
                i = j;
                continue;
            }
        }
        out.push(s[i]);
        i += 1;
    }
    out
}

/// `/\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g` → `"?"`。
fn replace_number_literals(s: &[char]) -> Vec<char> {
    let digits_end = |from: usize| {
        let mut j = from;
        while j < s.len() && s[j].is_ascii_digit() {
            j += 1;
        }
        j
    };
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if s[i].is_ascii_digit() && boundary_before(s, i) {
            let int_end = digits_end(i);
            // 小数部・指数部の有無を貪欲な順 (あり → なし) に試す。
            let frac_end = if s.get(int_end) == Some(&'.') {
                let e = digits_end(int_end + 1);
                (e > int_end + 1).then_some(e)
            } else {
                None
            };
            let exp_end_from = |from: usize| {
                if matches!(s.get(from), Some('e' | 'E')) {
                    let mut k = from + 1;
                    if matches!(s.get(k), Some('+' | '-')) {
                        k += 1;
                    }
                    let e = digits_end(k);
                    (e > k).then_some(e)
                } else {
                    None
                }
            };
            let mut candidates: Vec<usize> = Vec::with_capacity(4);
            if let Some(fe) = frac_end {
                if let Some(ee) = exp_end_from(fe) {
                    candidates.push(ee);
                }
                candidates.push(fe);
            }
            if let Some(ee) = exp_end_from(int_end) {
                candidates.push(ee);
            }
            candidates.push(int_end);
            if let Some(end) = candidates.into_iter().find(|e| boundary_after_word(s, *e)) {
                out.push('?');
                i = end;
                continue;
            }
        }
        out.push(s[i]);
        i += 1;
    }
    out
}

fn skip_spaces(s: &[char], mut i: usize) -> usize {
    while i < s.len() && is_js_space(s[i]) {
        i += 1;
    }
    i
}

/// `\(\s*\?(?:\s*,\s*\?)*\s*\)` の一致終端 (排他的)。`i` は `(` の位置。
fn match_placeholder_tuple(s: &[char], i: usize) -> Option<usize> {
    if s.get(i) != Some(&'(') {
        return None;
    }
    let mut j = skip_spaces(s, i + 1);
    if s.get(j) != Some(&'?') {
        return None;
    }
    j += 1;
    loop {
        let k = skip_spaces(s, j);
        if s.get(k) == Some(&',') {
            let m = skip_spaces(s, k + 1);
            if s.get(m) == Some(&'?') {
                j = m + 1;
                continue;
            }
        }
        break;
    }
    let j = skip_spaces(s, j);
    (s.get(j) == Some(&')')).then_some(j + 1)
}

fn starts_with_at(s: &[char], i: usize, word: &str) -> bool {
    word.chars()
        .enumerate()
        .all(|(k, c)| s.get(i + k) == Some(&c))
}

/// `/\bin\s*\(\s*\?(?:\s*,\s*\?)*\s*\)/g` → `"in (?)"`。
fn collapse_in_lists(s: &[char]) -> Vec<char> {
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if starts_with_at(s, i, "in") && boundary_before(s, i) {
            let p = skip_spaces(s, i + 2);
            if let Some(end) = match_placeholder_tuple(s, p) {
                out.extend("in (?)".chars());
                i = end;
                continue;
            }
        }
        out.push(s[i]);
        i += 1;
    }
    out
}

/// `/\bvalues\s*(TUPLE)(?:\s*,\s*TUPLE)+/g` → `"values $1"`。
fn collapse_values_rows(s: &[char]) -> Vec<char> {
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if starts_with_at(s, i, "values") && boundary_before(s, i) {
            let p = skip_spaces(s, i + 6);
            if let Some(first_end) = match_placeholder_tuple(s, p) {
                let mut end = first_end;
                let mut reps = 0;
                loop {
                    let k = skip_spaces(s, end);
                    if s.get(k) != Some(&',') {
                        break;
                    }
                    let m = skip_spaces(s, k + 1);
                    match match_placeholder_tuple(s, m) {
                        Some(e) => {
                            end = e;
                            reps += 1;
                        }
                        None => break,
                    }
                }
                if reps > 0 {
                    out.extend("values ".chars());
                    out.extend(s[p..first_end].iter());
                    i = end;
                    continue;
                }
            }
        }
        out.push(s[i]);
        i += 1;
    }
    out
}

/// SQL テキストをリテラル非依存の同型クエリ (`where id = ?`) へ正規化する。
/// ライブテール (生 SQL しか無い) の N+1 グルーピング用で、digest 集計はサーバ側の
/// 正規化 (MySQL DIGEST / PG queryid) をそのまま使うため通さない。
///
/// pt-fingerprint と同趣旨の保守的ルール:
/// - コメント (`--` 行 / `#` 行 / ブロック) を除去
/// - 文字列リテラル (`'...'` と `"..."`。`''` / `\'` エスケープ対応) を `?` に置換
/// - 数値リテラル (16 進・小数・指数) を `?` に置換
/// - 空白を畳んで小文字化
/// - `IN (?, ?, ...)` と `VALUES (?, ...), (?, ...)` の繰り返しを 1 要素へ畳む
pub fn normalize_sql_fingerprint(sql: &str) -> String {
    let s: Vec<char> = sql.chars().collect();
    let s = strip_block_comments(&s);
    let s = strip_dash_comments(&s);
    let s = strip_hash_comments(&s);
    let s = replace_quoted(&s, '\'');
    let s = replace_quoted(&s, '"');
    let s = replace_hex_literals(&s);
    let s = replace_number_literals(&s);
    // 空白を畳んで小文字化してから、繰り返しリストを構造的に畳む。
    let joined = s
        .into_iter()
        .collect::<String>()
        .split(is_js_space)
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    let s: Vec<char> = joined.chars().collect();
    let s = collapse_in_lists(&s);
    let s = collapse_values_rows(&s);
    s.into_iter()
        .collect::<String>()
        .trim_matches(is_js_space)
        .to_string()
}

// ── N+1 目安 (digest 差分のレート換算) ───────────────────────────────────

/// N+1 判定の閾値 (フロントの設定と同じ意味)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NPlusOneOptions {
    /// 時間窓内でこの回数以上同型クエリが観測されたらフラグする。
    pub min_count: u32,
    /// 「1 リクエスト相当」とみなす時間窓 ms。
    pub window_ms: u32,
}

impl NPlusOneOptions {
    /// 閾値を安全な範囲に丸める (UI の自由入力からの防御。フロントの
    /// `sanitizeNPlusOneOptions` と同じ下限)。
    pub fn sanitized(min_count: u32, window_ms: u32) -> Self {
        NPlusOneOptions {
            min_count: min_count.max(2),
            window_ms: window_ms.max(100),
        }
    }
}

/// digest 差分ベースの N+1 目安: 直近ポーリング間隔での実行回数を時間窓あたりの
/// レートに換算して閾値と比べる。
pub fn n_plus_one_from_rate(calls_delta: i64, elapsed_ms: f64, opts: NPlusOneOptions) -> bool {
    if elapsed_ms.is_nan() || elapsed_ms <= 0.0 || calls_delta <= 0 {
        return false;
    }
    (calls_delta as f64 / elapsed_ms) * f64::from(opts.window_ms) >= f64::from(opts.min_count)
}

// ── スナップショット差分集計 ─────────────────────────────────────────────

/// 差分集計後のランキング 1 行 (内部表現。SQL 本文は持たない)。
#[derive(Debug, Clone, PartialEq)]
pub struct StatDelta {
    pub digest: String,
    pub database: Option<String>,
    pub calls: i64,
    pub total_time_ms: f64,
    pub mean_time_ms: f64,
    /// 最悪レイテンシ ms。高水位マークのため**累積値** (差分不能) な点に注意。
    pub max_time_ms: f64,
    pub rows: Option<i64>,
}

fn stat_key(digest: &str, database: Option<&str>) -> String {
    // 同じ digest が DB 違いで並ぶことがある (MySQL SCHEMA_NAME / PG dbid)。
    format!("{digest} {}", database.unwrap_or(""))
}

fn index_snapshot(stats: &[StatementStat]) -> HashMap<String, StatementStat> {
    stats
        .iter()
        .map(|s| (stat_key(&s.digest, s.database.as_deref()), s.clone()))
        .collect()
}

/// 「baseline からの差分」集計。`baseline` と `current` の累積カウンタを digest 単位で
/// 引き算し、差分内に実行があった行だけを総時間の降順で返す。
///
/// - baseline に無い digest は初出として全量を差分とみなす。
/// - カウンタが逆行している digest (サーバ側で統計リセット/エビクション) は baseline を
///   0 とみなして current の全量を採用する。
/// - `max_time_ms` は高水位マークで差分不能のため常に current の累積値。
pub fn compute_stat_delta(
    baseline: &HashMap<String, StatementStat>,
    current: &[StatementStat],
) -> Vec<StatDelta> {
    let mut out = Vec::new();
    for cur in current {
        let prev = baseline.get(&stat_key(&cur.digest, cur.database.as_deref()));
        let reset = prev.is_some_and(|p| cur.calls < p.calls);
        let from = if reset { None } else { prev };
        let calls = cur.calls - from.map_or(0, |p| p.calls);
        if calls <= 0 {
            continue;
        }
        let total_time_ms = (cur.total_time_ms - from.map_or(0.0, |p| p.total_time_ms)).max(0.0);
        let rows = cur
            .rows
            .map(|r| (r - from.and_then(|p| p.rows).unwrap_or(0)).max(0));
        out.push(StatDelta {
            digest: cur.digest.clone(),
            database: cur.database.clone(),
            calls,
            total_time_ms,
            mean_time_ms: total_time_ms / calls as f64,
            max_time_ms: cur.max_time_ms,
            rows,
        });
    }
    out.sort_by(|a, b| b.total_time_ms.total_cmp(&a.total_time_ms));
    out
}

/// IPC で返す差分 1 行。SQL 本文 (`fingerprint`) は digest の初出時だけ載り、以降は
/// `None` (フロントが digest キーでキャッシュする)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StatementDeltaRow {
    pub digest: String,
    pub fingerprint: Option<String>,
    pub database: Option<String>,
    pub calls: i64,
    pub total_time_ms: f64,
    pub mean_time_ms: f64,
    pub max_time_ms: f64,
    pub rows: Option<i64>,
    /// 直近のポーリング間隔の実行レートが N+1 目安を超えた (`n_plus_one_from_rate`)。
    pub n_plus_one: bool,
}

/// セッションごとのインスペクタ状態 (`Session::inspector`)。`Session` のフィールド
/// なので切断・再接続 (新しい `Session` への差し替え) で自動的に破棄される。保持するのは
/// baseline / 直前 / 最新の各スナップショット (`statement_stats` の上限 500 行) と
/// 送信済み digest の集合だけで、記録の開始 (`start`) のたびに作り直す。
#[derive(Default)]
pub struct InspectorState {
    baseline: Option<HashMap<String, StatementStat>>,
    prev: Option<(HashMap<String, StatementStat>, Instant)>,
    current: Vec<StatementStat>,
    /// 本文 (fingerprint) をクライアントへ送信済みの digest キー。
    sent: HashSet<String>,
    flagged: HashSet<String>,
}

impl InspectorState {
    pub fn has_baseline(&self) -> bool {
        self.baseline.is_some()
    }

    /// 記録開始: スナップショットを baseline / 直前 / 最新にし、送信済み集合を空にする。
    pub fn start(&mut self, snapshot: Vec<StatementStat>, now: Instant) {
        let indexed = index_snapshot(&snapshot);
        self.prev = Some((indexed.clone(), now));
        self.baseline = Some(indexed);
        self.current = snapshot;
        self.sent.clear();
        self.flagged.clear();
    }

    /// 新しいスナップショットを取り込み、直前との差分レートから N+1 目安を更新する。
    pub fn ingest(&mut self, snapshot: Vec<StatementStat>, now: Instant, opts: NPlusOneOptions) {
        if let Some((prev, at)) = &self.prev {
            if now > *at {
                let elapsed_ms = now.duration_since(*at).as_secs_f64() * 1000.0;
                self.flagged = compute_stat_delta(prev, &snapshot)
                    .into_iter()
                    .filter(|r| n_plus_one_from_rate(r.calls, elapsed_ms, opts))
                    .map(|r| stat_key(&r.digest, r.database.as_deref()))
                    .collect();
            }
        }
        self.prev = Some((index_snapshot(&snapshot), now));
        self.current = snapshot;
    }

    /// 最新スナップショットの差分行を返す。`cumulative` なら baseline を無視して累積値
    /// (サーバのカウンタそのまま) を返す。本文は初出の digest にだけ載せて送信済みにする。
    pub fn rows(&mut self, cumulative: bool) -> Vec<StatementDeltaRow> {
        let empty = HashMap::new();
        let base = if cumulative {
            &empty
        } else {
            self.baseline.as_ref().unwrap_or(&empty)
        };
        let deltas = compute_stat_delta(base, &self.current);
        let bodies: HashMap<String, &StatementStat> = self
            .current
            .iter()
            .map(|s| (stat_key(&s.digest, s.database.as_deref()), s))
            .collect();
        let mut out = Vec::with_capacity(deltas.len());
        for d in deltas {
            let key = stat_key(&d.digest, d.database.as_deref());
            let fingerprint = if self.sent.contains(&key) {
                None
            } else {
                self.sent.insert(key.clone());
                bodies.get(&key).map(|s| s.fingerprint.clone())
            };
            let n_plus_one = self.flagged.contains(&key);
            out.push(StatementDeltaRow {
                digest: d.digest,
                fingerprint,
                database: d.database,
                calls: d.calls,
                total_time_ms: d.total_time_ms,
                mean_time_ms: d.mean_time_ms,
                max_time_ms: d.max_time_ms,
                rows: d.rows,
                n_plus_one,
            });
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[derive(Deserialize)]
    struct Vector {
        input: String,
        expected: String,
    }
    #[derive(Deserialize)]
    struct Vectors {
        vectors: Vec<Vector>,
    }

    /// 旧 JS 実装 (`queryInspector.ts` の `normalizeSqlFingerprint`) を oracle に生成した
    /// ゴールデンベクタとの一致。
    #[test]
    fn fingerprint_matches_golden_vectors() {
        let raw = include_str!("../../../src/__tests__/fixtures/sqlFingerprintVectors.json");
        let parsed: Vectors = serde_json::from_str(raw).expect("vectors json");
        assert!(parsed.vectors.len() > 40);
        for v in parsed.vectors {
            assert_eq!(
                normalize_sql_fingerprint(&v.input),
                v.expected,
                "input: {:?}",
                v.input
            );
        }
    }

    fn stat(digest: &str, database: Option<&str>, calls: i64, total: f64) -> StatementStat {
        StatementStat {
            digest: digest.into(),
            fingerprint: format!("select {digest}"),
            database: database.map(str::to_string),
            calls,
            total_time_ms: total,
            max_time_ms: 0.0,
            rows: None,
        }
    }

    fn delta(base: &[StatementStat], cur: &[StatementStat]) -> Vec<StatDelta> {
        compute_stat_delta(&index_snapshot(base), cur)
    }

    #[test]
    fn delta_subtracts_baseline_and_sorts_by_total_time_desc() {
        let mut a0 = stat("a", Some("app"), 10, 100.0);
        a0.rows = Some(50);
        let baseline = vec![a0, stat("b", Some("app"), 5, 500.0)];
        let mut a1 = stat("a", Some("app"), 14, 140.0);
        a1.max_time_ms = 30.0;
        a1.rows = Some(70);
        let mut b1 = stat("b", Some("app"), 6, 900.0);
        b1.max_time_ms = 400.0;
        let rows = delta(&baseline, &[a1, b1]);
        assert_eq!(
            rows.iter().map(|r| r.digest.as_str()).collect::<Vec<_>>(),
            ["b", "a"]
        );
        let a = &rows[1];
        assert_eq!(
            (a.calls, a.total_time_ms, a.mean_time_ms, a.rows),
            (4, 40.0, 10.0, Some(20))
        );
        // max は高水位マークなので累積値のまま。
        assert_eq!(a.max_time_ms, 30.0);
    }

    #[test]
    fn delta_skips_zero_new_digests_reset_and_database_split() {
        let s = stat("a", None, 10, 100.0);
        assert!(delta(std::slice::from_ref(&s), std::slice::from_ref(&s)).is_empty());
        // 初出は全量。
        let rows = delta(&[], &[stat("new", None, 3, 30.0)]);
        assert_eq!(
            (rows[0].calls, rows[0].total_time_ms, rows[0].mean_time_ms),
            (3, 30.0, 10.0)
        );
        // カウンタ逆行は baseline を 0 とみなす。
        let mut base = stat("a", None, 100, 1000.0);
        base.rows = Some(10);
        let mut cur = stat("a", None, 4, 40.0);
        cur.rows = Some(2);
        let rows = delta(&[base], &[cur]);
        assert_eq!(
            (rows[0].calls, rows[0].total_time_ms, rows[0].rows),
            (4, 40.0, Some(2))
        );
        // database が違えば別行。
        let rows = delta(
            &[stat("a", Some("db1"), 5, 10.0)],
            &[
                stat("a", Some("db1"), 6, 20.0),
                stat("a", Some("db2"), 3, 30.0),
            ],
        );
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows.iter()
                .find(|r| r.database.as_deref() == Some("db1"))
                .map(|r| r.calls),
            Some(1)
        );
        assert_eq!(
            rows.iter()
                .find(|r| r.database.as_deref() == Some("db2"))
                .map(|r| r.calls),
            Some(3)
        );
        // rows が null のエンジンは null を維持する。
        assert_eq!(delta(&[], &[stat("a", None, 1, 1.0)])[0].rows, None);
    }

    #[test]
    fn n_plus_one_options_are_sanitized_and_rate_is_thresholded() {
        assert_eq!(
            NPlusOneOptions::sanitized(0, 1),
            NPlusOneOptions {
                min_count: 2,
                window_ms: 100
            }
        );
        let o = NPlusOneOptions {
            min_count: 10,
            window_ms: 2000,
        };
        // 5 秒で 50 回 → 2 秒窓あたり 20 回 >= 10。
        assert!(n_plus_one_from_rate(50, 5000.0, o));
        // 5 秒で 10 回 → 2 秒窓あたり 4 回 < 10。
        assert!(!n_plus_one_from_rate(10, 5000.0, o));
        assert!(!n_plus_one_from_rate(0, 5000.0, o));
        assert!(!n_plus_one_from_rate(50, 0.0, o));
    }

    #[test]
    fn state_returns_bodies_once_and_flags_recent_rate() {
        let opts = NPlusOneOptions {
            min_count: 10,
            window_ms: 2000,
        };
        let t0 = Instant::now();
        let mut st = InspectorState::default();
        assert!(!st.has_baseline());
        st.start(
            vec![stat("a", None, 10, 100.0), stat("b", None, 1, 1.0)],
            t0,
        );
        assert!(st.has_baseline());
        assert!(st.rows(false).is_empty());

        // 5 秒後: a が 60 回増える (2 秒窓あたり 24 回 >= 10 → N+1 目安)、b は 1 回。
        let t1 = t0 + Duration::from_secs(5);
        st.ingest(
            vec![stat("a", None, 70, 700.0), stat("b", None, 2, 2.0)],
            t1,
            opts,
        );
        let rows = st.rows(false);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].digest, "a");
        assert_eq!(rows[0].calls, 60);
        assert!(rows[0].n_plus_one);
        assert!(!rows[1].n_plus_one);
        // 初出は本文あり。
        assert_eq!(rows[0].fingerprint.as_deref(), Some("select a"));
        assert_eq!(rows[1].fingerprint.as_deref(), Some("select b"));

        // 2 回目以降は本文を送らない。累積モード (baseline 無視) でも送信済みは省く。
        let again = st.rows(false);
        assert!(again.iter().all(|r| r.fingerprint.is_none()));
        let cumulative = st.rows(true);
        assert_eq!(
            cumulative.iter().find(|r| r.digest == "a").map(|r| r.calls),
            Some(70)
        );
        assert!(cumulative.iter().all(|r| r.fingerprint.is_none()));

        // baseline に無かった digest が累積モードで初めて現れたら、そのとき本文を載せる。
        let t2 = t1 + Duration::from_secs(5);
        st.ingest(
            vec![
                stat("a", None, 71, 710.0),
                stat("b", None, 2, 2.0),
                stat("c", None, 0, 0.0),
            ],
            t2,
            opts,
        );
        assert!(st.rows(false).iter().all(|r| r.digest != "c"));

        // 記録の再開始で送信済みはリセットされ、本文がまた載る。
        st.start(vec![stat("a", None, 71, 710.0)], t2);
        st.ingest(
            vec![stat("a", None, 72, 720.0)],
            t2 + Duration::from_secs(1),
            opts,
        );
        assert_eq!(st.rows(false)[0].fingerprint.as_deref(), Some("select a"));
    }
}
