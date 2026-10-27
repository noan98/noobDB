//! ドライバをまたぐデータ比較 (#1869) の値正規化。
//!
//! MySQL ⇔ PostgreSQL ⇔ SQLite の同じ表を突き合わせると、中身が同じでも値の表現が違う。
//! 真偽 (`tinyint(1)` の 0/1 と `boolean`)、decimal の末尾ゼロ、SQLite の float 化、
//! 日時の書式 (`T` 区切り・小数秒の桁・タイムゾーン)、JSON の空白などである。
//! 比較の前に両側の値を論理型 ([`TransferType`]) の正準形へ寄せ、表現の差だけで「差分」に
//! ならないようにする。型名 → 論理型の判定と、縮退する列の検出は `transfer.rs` の
//! [`classify_source_type`] / [`lossy_conversions`] をそのまま再利用し、ここでは二重実装しない。
//!
//! 正規化はあくまで**比較のキー**にだけ使う。`RowDiff` に載る値は元のまま。
//! 64bit 整数は `Value::from_*_lossless` が作る形 (2^53 超は `Value::String`) を壊さず、
//! 文字列のまま i128 で比べる。

use chrono::{Duration, NaiveDate, NaiveDateTime, NaiveTime};
use serde::Serialize;

use super::transfer::{
    classify_source_type, lossy_conversions, LossyKind, TransferColumn, TransferType,
};
use super::types::Value;
use super::DriverKind;

/// ソースの列名をターゲットの列名へ対応付ける (クロスドライバ用, #1869)。完全一致を優先し、
/// 無いときだけ大文字小文字を無視して 1 つに決まる列へ。複数の候補があれば `Err((ソース列, 候補))`。
/// どれにも当たらない列はソースの名前のまま返す (欠落は呼び出し側の検証が報告する)。
pub fn map_target_columns(
    source: &[String],
    target: &[String],
) -> std::result::Result<Vec<String>, (String, Vec<String>)> {
    // 1 対 1 にするため、完全一致の列を先に予約する。
    let mut used: Vec<&String> = source.iter().filter(|n| target.contains(n)).collect();
    let mut out = Vec::with_capacity(source.len());
    for name in source {
        if target.contains(name) {
            out.push(name.clone());
            continue;
        }
        let candidates: Vec<&String> = target
            .iter()
            .filter(|t| t.eq_ignore_ascii_case(name))
            .collect();
        match candidates.as_slice() {
            [] => out.push(name.clone()),
            [one] if !used.contains(one) => {
                used.push(one);
                out.push((*one).clone());
            }
            many => {
                return Err((name.clone(), many.iter().map(|c| (*c).clone()).collect()));
            }
        }
    }
    Ok(out)
}

/// 列ごとの比較用の論理型と、ターゲット側の列名の対応。`types` は比較する列 (`columns`) と同じ並び。
#[derive(Debug, Clone, PartialEq)]
pub struct CompareNorms {
    pub types: Vec<TransferType>,
    /// ターゲット側の列名 (`columns` と同じ並び)。空ならソースと同じ名前。
    /// クロスドライバで大文字小文字だけが違う列を対応付けたときに使う。
    pub target_columns: Vec<String>,
    /// ターゲット側の主キー列名。空ならソースと同じ名前。
    pub target_pk: Vec<String>,
}

impl CompareNorms {
    /// 全列を「そのまま比較」にする (同一ドライバ向けの恒等)。
    #[cfg(test)]
    pub fn identity(n: usize) -> Self {
        Self {
            types: vec![TransferType::Text; n],
            target_columns: Vec::new(),
            target_pk: Vec::new(),
        }
    }

    /// `col` 番目の列の値を正準形へ寄せる (主キーの署名用。整数キー以外は元の値のまま)。
    pub fn normalize(&self, col: usize, v: &Value) -> Value {
        match self.types.get(col) {
            Some(ty) => normalize_value(ty, v),
            None => v.clone(),
        }
    }

    /// 対応付けた 2 つの値を、列の論理型に従って「同じ値」とみなせるか。迷うときは `false`
    /// (差分に倒す)。float / decimal は値の対ごとに判定する (片側が実際に浮動小数のときだけ丸める)。
    pub fn values_match(&self, col: usize, a: &Value, b: &Value) -> bool {
        if matches!(a, Value::Null) || matches!(b, Value::Null) {
            return matches!(a, Value::Null) && matches!(b, Value::Null);
        }
        match self.types.get(col) {
            Some(TransferType::Float) => float_match(a, b),
            Some(TransferType::Decimal { .. }) => decimal_match(a, b),
            Some(ty) => values_equal(&normalize_value(ty, a), &normalize_value(ty, b)),
            None => values_equal(a, b),
        }
    }

    /// 主キーの値が正規化後に整数として読めるか (クロスドライバの主キーは整数に限る)。
    pub fn key_is_integer(&self, col: usize, v: &Value) -> bool {
        matches!(self.normalize(col, v), Value::Int(_) | Value::UInt(_))
            || matches!(self.normalize(col, v), Value::String(s) if s.parse::<i128>().is_ok())
    }
}

fn values_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Float(x), Value::Float(y)) if x.is_nan() && y.is_nan() => true,
        _ => a == b,
    }
}

