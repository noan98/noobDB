//! 結果ハンドル (`result_store`) に保持した行へのソート・フィルタ・検索・列統計 (#1264)。
//!
//! フロントの `ResultGrid.tsx` (`sortNumeric` / `sortBool` / `sortString` /
//! `columnFilter` / `globalIncludesFilter`) と `gridFind.ts` / `gridStats.ts` を**同じ
//! 意味論**で Rust に移したもの。大きな結果 (数十万〜数百万行) ではこれらを JS で回すと
//! メインスレッドが固まるため、行を持つバックエンド側で計算して結果 (行インデックス列
//! やヒット一覧) だけを返す。意味論の一致は共有ゴールデン
//! (`src/__tests__/fixtures/resultOpsVectors.json`) を Rust (`tests/result_ops_golden.rs`)
//! と TS (`resultOpsGolden.test.ts`) の両方から検証して固定する。
//!
//! 既知の差は文字列ソートの照合順序だけ (`js_compat::collation_key` のドキュメント参照)。
//! 正規表現検索は JS と Rust で文法・意味が違うため扱わない (フロントは JS のまま)。

use std::cmp::Ordering;
use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::js_compat::{
    collation_key, contains_ci, js_to_number, js_trim, value_number, value_str,
};
use super::stream_batch::value_to_number;
use super::types::Value;

// ─────────────────────────────────────────────────────────────────────────────
// ソート
// ─────────────────────────────────────────────────────────────────────────────

/// 列の比較方式。フロントの `sortingFnForKind` の分類 (数値 / 真偽値 / それ以外) と同じ。
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SortKind {
    Numeric,
    Bool,
    String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortSpec {
    pub col: usize,
    pub kind: SortKind,
    pub desc: bool,
}

/// 1 列ぶんの事前抽出したソートキー (行ごと)。
enum SortKeys {
    Num(Vec<Option<f64>>),
    Bool(Vec<Option<bool>>),
    Str(Vec<Option<Box<[u8]>>>),
}

/// JS `sortBool` の `toBool`。
fn value_bool(v: &Value) -> Option<bool> {
    match v {
        Value::Null => None,
        Value::Bool(b) => Some(*b),
        Value::Int(i) => Some(*i != 0),
        Value::UInt(u) => Some(*u != 0),
        Value::Float(f) if f.is_finite() => Some(*f != 0.0),
        Value::Float(_) => None,
        Value::String(s) | Value::Bytes(s) => {
            let l = s.to_lowercase();
            match l.as_str() {
                "true" | "1" => Some(true),
                "false" | "0" => Some(false),
                _ => None,
            }
        }
    }
}

fn extract_keys(rows: &[Vec<Value>], indices: &[u32], spec: &SortSpec) -> SortKeys {
    let cell = |i: u32| rows[i as usize].get(spec.col);
    match spec.kind {
        SortKind::Numeric => SortKeys::Num(
            indices
                .iter()
                .map(|&i| cell(i).and_then(value_number))
                .collect(),
        ),
        SortKind::Bool => SortKeys::Bool(
            indices
                .iter()
                .map(|&i| cell(i).and_then(value_bool))
                .collect(),
        ),
        SortKind::String => SortKeys::Str(
            indices
                .iter()
                .map(|&i| cell(i).and_then(value_str).map(|s| collation_key(&s)))
                .collect(),
        ),
    }
}

/// JS `cmpNullable`: NULL は非 NULL より後 (昇順)。降順は呼び出し側が符号を反転するので
/// NULL が先頭に来る。
fn cmp_nullable<T>(a: Option<T>, b: Option<T>, cmp: impl FnOnce(T, T) -> Ordering) -> Ordering {
    match (a, b) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(x), Some(y)) => cmp(x, y),
    }
}

fn cmp_num(a: f64, b: f64) -> Ordering {
    match (a.is_nan(), b.is_nan()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        _ => a.partial_cmp(&b).unwrap_or(Ordering::Equal),
    }
}