/// 整数として厳密に読める値か (小数部のある Float や 2^53 以上の Float は読めない)。
fn exact_int(v: &Value) -> Option<Value> {
    norm_int(v)
}

/// float 列の比較。整数との対は整数として厳密に、浮動小数どうし (や小数文字列) は f64 で比べる。
fn float_match(a: &Value, b: &Value) -> bool {
    let is_float = |v: &Value| matches!(v, Value::Float(_));
    if is_float(a) || is_float(b) {
        // 片側が整数 (Int / UInt / 数字文字列) のときは整数として比べる。
        let int_like = |v: &Value| match v {
            Value::Int(_) | Value::UInt(_) => true,
            Value::String(s) => s.trim().parse::<i128>().is_ok(),
            _ => false,
        };
        if int_like(a) || int_like(b) {
            return match (exact_int(a), exact_int(b)) {
                (Some(x), Some(y)) => x == y,
                _ => false,
            };
        }
    } else if let (Some(x), Some(y)) = (exact_int(a), exact_int(b)) {
        if !matches!((a, b), (Value::Bool(_), _) | (_, Value::Bool(_))) {
            return x == y;
        }
    }
    match (norm_float(a), norm_float(b)) {
        (Some(Value::Float(x)), Some(Value::Float(y))) => x == y || (x.is_nan() && y.is_nan()),
        _ => false,
    }
}

/// decimal 列の比較。実際に `Value::Float` が絡む対だけ有効 15 桁に丸めて比べ (SQLite の float 化)、
/// それ以外は桁・末尾ゼロだけを無視した厳密比較にする。
fn decimal_match(a: &Value, b: &Value) -> bool {
    if matches!(a, Value::Float(_)) || matches!(b, Value::Float(_)) {
        return match (decimal_text(a, true), decimal_text(b, true)) {
            (Some(x), Some(y)) => x == y,
            _ => false,
        };
    }
    match (decimal_text(a, false), decimal_text(b, false)) {
        (Some(x), Some(y)) => x == y,
        _ => values_equal(a, b),
    }
}

/// 正規化で「一致とみなした」差の種類 (UI の Callout で列ごとに表示する)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NormalizeKind {
    /// 真偽値の表現差 (`tinyint(1)` / `boolean` / 0・1) を同一視した。
    Boolean,
    /// decimal の桁・末尾ゼロ (`1.10` と `1.1`) を同一視した。
    DecimalScale,
    /// SQLite の float 化により有効 15 桁で比べた。
    DecimalFloat,
    /// 片側の精度上限で丸められうる decimal。
    DecimalClamped,
    /// タイムゾーン付き時刻が片側で縮退する。オフセットなしの値は UTC とみなして比べた。
    TimestampTzDegraded,
    /// 日時の書式・小数秒の桁の差を同一視した。
    TimestampFormat,
    /// JSON の空白・キー順を同一視した (数値は倍精度で比べることがある)。
    Json,
    /// decimal と浮動小数の列を、浮動小数 (f64) の値で比べた (丸め誤差を無視する)。
    FloatCompare,
    /// 列名の大文字小文字だけが違う列を対応付けた。`NormalizedColumn.column` がソースの列名、
    /// `target_type` がターゲットの列名 (`source_type` はソースの型)。
    ColumnName,
}

/// 正規化して一致とみなした列 1 つ。`preview_transfer` の縮退警告と同じ要領で画面に出す。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NormalizedColumn {
    pub column: String,
    pub kind: NormalizeKind,
    pub source_type: String,
    pub target_type: String,
}

/// 2 つの論理型を比較用に 1 つへ寄せる。判定できない側 (`None`) は相手に合わせる。
pub fn reconcile(a: Option<&TransferType>, b: Option<&TransferType>) -> TransferType {
    use TransferType as T;
    let (a, b) = match (a, b) {
        (Some(a), Some(b)) => (a, b),
        (Some(x), None) | (None, Some(x)) => return x.clone(),
        (None, None) => return T::Text,
    };
    if a == b {
        return a.clone();
    }
    let pair = |x: &T, y: &T| (a == x && b == y) || (a == y && b == x);
    let is_int = |t: &T| matches!(t, T::Integer | T::UnsignedBigInt);
    if is_int(a) && is_int(b) {
        return T::Integer;
    }
    if (is_int(a) && *b == T::Boolean) || (*a == T::Boolean && is_int(b)) {
        return T::Boolean;
    }
    match (a, b) {
        (T::Decimal { .. }, T::Decimal { .. }) => return a.clone(),
        (T::Decimal { .. }, t) | (t, T::Decimal { .. }) if is_int(t) => {
            return if matches!(a, T::Decimal { .. }) {
                a.clone()
            } else {
                b.clone()
            };
        }
        (T::Float, t) | (t, T::Float) if is_int(t) || matches!(t, T::Decimal { .. }) => {
            return T::Float
        }
        _ => {}
    }
    if pair(&T::Timestamp, &T::TimestampTz) {
        return T::TimestampTz;
    }
    if pair(&T::Date, &T::Timestamp) {
        return T::Timestamp;
    }
    if pair(&T::Date, &T::TimestampTz) {
        return T::TimestampTz;
    }
    // SQLite は型を強制せず、日時・JSON・UUID を TEXT で持つことが多い。相手側の論理型に合わせる。
    for rich in [
        T::Timestamp,
        T::TimestampTz,
        T::Date,
        T::Time,
        T::Json,
        T::Uuid,
    ] {
        if pair(&rich, &T::Text) {
            return rich;
        }
    }
    T::Text
}

/// 列ごとの比較用の型と、一致とみなす列の一覧を作る。`ignore_columns` は報告から外す。
#[allow(clippy::too_many_arguments)]
pub fn build_norms(
    source_driver: DriverKind,
    target_driver: DriverKind,
    columns: &[String],
    source_types: &[String],
    target_types: &[String],
    ignore_columns: &[String],
) -> (CompareNorms, Vec<NormalizedColumn>) {
    let sqlite_involved =
        source_driver == DriverKind::Sqlite || target_driver == DriverKind::Sqlite;
    let mut types = Vec::with_capacity(columns.len());
    let mut report: Vec<NormalizedColumn> = Vec::new();
    for (i, name) in columns.iter().enumerate() {
        let st = source_types.get(i).map(String::as_str).unwrap_or("");
        let tt = target_types.get(i).map(String::as_str).unwrap_or("");
        let sa = classify_source_type(st);
        let ta = classify_source_type(tt);
        let ty = reconcile(sa.as_ref(), ta.as_ref());
        types.push(ty.clone());
        if ignore_columns.contains(name) {
            continue;
        }
        let mut push = |kind: NormalizeKind| {
            if !report.iter().any(|r| r.column == *name && r.kind == kind) {
                report.push(NormalizedColumn {
                    column: name.clone(),
                    kind,
                    source_type: st.to_string(),
                    target_type: tt.to_string(),
                });
            }
        };
        match &ty {
            // ドライバが違うので、型名が同じ Boolean でも表現 (真偽 / 0・1) は違いうる。常に知らせる。
            TransferType::Boolean => push(NormalizeKind::Boolean),
            TransferType::Decimal { .. } => {
                push(NormalizeKind::DecimalScale);
                // SQLite 側に実際の浮動小数が入っていれば丸めて比べるので、精度が分からなくても必ず知らせる。
                if sqlite_involved {
                    push(NormalizeKind::DecimalFloat);
                }
            }
            TransferType::Json => push(NormalizeKind::Json),
            TransferType::Float
                if matches!(
                    (&sa, &ta),
                    (
                        Some(TransferType::Decimal { .. }),
                        Some(TransferType::Float)
                    ) | (
                        Some(TransferType::Float),
                        Some(TransferType::Decimal { .. })
                    )
                ) =>
            {
                push(NormalizeKind::FloatCompare)
            }
            _ => {}
        }
        // 縮退は転送と同じ判定 (各側の型をもう一方のドライバへ移した場合) を両方向で見る。
        let side = |driver: DriverKind, ty: &TransferType, source_type: &str| {
            lossy_conversions(
                driver,
                &[TransferColumn {
                    name: name.clone(),
                    source_type: source_type.to_string(),
                    ty: ty.clone(),
                }],
            )
        };
        let mut lossy = Vec::new();
        lossy.extend(side(target_driver, sa.as_ref().unwrap_or(&ty), st));
        lossy.extend(side(source_driver, ta.as_ref().unwrap_or(&ty), tt));
        let mut tz_reported = false;
        for l in lossy {
            push(match l.kind {
                LossyKind::DecimalClamped => NormalizeKind::DecimalClamped,
                LossyKind::DecimalFloat => NormalizeKind::DecimalFloat,
                LossyKind::TimestampTzDegraded => {
                    tz_reported = true;
                    NormalizeKind::TimestampTzDegraded
                }
            });
        }
        if matches!(ty, TransferType::Timestamp | TransferType::TimestampTz) && !tz_reported {
            push(NormalizeKind::TimestampFormat);
        }
    }
    (
        CompareNorms {
            types,
            target_columns: Vec::new(),
            target_pk: Vec::new(),
        },
        report,
    )
}

/// 値 1 つを論理型の正準形へ寄せる。寄せられない値 (未知の書式など) は元のまま返す。
pub fn normalize_value(ty: &TransferType, v: &Value) -> Value {
    if matches!(v, Value::Null) {
        return Value::Null;
    }
    let out = match ty {
        TransferType::Boolean => norm_bool(v),
        TransferType::Integer | TransferType::UnsignedBigInt => norm_int(v),
        TransferType::Float => norm_float(v),
        TransferType::Decimal { .. } => decimal_text(v, false).map(Value::String),
        TransferType::Date => text_of(v).and_then(|s| norm_date(&s)).map(Value::String),
        TransferType::Time => text_of(v).and_then(|s| norm_time(&s)).map(Value::String),
        TransferType::Timestamp => text_of(v)
            .and_then(|s| parse_naive(&s))
            .map(|dt| Value::String(format_naive(&dt))),
        TransferType::TimestampTz => text_of(v)
            .and_then(|s| parse_utc(&s))
            .map(|dt| Value::String(format_naive(&dt))),
        TransferType::Json => match v {
            Value::String(s) => serde_json::from_str::<serde_json::Value>(s)
                .ok()
                .map(|j| Value::String(canonical_json(&j))),
            _ => None,
        },
        TransferType::Uuid => match v {
            Value::String(s) => Some(Value::String(
                s.chars()
                    .filter(|c| !matches!(c, '-' | '{' | '}'))
                    .collect::<String>()
                    .to_ascii_lowercase(),
            )),
            _ => None,
        },
        TransferType::Binary => match v {
            Value::Bytes(h) => Some(Value::Bytes(h.to_ascii_lowercase())),
            _ => None,
        },
        TransferType::Text => None,
    };
    out.unwrap_or_else(|| v.clone())
}