impl SortKeys {
    /// 位置 `a` と `b` (フィルタ後の添字) の比較。
    fn compare(&self, a: usize, b: usize) -> Ordering {
        match self {
            SortKeys::Num(k) => cmp_nullable(k[a], k[b], cmp_num),
            SortKeys::Bool(k) => cmp_nullable(k[a], k[b], |x, y| {
                if x == y {
                    Ordering::Equal
                } else if x {
                    Ordering::Greater
                } else {
                    Ordering::Less
                }
            }),
            SortKeys::Str(k) => cmp_nullable(k[a].as_deref(), k[b].as_deref(), |x, y| x.cmp(y)),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// フィルタ
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FilterOp {
    Contains,
    Equals,
    NotEquals,
    StartsWith,
    EndsWith,
    Eq,
    Ne,
    Gt,
    Lt,
    Between,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NullMode {
    Any,
    Only,
    Exclude,
}

/// フロントの `ColumnFilter` + 列番号。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterSpec {
    pub col: usize,
    pub op: FilterOp,
    pub value: String,
    pub value2: String,
    pub null_mode: NullMode,
}

/// `filterHasValue`。
fn filter_has_value(f: &FilterSpec) -> bool {
    if f.op == FilterOp::Between {
        !js_trim(&f.value).is_empty() || !js_trim(&f.value2).is_empty()
    } else {
        !js_trim(&f.value).is_empty()
    }
}

/// `isColumnFilterActive`: 値オペランドか NULL ゲートがあるときだけ絞り込みになる。
pub fn filter_is_active(f: &FilterSpec) -> bool {
    f.null_mode != NullMode::Any || filter_has_value(f)
}

/// `/^[+-]?\d+$/` (ASCII の数字のみ)。`s` は trim 済み前提。
fn is_integer_literal(s: &str) -> bool {
    let body = s.strip_prefix(['+', '-']).unwrap_or(s);
    !body.is_empty() && body.bytes().all(|b| b.is_ascii_digit())
}

/// 符号付き 10 進整数文字列の任意精度比較 (JS の `BigInt` 比較の代わり)。
fn cmp_big_int(a: &str, b: &str) -> Ordering {
    fn split(s: &str) -> (bool, &str) {
        let (neg, body) = match s.as_bytes().first() {
            Some(b'-') => (true, &s[1..]),
            Some(b'+') => (false, &s[1..]),
            _ => (false, s),
        };
        let digits = body.trim_start_matches('0');
        // -0 は 0 (BigInt に負のゼロは無い)。
        (neg && !digits.is_empty(), digits)
    }
    let (an, ad) = split(a);
    let (bn, bd) = split(b);
    match (an, bn) {
        (false, true) => Ordering::Greater,
        (true, false) => Ordering::Less,
        (false, false) => ad.len().cmp(&bd.len()).then_with(|| ad.cmp(bd)),
        (true, true) => bd.len().cmp(&ad.len()).then_with(|| bd.cmp(ad)),
    }
}

/// 評価用に前処理した列フィルタ。
enum Prepared {
    Text {
        op: FilterOp,
        q: String,
    },
    Num {
        op: FilterOp,
        a: String,
        b: String,
        an: f64,
        bn: f64,
        /// 供給されたオペランドが全て整数リテラルか (BigInt 比較に入る条件)。
        all_int: bool,
    },
}

struct PreparedFilter {
    col: usize,
    null_mode: NullMode,
    /// 値オペランド条件 (NULL ゲートだけのフィルタは `None`)。
    cond: Option<Prepared>,
}

fn prepare_filter(f: &FilterSpec) -> PreparedFilter {
    let cond = if filter_has_value(f) {
        Some(match f.op {
            FilterOp::Contains
            | FilterOp::Equals
            | FilterOp::NotEquals
            | FilterOp::StartsWith
            | FilterOp::EndsWith => Prepared::Text {
                op: f.op,
                q: f.value.to_lowercase(),
            },
            _ => {
                let a = js_trim(&f.value).to_string();
                let b = js_trim(&f.value2).to_string();
                let operands: Vec<&String> = if f.op == FilterOp::Between {
                    vec![&a, &b]
                } else {
                    vec![&a]
                };
                let present: Vec<&&String> = operands.iter().filter(|x| !x.is_empty()).collect();
                let all_int = !present.is_empty() && present.iter().all(|x| is_integer_literal(x));
                let an = if a.is_empty() {
                    f64::NAN
                } else {
                    js_to_number(&a)
                };
                let bn = if b.is_empty() {
                    f64::NAN
                } else {
                    js_to_number(&b)
                };
                Prepared::Num {
                    op: f.op,
                    a,
                    b,
                    an,
                    bn,
                    all_int,
                }
            }
        })
    } else {
        None
    };
    PreparedFilter {
        col: f.col,
        null_mode: f.null_mode,
        cond,
    }
}

/// `matchesColumnValue` (非 NULL セル)。
fn matches_value(v: &Value, cond: &Prepared) -> bool {
    match cond {
        Prepared::Text { op, q } => {
            let Some(s) = value_str(v) else {
                return false;
            };
            let s = s.to_lowercase();
            match op {
                FilterOp::Contains => s.contains(q.as_str()),
                FilterOp::Equals => s == *q,
                FilterOp::NotEquals => s != *q,
                FilterOp::StartsWith => s.starts_with(q.as_str()),
                _ => s.ends_with(q.as_str()),
            }
        }
        Prepared::Num {
            op,
            a,
            b,
            an,
            bn,
            all_int,
        } => {
            let Some(text) = value_str(v) else {
                return false;
            };
            let raw = js_trim(&text);
            if *all_int && is_integer_literal(raw) {
                return match op {
                    FilterOp::Eq => cmp_big_int(raw, a) == Ordering::Equal,
                    FilterOp::Ne => cmp_big_int(raw, a) != Ordering::Equal,
                    FilterOp::Gt => cmp_big_int(raw, a) == Ordering::Greater,
                    FilterOp::Lt => cmp_big_int(raw, a) == Ordering::Less,
                    _ => {
                        (a.is_empty() || cmp_big_int(raw, a) != Ordering::Less)
                            && (b.is_empty() || cmp_big_int(raw, b) != Ordering::Greater)
                    }
                };
            }
            // `Number(v)`: 真偽値は 1 / 0、文字列は `js_to_number`。
            let Some(n) = value_number(v) else {
                return false;
            };
            if n.is_nan() {
                return false;
            }
            match op {
                FilterOp::Eq => !an.is_nan() && n == *an,
                FilterOp::Ne => !an.is_nan() && n != *an,
                FilterOp::Gt => !an.is_nan() && n > *an,
                FilterOp::Lt => !an.is_nan() && n < *an,
                _ => {
                    let lo = if an.is_nan() { f64::NEG_INFINITY } else { *an };
                    let hi = if bn.is_nan() { f64::INFINITY } else { *bn };
                    n >= lo && n <= hi
                }
            }
        }
    }
}

/// `columnFilter` (1 フィルタ × 1 セル)。`cell` が `None` / `Some(Null)` / 非有限浮動小数は NULL。
fn passes_filter(f: &PreparedFilter, cell: Option<&Value>) -> bool {
    let is_null = match cell {
        None | Some(Value::Null) => true,
        Some(Value::Float(x)) => !x.is_finite(),
        Some(_) => false,
    };
    if f.null_mode == NullMode::Only {
        return is_null;
    }
    if f.null_mode == NullMode::Exclude && is_null {
        return false;
    }
    let Some(cond) = &f.cond else {
        return true;
    };
    if is_null {
        return false;
    }
    match cell {
        Some(v) => matches_value(v, cond),
        None => false,
    }
}

/// `globalIncludesFilter`: どれかのセル (NULL は文字列 "null") が部分一致すれば通す。
fn passes_global(row: &[Value], col_count: usize, needle_lower: &str) -> bool {
    (0..col_count).any(|c| match row.get(c).and_then(value_str) {
        Some(s) => contains_ci(&s, needle_lower),
        None => contains_ci("null", needle_lower),
    })
}

/// フィルタ → ソートを適用した表示順の行インデックス (元の行位置) を返す。
///
/// TanStack Table と同じく、列フィルタ (非アクティブは無視) と全体フィルタは AND、
/// ソートは複数キーの辞書順で、降順は比較結果の符号反転、全キーが同値なら元の行位置順。
/// 範囲外の列を指すソート・フィルタは無視する。
pub fn sort_filter(
    rows: &[Vec<Value>],
    col_count: usize,
    sort: &[SortSpec],
    filters: &[FilterSpec],
    global: &str,
) -> Vec<u32> {
    let prepared: Vec<PreparedFilter> = filters
        .iter()
        .filter(|f| f.col < col_count && filter_is_active(f))
        .map(prepare_filter)
        .collect();
    let needle = global.to_lowercase();
    let mut indices: Vec<u32> = if prepared.is_empty() && global.is_empty() {
        (0..rows.len() as u32).collect()
    } else {
        (0..rows.len() as u32)
            .filter(|&i| {
                let row = &rows[i as usize];
                prepared.iter().all(|f| passes_filter(f, row.get(f.col)))
                    && (global.is_empty() || passes_global(row, col_count, &needle))
            })
            .collect()
    };
    let sort: Vec<&SortSpec> = sort.iter().filter(|s| s.col < col_count).collect();
    if sort.is_empty() || indices.len() < 2 {
        return indices;
    }
    let keys: Vec<SortKeys> = sort
        .iter()
        .map(|s| extract_keys(rows, &indices, s))
        .collect();
    // キーは `indices` の位置で引く。位置の順列を並べ替えてから元の行位置へ写す。
    let mut order: Vec<u32> = (0..indices.len() as u32).collect();
    order.sort_by(|&pa, &pb| {
        let (a, b) = (pa as usize, pb as usize);
        for (spec, k) in sort.iter().zip(&keys) {
            let mut ord = k.compare(a, b);
            if spec.desc {
                ord = ord.reverse();
            }
            if ord != Ordering::Equal {
                return ord;
            }
        }
        indices[a].cmp(&indices[b])
    });
    for slot in order.iter_mut() {
        *slot = indices[*slot as usize];
    }
    indices = order;
    indices
}

// ─────────────────────────────────────────────────────────────────────────────
// 検索
// ─────────────────────────────────────────────────────────────────────────────

/// 結果内検索のオプション (正規表現は扱わない — フロントは JS で処理する)。
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindOptions {
    pub case_sensitive: bool,
    pub whole_cell: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FindHit {
    pub row_idx: u32,
    pub col_idx: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FindOutput {
    /// 行優先 (行 → 列) のヒット。`limit` 件で打ち切る。
    pub hits: Vec<FindHit>,
    /// 打ち切りを含む総ヒット数。
    pub total: u64,
    /// `hits` が `limit` で打ち切られたか。
    pub truncated: bool,
}

/// `computeFindMatches` の非正規表現版。空クエリはヒット 0 件、NULL セルは対象外。
pub fn find(
    rows: &[Vec<Value>],
    col_count: usize,
    query: &str,
    options: FindOptions,
    limit: usize,
) -> FindOutput {
    let mut out = FindOutput {
        hits: Vec::new(),
        total: 0,
        truncated: false,
    };
    if query.is_empty() || rows.is_empty() || col_count == 0 {
        return out;
    }
    let q_lower = query.to_lowercase();
    for (r, row) in rows.iter().enumerate() {
        for (c, v) in row.iter().take(col_count).enumerate() {
            let Some(s) = value_str(v) else {
                continue;
            };
            let hit = match (options.whole_cell, options.case_sensitive) {
                (true, true) => *s == *query,
                (true, false) => s.to_lowercase() == q_lower,
                (false, true) => s.contains(query),
                (false, false) => contains_ci(&s, &q_lower),
            };
            if hit {
                out.total += 1;
                if out.hits.len() < limit {
                    out.hits.push(FindHit {
                        row_idx: r as u32,
                        col_idx: c as u32,
                    });
                } else {
                    out.truncated = true;
                }
            }
        }
    }
    out
}

// ─────────────────────────────────────────────────────────────────────────────
// 列統計
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModeOut {
    pub value: String,
    pub count: u64,
}

/// フロントの `ColumnStats` (`gridStats.ts::columnStats`) と同じ形。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ColumnStatsOut {
    pub count: u64,
    pub null_count: u64,
    pub non_null_count: u64,
    pub distinct_count: u64,
    pub numeric_count: u64,
    pub sum: Option<f64>,
    pub avg: Option<f64>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub min_len: Option<u64>,
    pub max_len: Option<u64>,
    pub mode: Option<ModeOut>,
}

/// `columnStats(values, kind)`。文字数は JS の `String#length` (UTF-16 コード単位)。
pub fn column_stats(rows: &[Vec<Value>], col: usize) -> ColumnStatsOut {
    let mut null_count = 0u64;
    let mut numeric_count = 0u64;
    let mut sum = 0.0f64;
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    let mut min_len = u64::MAX;
    let mut max_len = 0u64;
    // 値 → (出現数, 初出順)。最頻値は「最大の出現数のうち最初に現れたもの」(JS の Map 走査順)。
    let mut freq: HashMap<String, (u64, u64)> = HashMap::new();
    for row in rows {
        let cell = row.get(col).unwrap_or(&Value::Null);
        let Some(s) = value_str(cell) else {
            null_count += 1;
            continue;
        };
        let len = s.encode_utf16().count() as u64;
        min_len = min_len.min(len);
        max_len = max_len.max(len);
        let order = freq.len() as u64;
        match freq.get_mut(s.as_ref()) {
            Some(e) => e.0 += 1,
            None => {
                freq.insert(s.into_owned(), (1, order));
            }
        }
        if let Some(n) = value_to_number(cell) {
            numeric_count += 1;
            sum += n;
            min = min.min(n);
            max = max.max(n);
        }
    }
    let count = rows.len() as u64;
    let non_null = count - null_count;
    let has_numeric = numeric_count > 0;
    let mode = freq
        .iter()
        .max_by(|a, b| a.1 .0.cmp(&b.1 .0).then(b.1 .1.cmp(&a.1 .1)))
        .map(|(value, (count, _))| ModeOut {
            value: value.clone(),
            count: *count,
        });
    ColumnStatsOut {
        count,
        null_count,
        non_null_count: non_null,
        distinct_count: freq.len() as u64,
        numeric_count,
        sum: has_numeric.then_some(sum),
        avg: has_numeric.then(|| sum / numeric_count as f64),
        min: has_numeric.then_some(min),
        max: has_numeric.then_some(max),
        min_len: (non_null > 0).then_some(min_len),
        max_len: (non_null > 0).then_some(max_len),
        mode,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &str) -> Value {
        Value::String(v.to_string())
    }

    fn rows_of(vals: &[Value]) -> Vec<Vec<Value>> {
        vals.iter().map(|v| vec![v.clone()]).collect()
    }

    fn sort_spec(kind: SortKind, desc: bool) -> SortSpec {
        SortSpec { col: 0, kind, desc }
    }

    #[test]
    fn numeric_sort_puts_nan_then_null_last_and_inverts_on_desc() {
        let rows = rows_of(&[s("10"), Value::Null, s("abc"), Value::Int(2), s("")]);
        // "" は Number("") === 0。
        let asc = sort_filter(&rows, 1, &[sort_spec(SortKind::Numeric, false)], &[], "");
        assert_eq!(asc, vec![4, 3, 0, 2, 1]);
        let desc = sort_filter(&rows, 1, &[sort_spec(SortKind::Numeric, true)], &[], "");
        assert_eq!(desc, vec![1, 2, 0, 3, 4]);
    }

    #[test]
    fn ties_keep_original_order_even_when_desc() {
        let rows = rows_of(&[Value::Int(1), Value::Int(1), Value::Int(2)]);
        let desc = sort_filter(&rows, 1, &[sort_spec(SortKind::Numeric, true)], &[], "");
        assert_eq!(desc, vec![2, 0, 1]);
    }

    #[test]
    fn multi_key_sort_uses_second_key_on_ties() {
        let rows = vec![
            vec![Value::Int(1), s("b")],
            vec![Value::Int(1), s("a")],
            vec![Value::Int(0), s("z")],
        ];
        let spec = [
            SortSpec {
                col: 0,
                kind: SortKind::Numeric,
                desc: false,
            },
            SortSpec {
                col: 1,
                kind: SortKind::String,
                desc: false,
            },
        ];
        assert_eq!(sort_filter(&rows, 2, &spec, &[], ""), vec![2, 1, 0]);
    }

    fn text_filter(op: FilterOp, value: &str) -> FilterSpec {
        FilterSpec {
            col: 0,
            op,
            value: value.to_string(),
            value2: String::new(),
            null_mode: NullMode::Any,
        }
    }

    #[test]
    fn big_integer_equality_is_exact() {
        let rows = rows_of(&[s("9007199254740993"), s("9007199254740992")]);
        let f = text_filter(FilterOp::Eq, "9007199254740993");
        assert_eq!(sort_filter(&rows, 1, &[], &[f], ""), vec![0]);
    }

    #[test]
    fn between_with_open_bound() {
        let rows = rows_of(&[Value::Int(1), Value::Int(5), Value::Int(9)]);
        let mut f = text_filter(FilterOp::Between, "");
        f.value2 = "5".into();
        assert_eq!(sort_filter(&rows, 1, &[], &[f], ""), vec![0, 1]);
    }

    #[test]
    fn null_gate_and_inactive_filter() {
        let rows = rows_of(&[Value::Null, s("x")]);
        let mut only = text_filter(FilterOp::Contains, "");
        only.null_mode = NullMode::Only;
        assert_eq!(sort_filter(&rows, 1, &[], &[only], ""), vec![0]);
        let inactive = text_filter(FilterOp::Contains, "   ");
        assert_eq!(sort_filter(&rows, 1, &[], &[inactive], ""), vec![0, 1]);
    }

    #[test]
    fn global_filter_matches_null_as_text() {
        let rows = rows_of(&[Value::Null, s("x")]);
        assert_eq!(sort_filter(&rows, 1, &[], &[], "NUL"), vec![0]);
    }

    #[test]
    fn find_skips_null_and_limits() {
        let rows = vec![vec![s("Abc"), Value::Null], vec![s("abc"), s("ABC")]];
        let opts = FindOptions {
            case_sensitive: false,
            whole_cell: false,
        };
        let out = find(&rows, 2, "abc", opts, 2);
        assert_eq!(out.total, 3);
        assert!(out.truncated);
        assert_eq!(out.hits.len(), 2);
        let cs = FindOptions {
            case_sensitive: true,
            whole_cell: true,
        };
        let out = find(&rows, 2, "abc", cs, 10);
        assert_eq!(
            out.hits,
            vec![FindHit {
                row_idx: 1,
                col_idx: 0
            }]
        );
        assert!(find(&rows, 2, "", opts, 10).hits.is_empty());
    }

    #[test]
    fn column_stats_counts_utf16_length_and_first_mode() {
        let rows = rows_of(&[
            s("😀"),
            s("a"),
            s("a"),
            s("b"),
            s("b"),
            Value::Null,
            Value::Int(3),
        ]);
        let st = column_stats(&rows, 0);
        assert_eq!(st.count, 7);
        assert_eq!(st.null_count, 1);
        assert_eq!(st.distinct_count, 4);
        assert_eq!(st.min_len, Some(1));
        assert_eq!(st.max_len, Some(2));
        // "a" と "b" が同数 (2) → 先に現れた "a"。
        assert_eq!(
            st.mode,
            Some(ModeOut {
                value: "a".into(),
                count: 2
            })
        );
        assert_eq!(st.numeric_count, 1);
        assert_eq!(st.sum, Some(3.0));
    }
}