fn text_of(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.trim().to_string()),
        _ => None,
    }
}

/// 真偽: 0/1 の整数・BIT(1) の 16 進・`'0'`/`'1'`・`t`/`f` を Bool へ。0/1 以外は元のまま
/// (黙って true に丸めない — 転送の `value_to_cell` と同じ方針)。
fn norm_bool(v: &Value) -> Option<Value> {
    match v {
        Value::Bool(_) => Some(v.clone()),
        Value::Int(n) if *n == 0 || *n == 1 => Some(Value::Bool(*n == 1)),
        Value::UInt(n) if *n <= 1 => Some(Value::Bool(*n == 1)),
        Value::Bytes(h) => match u64::from_str_radix(h, 16) {
            Ok(n) if n <= 1 => Some(Value::Bool(n == 1)),
            _ => None,
        },
        Value::String(s) => match s.trim().to_ascii_lowercase().as_str() {
            "0" | "f" | "false" => Some(Value::Bool(false)),
            "1" | "t" | "true" => Some(Value::Bool(true)),
            _ => None,
        },
        _ => None,
    }
}

/// 整数: `Int` / `UInt` / 2^53 超の `String` を i128 で読み、同じ値は同じ形にする
/// (`Value::from_i128_lossless`: 2^53 以内は `Int`、超えれば数字文字列)。
fn norm_int(v: &Value) -> Option<Value> {
    let n: i128 = match v {
        Value::Int(i) => i128::from(*i),
        Value::UInt(u) => i128::from(*u),
        Value::String(s) => s.trim().parse::<i128>().ok()?,
        Value::Bool(b) => i128::from(*b),
        // SQLite が整数列に REAL を入れた (5.0) 場合。小数部が無く 2^53 未満のときだけ整数とみなす。
        Value::Float(f) if f.fract() == 0.0 && f.abs() < 9_007_199_254_740_992.0 => *f as i128,
        _ => return None,
    };
    // 安全整数の外は文字列 (`Value::from_*_lossless` と同じ形)。同じ値は必ず同じ形になる。
    Some(Value::from_i128_lossless(n))
}

fn norm_float(v: &Value) -> Option<Value> {
    match v {
        Value::Float(_) => Some(v.clone()),
        Value::Int(i) => Some(Value::Float(*i as f64)),
        Value::UInt(u) => Some(Value::Float(*u as f64)),
        Value::String(s) => s.trim().parse::<f64>().ok().map(Value::Float),
        _ => None,
    }
}

/// decimal を正準な文字列へ。`round15` なら有効 15 桁に丸めた f64 を経由する (浮動小数との比較用)。
fn decimal_text(v: &Value, round15: bool) -> Option<String> {
    let text = match v {
        Value::Int(i) => i.to_string(),
        Value::UInt(u) => u.to_string(),
        Value::Float(f) if f.is_finite() => f.to_string(),
        Value::String(s) => s.trim().to_string(),
        _ => return None,
    };
    let text = if round15 {
        let f: f64 = text.parse().ok()?;
        if !f.is_finite() {
            return None;
        }
        format!("{:.14e}", f).parse::<f64>().ok()?.to_string()
    } else {
        text
    };
    canonical_decimal(&text)
}

/// `-001.2300` → `-1.23`、`0.00` / `-0` → `0`。指数表記・非数値は `None`。
pub fn canonical_decimal(s: &str) -> Option<String> {
    let s = s.trim();
    let (neg, body) = match s.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, s.strip_prefix('+').unwrap_or(s)),
    };
    let (int_part, frac_part) = body.split_once('.').unwrap_or((body, ""));
    if int_part.is_empty() && frac_part.is_empty() {
        return None;
    }
    if !int_part.bytes().all(|b| b.is_ascii_digit())
        || !frac_part.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let int_trim = int_part.trim_start_matches('0');
    let frac_trim = frac_part.trim_end_matches('0');
    let int_out = if int_trim.is_empty() { "0" } else { int_trim };
    let is_zero = int_trim.is_empty() && frac_trim.is_empty();
    let mut out = String::new();
    if neg && !is_zero {
        out.push('-');
    }
    out.push_str(int_out);
    if !frac_trim.is_empty() {
        out.push('.');
        out.push_str(frac_trim);
    }
    Some(out)
}

/// 日付だけ・日時・`T` 区切り・小数秒の有無を受ける。
fn parse_naive(s: &str) -> Option<NaiveDateTime> {
    let s = s.trim();
    for fmt in ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S%.f"] {
        if let Ok(dt) = NaiveDateTime::parse_from_str(s, fmt) {
            return Some(dt);
        }
    }
    NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.and_hms_opt(0, 0, 0))
}

/// 末尾のオフセット (`Z` / `+09` / `+09:00` / `+0900`) を UTC へ直す。オフセットが無い値は UTC とみなす。
fn parse_utc(s: &str) -> Option<NaiveDateTime> {
    let s = s.trim();
    if let Some(body) = s.strip_suffix(['Z', 'z']) {
        return parse_naive(body);
    }
    // 日付部 (先頭 10 文字) の '-' と区別するため、時刻部以降から探す。
    let time_start = s.find([' ', 'T']).unwrap_or(s.len());
    if let Some(rel) = s[time_start..].rfind(['+', '-']) {
        let at = time_start + rel;
        let (body, off) = s.split_at(at);
        let sign: i64 = if off.starts_with('-') { -1 } else { 1 };
        let digits: String = off[1..].chars().filter(|c| *c != ':').collect();
        if !digits.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let (h, m) = match digits.len() {
            2 => (digits.parse::<i64>().ok()?, 0),
            4 => (
                digits[..2].parse::<i64>().ok()?,
                digits[2..].parse::<i64>().ok()?,
            ),
            _ => return None,
        };
        let naive = parse_naive(body)?;
        return naive.checked_sub_signed(Duration::minutes(sign * (h * 60 + m)));
    }
    parse_naive(s)
}

/// `YYYY-MM-DD HH:MM:SS[.fraction]` (小数秒は末尾ゼロを落とす)。
fn format_naive(dt: &NaiveDateTime) -> String {
    let base = dt.format("%Y-%m-%d %H:%M:%S").to_string();
    let nanos = dt.and_utc().timestamp_subsec_nanos();
    if nanos == 0 {
        base
    } else {
        let frac = format!("{nanos:09}");
        format!("{base}.{}", frac.trim_end_matches('0'))
    }
}

fn norm_date(s: &str) -> Option<String> {
    let dt = parse_naive(s)?;
    if dt.time() == NaiveTime::MIN {
        Some(dt.format("%Y-%m-%d").to_string())
    } else {
        Some(format_naive(&dt))
    }
}

fn norm_time(s: &str) -> Option<String> {
    let t = NaiveTime::parse_from_str(s.trim(), "%H:%M:%S%.f").ok()?;
    let base = t.format("%H:%M:%S").to_string();
    let nanos = t.format("%f").to_string();
    let frac = nanos.trim_end_matches('0');
    Some(if frac.is_empty() {
        base
    } else {
        format!("{base}.{frac}")
    })
}

/// キーを辞書順に並べた最小表現 (空白なし)。`serde_json` の `preserve_order` が有効でも順序に依らない。
fn canonical_json(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys
                .into_iter()
                .map(|k| {
                    let key = serde_json::Value::String(k.clone()).to_string();
                    let val = map.get(k).map(canonical_json).unwrap_or_default();
                    format!("{key}:{val}")
                })
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        serde_json::Value::Array(a) => {
            let parts: Vec<String> = a.iter().map(canonical_json).collect();
            format!("[{}]", parts.join(","))
        }
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &str) -> Value {
        Value::String(v.to_string())
    }

    fn eq(ty: &TransferType, a: &Value, b: &Value) -> bool {
        CompareNorms {
            types: vec![ty.clone()],
            target_columns: Vec::new(),
            target_pk: Vec::new(),
        }
        .values_match(0, a, b)
    }

    #[test]
    fn canonical_decimal_golden() {
        for (input, want) in [
            ("1.10", Some("1.1")),
            ("1.1", Some("1.1")),
            ("-001.2300", Some("-1.23")),
            ("0.00", Some("0")),
            ("-0", Some("0")),
            ("-0.0", Some("0")),
            ("+5", Some("5")),
            ("100", Some("100")),
            ("100.000", Some("100")),
            (".5", Some("0.5")),
            (
                "12345678901234567890.123400",
                Some("12345678901234567890.1234"),
            ),
            ("1e5", None),
            ("abc", None),
            ("", None),
        ] {
            assert_eq!(canonical_decimal(input).as_deref(), want, "input: {input}");
        }
    }

    #[test]
    fn boolean_golden() {
        let b = TransferType::Boolean;
        assert!(eq(&b, &Value::Int(1), &Value::Bool(true)));
        assert!(eq(&b, &Value::Int(0), &Value::Bool(false)));
        assert!(eq(&b, &Value::UInt(1), &Value::Bool(true)));
        // MySQL BIT(1) は 16 進文字列。
        assert!(eq(&b, &Value::Bytes("01".into()), &Value::Bool(true)));
        assert!(eq(&b, &s("0"), &Value::Bool(false)));
        assert!(eq(&b, &s("t"), &Value::Bool(true)));
        assert!(!eq(&b, &Value::Int(0), &Value::Bool(true)));
        // 0/1 以外を true に丸めない。
        assert!(!eq(&b, &Value::Int(2), &Value::Bool(true)));
        assert_eq!(normalize_value(&b, &Value::Int(2)), Value::Int(2));
        assert_eq!(normalize_value(&b, &Value::Null), Value::Null);
    }

    #[test]
    fn integer_is_lossless_across_representations() {
        let i = TransferType::Integer;
        // 2^53 超は String で届くが、i64 の Int と同じ値なら一致する。
        let big = 9_007_199_254_740_993_i64;
        assert!(eq(&i, &Value::Int(big), &s("9007199254740993")));
        // 1 違いは別の値のまま (f64 に丸めない)。
        assert!(!eq(&i, &Value::Int(big), &s("9007199254740992")));
        assert!(eq(&i, &Value::Int(5), &Value::UInt(5)));
        assert!(eq(&i, &Value::Int(5), &s(" 5 ")));
        assert!(eq(&i, &Value::Float(5.0), &Value::Int(5)));
        assert!(!eq(&i, &Value::Float(5.5), &Value::Int(5)));
        // u64 の上限を超えない BIGINT UNSIGNED。
        assert!(eq(
            &TransferType::UnsignedBigInt,
            &Value::UInt(u64::MAX),
            &s("18446744073709551615")
        ));
        assert!(!eq(&i, &Value::Int(i64::MAX), &s("9223372036854775806")));
        assert!(eq(&i, &Value::Int(i64::MIN), &s("-9223372036854775808")));
    }

    #[test]
    fn decimal_golden() {
        let d = TransferType::Decimal {
            precision: Some(10),
            scale: Some(2),
        };
        assert!(eq(&d, &s("1.10"), &s("1.1")));
        assert!(eq(&d, &s("1.00"), &Value::Int(1)));
        assert!(eq(&d, &Value::Float(2.5), &s("2.50")));
        assert!(eq(&d, &s("0.00"), &s("-0.00")));
        assert!(!eq(&d, &s("1.10"), &s("1.11")));
        // 実際に Float が絡む対だけ有効 15 桁に丸める。
        let a = s("123456789012345.678");
        let b = Value::Float(123456789012345.68);
        assert!(eq(&d, &a, &b));
        // 15 桁より上の違いは丸めても残る。
        assert!(!eq(&d, &s("1.5"), &Value::Float(1.6)));
    }

    #[test]
    fn decimal_without_float_is_exact() {
        // numeric(18,0): SQLite の INTEGER (2^53 超は String) どうしは丸めずに差分になる。
        let d = TransferType::Decimal {
            precision: Some(18),
            scale: Some(0),
        };
        assert!(!eq(&d, &s("123456789012345678"), &s("123456789012345679")));
        assert!(!eq(&d, &Value::Int(1), &s("2")));
        // TEXT で正確に保持された数値は、桁・末尾ゼロだけ無視して一致する。
        assert!(eq(
            &d,
            &s("123456789012345678"),
            &s("123456789012345678.000")
        ));
        assert!(eq(
            &d,
            &s("12345678901234567.89"),
            &s("12345678901234567.890")
        ));
        assert!(!eq(
            &d,
            &s("12345678901234567.89"),
            &s("12345678901234567.88")
        ));
        // 片側が Float なら丸め (有効 15 桁) で比べる。
        assert!(eq(
            &d,
            &Value::Float(123456789012345680.0),
            &s("123456789012345678")
        ));
    }

    #[test]
    fn float_vs_integer_is_exact() {
        let f = TransferType::Float;
        // 2^53 + 1 の整数と 2^53 の Float は別の値 (f64 に丸めて一致にしない)。
        assert!(!eq(
            &f,
            &Value::Int(9_007_199_254_740_993),
            &Value::Float(9_007_199_254_740_992.0)
        ));
        assert!(!eq(
            &f,
            &s("9007199254740993"),
            &Value::Float(9_007_199_254_740_992.0)
        ));
        assert!(!eq(
            &f,
            &s("9007199254740992"),
            &Value::Float(9_007_199_254_740_992.0)
        ));
        // 小数部のある値と整数は別。
        assert!(!eq(&f, &Value::Int(5), &Value::Float(5.5)));
        // 安全整数の範囲で値が等しければ一致。
        assert!(eq(&f, &Value::Int(5), &Value::Float(5.0)));
        assert!(eq(&f, &s("5"), &Value::Float(5.0)));
        assert!(!eq(&f, &Value::Int(5), &Value::Int(6)));
        assert!(!eq(&f, &Value::Int(5), &Value::Null));
        assert!(eq(&f, &Value::Null, &Value::Null));
    }

    #[test]
    fn float_golden() {
        let f = TransferType::Float;
        assert!(eq(&f, &Value::Float(1.0), &Value::Int(1)));
        assert!(eq(&f, &Value::Float(f64::NAN), &Value::Float(f64::NAN)));
        assert!(eq(&f, &s("0.5"), &Value::Float(0.5)));
        assert!(!eq(&f, &Value::Float(0.1), &Value::Float(0.2)));
    }

    #[test]
    fn timestamp_golden() {
        let t = TransferType::Timestamp;
        assert!(eq(
            &t,
            &s("2024-01-02 03:04:05"),
            &s("2024-01-02T03:04:05.000000")
        ));
        assert!(eq(
            &t,
            &s("2024-01-02 03:04:05.500"),
            &s("2024-01-02 03:04:05.5")
        ));
        assert!(!eq(
            &t,
            &s("2024-01-02 03:04:05.5"),
            &s("2024-01-02 03:04:05.6")
        ));
        // DATETIME(0) と timestamp(6) の小数秒 0。
        assert!(eq(
            &t,
            &s("2024-01-02 03:04:05"),
            &s("2024-01-02 03:04:05.000000")
        ));
        // 日付だけの SQLite 値は 0 時とみなす。
        assert!(eq(&t, &s("2024-01-02"), &s("2024-01-02 00:00:00")));
        // 解釈できない値は元のまま (一致扱いにしない)。
        assert!(!eq(&t, &s("not a date"), &s("2024-01-02 00:00:00")));
    }

    #[test]
    fn timestamptz_golden() {
        let t = TransferType::TimestampTz;
        // PostgreSQL の timestamptz 出力 (+09) と UTC 表記。
        assert!(eq(
            &t,
            &s("2024-01-02 12:04:05+09"),
            &s("2024-01-02 03:04:05+00")
        ));
        assert!(eq(
            &t,
            &s("2024-01-02T12:04:05+09:00"),
            &s("2024-01-02 03:04:05Z")
        ));
        assert!(eq(
            &t,
            &s("2024-01-01 22:34:05-0430"),
            &s("2024-01-02 03:04:05+00:00")
        ));
        // オフセット無しは UTC とみなす (縮退として Callout に出す)。
        assert!(eq(
            &t,
            &s("2024-01-02 03:04:05"),
            &s("2024-01-02 03:04:05+00")
        ));
        assert!(!eq(
            &t,
            &s("2024-01-02 03:04:05+01"),
            &s("2024-01-02 03:04:05+00")
        ));
        // 日付をまたぐオフセット。
        assert!(eq(
            &t,
            &s("2024-01-01 23:00:00-02"),
            &s("2024-01-02 01:00:00")
        ));
    }

    #[test]
    fn date_and_time_golden() {
        assert!(eq(
            &TransferType::Date,
            &s("2024-01-02"),
            &s("2024-01-02 00:00:00")
        ));
        assert!(!eq(&TransferType::Date, &s("2024-01-02"), &s("2024-01-03")));
        assert!(eq(&TransferType::Time, &s("03:04:05"), &s("03:04:05.000")));
        assert!(!eq(&TransferType::Time, &s("03:04:05"), &s("03:04:06")));
    }

    #[test]
    fn json_golden() {
        let j = TransferType::Json;
        assert!(eq(
            &j,
            &s(r#"{"a": 1, "b": [1, 2]}"#),
            &s(r#"{"b":[1,2],"a":1}"#)
        ));
        assert!(!eq(&j, &s(r#"{"a":1}"#), &s(r#"{"a":2}"#)));
        // 配列の順序は意味を持つ。
        assert!(!eq(&j, &s("[1,2]"), &s("[2,1]")));
        // 壊れた JSON は元の文字列のまま。
        assert!(!eq(&j, &s("{"), &s("{ ")));
    }

    #[test]
    fn uuid_and_binary_golden() {
        assert!(eq(
            &TransferType::Uuid,
            &s("A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11"),
            &s("a0eebc999c0b4ef8bb6d6bb9bd380a11")
        ));
        assert!(eq(
            &TransferType::Binary,
            &Value::Bytes("DEADBEEF".into()),
            &Value::Bytes("deadbeef".into())
        ));
    }

    #[test]
    fn reconcile_golden() {
        use TransferType as T;
        let dec = T::Decimal {
            precision: None,
            scale: None,
        };
        assert_eq!(reconcile(Some(&T::Integer), Some(&T::Boolean)), T::Boolean);
        assert_eq!(reconcile(Some(&T::Boolean), Some(&T::Integer)), T::Boolean);
        assert_eq!(
            reconcile(Some(&T::Integer), Some(&T::UnsignedBigInt)),
            T::Integer
        );
        assert_eq!(reconcile(Some(&T::Integer), Some(&dec)), dec);
        assert_eq!(reconcile(Some(&dec), Some(&T::Float)), T::Float);
        assert_eq!(
            reconcile(Some(&T::Timestamp), Some(&T::TimestampTz)),
            T::TimestampTz
        );
        assert_eq!(reconcile(Some(&T::Text), Some(&T::Json)), T::Json);
        assert_eq!(reconcile(Some(&T::Timestamp), Some(&T::Text)), T::Timestamp);
        assert_eq!(reconcile(None, Some(&T::Date)), T::Date);
        assert_eq!(reconcile(None, None), T::Text);
        // 噛み合わない型は生の等価比較 (Text) に倒す。
        assert_eq!(reconcile(Some(&T::Binary), Some(&T::Integer)), T::Text);
    }

    fn cols(names: &[&str]) -> Vec<String> {
        names.iter().map(|c| c.to_string()).collect()
    }

    #[test]
    fn build_norms_reports_mysql_to_postgres_columns() {
        let columns = cols(&["id", "flag", "price", "at", "doc", "name"]);
        let mysql = cols(&[
            "bigint",
            "tinyint(1)",
            "decimal(10,2)",
            "datetime(6)",
            "json",
            "varchar(20)",
        ]);
        let pg = cols(&[
            "bigint",
            "boolean",
            "numeric(10,2)",
            "timestamp without time zone",
            "jsonb",
            "character varying(20)",
        ]);
        let (norms, report) = build_norms(
            DriverKind::Mysql,
            DriverKind::Postgres,
            &columns,
            &mysql,
            &pg,
            &[],
        );
        assert_eq!(norms.types[0], TransferType::Integer);
        assert_eq!(norms.types[1], TransferType::Boolean);
        assert!(matches!(norms.types[2], TransferType::Decimal { .. }));
        assert_eq!(norms.types[3], TransferType::Timestamp);
        assert_eq!(norms.types[4], TransferType::Json);
        assert_eq!(norms.types[5], TransferType::Text);
        let kinds: Vec<(&str, NormalizeKind)> =
            report.iter().map(|r| (r.column.as_str(), r.kind)).collect();
        assert_eq!(
            kinds,
            vec![
                ("flag", NormalizeKind::Boolean),
                ("price", NormalizeKind::DecimalScale),
                ("at", NormalizeKind::TimestampFormat),
                ("doc", NormalizeKind::Json),
            ]
        );
    }

    #[test]
    fn build_norms_reports_lossy_from_transfer_rules() {
        let columns = cols(&["at", "amount", "wide"]);
        let pg = cols(&["timestamp with time zone", "numeric(20,2)", "numeric(70,2)"]);
        let sqlite = cols(&["TEXT", "NUMERIC", "NUMERIC"]);
        let (norms, report) = build_norms(
            DriverKind::Postgres,
            DriverKind::Sqlite,
            &columns,
            &pg,
            &sqlite,
            &[],
        );
        let _ = &norms;
        let has = |c: &str, k: NormalizeKind| report.iter().any(|r| r.column == c && r.kind == k);
        assert!(has("at", NormalizeKind::TimestampTzDegraded));
        assert!(!has("at", NormalizeKind::TimestampFormat));
        // numeric(20,2) は SQLite で 15 桁を超えるので float 化の注意。
        assert!(has("amount", NormalizeKind::DecimalFloat));
        assert!(has("wide", NormalizeKind::DecimalFloat));

        // MySQL が相手なら 65 桁を超える decimal は丸めの注意。
        let (_, report) = build_norms(
            DriverKind::Postgres,
            DriverKind::Mysql,
            &cols(&["wide"]),
            &cols(&["numeric(70,2)"]),
            &cols(&["decimal(65,2)"]),
            &[],
        );
        assert!(report
            .iter()
            .any(|r| r.kind == NormalizeKind::DecimalClamped));
    }

    #[test]
    fn build_norms_skips_ignored_columns_in_report() {
        let (_, report) = build_norms(
            DriverKind::Mysql,
            DriverKind::Postgres,
            &cols(&["flag"]),
            &cols(&["tinyint(1)"]),
            &cols(&["boolean"]),
            &cols(&["flag"]),
        );
        assert!(report.is_empty());
    }

    #[test]
    fn map_target_columns_golden() {
        let v = |xs: &[&str]| xs.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        // 完全一致を優先。
        assert_eq!(
            map_target_columns(&v(&["Id", "name"]), &v(&["id", "Id", "name"])),
            Ok(v(&["Id", "name"]))
        );
        // 完全一致が無く、大文字小文字を無視して 1 つに決まれば対応付ける。
        assert_eq!(
            map_target_columns(&v(&["Id", "NAME"]), &v(&["id", "name"])),
            Ok(v(&["id", "name"]))
        );
        // 候補が複数ならエラー。
        assert_eq!(
            map_target_columns(&v(&["Id"]), &v(&["id", "ID"])),
            Err(("Id".to_string(), v(&["id", "ID"])))
        );
        // 1 対 1: 使用済みのターゲット列へは対応付けない。
        assert_eq!(
            map_target_columns(&v(&["id", "ID"]), &v(&["id"])),
            Err(("ID".to_string(), v(&["id"])))
        );
        assert_eq!(
            map_target_columns(&v(&["ID", "Id"]), &v(&["id"])),
            Err(("Id".to_string(), v(&["id"])))
        );
        // 当たらない列はそのまま (欠落は別の検証が報告する)。
        assert_eq!(map_target_columns(&v(&["x"]), &v(&["y"])), Ok(v(&["x"])));
    }

    #[test]
    fn key_is_integer_golden() {
        let n = CompareNorms {
            types: vec![TransferType::Integer],
            target_columns: Vec::new(),
            target_pk: Vec::new(),
        };
        assert!(n.key_is_integer(0, &Value::Int(1)));
        assert!(n.key_is_integer(0, &s("9007199254740993")));
        assert!(n.key_is_integer(0, &Value::Float(3.0)));
        assert!(!n.key_is_integer(0, &Value::Float(3.5)));
        assert!(!n.key_is_integer(0, &s("abc")));
    }

    #[test]
    fn identity_norms_leave_values_untouched() {
        let n = CompareNorms::identity(1);
        assert_eq!(n.normalize(0, &s("1.10")), s("1.10"));
        assert_eq!(n.normalize(5, &Value::Int(1)), Value::Int(1));
    }
}
