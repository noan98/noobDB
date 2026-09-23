//! 列データプロファイリング (「列を探索」、#974)。
//!
//! 1 列について NULL 率 / DISTINCT 数 / MIN・MAX / 上位頻出値 / (数値列のみ)
//! ヒストグラムを**サーバ側で全件集計**する。取得済み行だけを見る
//! `gridStats.ts::columnStats` (#524) と違い、テーブル全体が対象。
//!
//! ## 構成
//!
//! - `build_*_sql` は**副作用のない純関数**で、ドライバ方言ごとの集計 SQL を返す。
//!   識別子は必ず [`quote_ident`] でクオートし (埋め込みクオート文字は二重化)、
//!   生成する SQL はすべて単一の SELECT — 読み取り専用セッションでも実行でき、
//!   `is_read_only_sql_for` を通ることを単体テストで固定している。
//! - [`run_column_profile`] が `Connection::execute` 経由でそれらを流し、結果を
//!   [`ColumnProfile`] に整形する。**各段は独立に縮退する**: 型の都合で
//!   `COUNT(DISTINCT)` / `MIN` / `GROUP BY` が通らない列 (MSSQL の `text` /
//!   `image`、PostgreSQL の `json` など) でも、失敗した段だけを理由コード
//!   (`notes`) 付きで欠落させ、件数と NULL 率は必ず返す。
//!
//! ## 近似 DISTINCT
//!
//! `approximate = true` のとき、使えるドライバでは全件の `COUNT(DISTINCT)` を
//! 避ける。PostgreSQL は `pg_stats.n_distinct` (ANALYZE 済みの統計、走査なし)、
//! DuckDB は `approx_count_distinct` (HyperLogLog)。統計が無い / 非対応ドライバは
//! 正確値にフォールバックし、その旨を `notes` に残す (黙って別物を返さない)。
//!
//! ## 64bit 値
//!
//! 件数はすべて [`Value::from_u64_lossless`] で返す (2^53 を超えると十進文字列)。
//! MIN/MAX と上位値の値はドライバのデコード (`from_*_lossless` 済み) をそのまま
//! 通すので、巨大な BIGINT が丸められることはない。

use serde::{Deserialize, Serialize};

use super::sync::quote_ident;
use super::types::Value;
use super::{Connection, DriverKind};
use crate::error::{AppError, Result};

/// 上位頻出値の既定件数と上限。
pub const DEFAULT_TOP_N: u32 = 10;
const MAX_TOP_N: u32 = 100;
/// ヒストグラムの区間数。
pub const HISTOGRAM_BUCKETS: u32 = 20;

/// 縮退理由コード (フロントがヘルプ文言にマップする)。
pub const NOTE_STATS_UNAVAILABLE: &str = "stats_unavailable";
pub const NOTE_TOP_VALUES_UNAVAILABLE: &str = "top_values_unavailable";
pub const NOTE_HISTOGRAM_UNAVAILABLE: &str = "histogram_unavailable";
pub const NOTE_APPROX_UNSUPPORTED: &str = "approx_distinct_unsupported";
pub const NOTE_APPROX_NO_STATS: &str = "approx_distinct_no_stats";

/// プロファイル対象の列。`database` は MySQL/MSSQL ではデータベース、
/// PostgreSQL/DuckDB ではスキーマ、SQLite では無視される (UI ツリーの規約と同じ)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileTarget<'a> {
    pub driver: DriverKind,
    pub database: &'a str,
    pub table: &'a str,
    pub column: &'a str,
}

/// DISTINCT 数の求め方。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DistinctMode {
    /// `COUNT(DISTINCT col)` (正確値。全件走査)。
    Exact,
    /// DuckDB の `approx_count_distinct(col)`。
    Approx,
    /// 集計 SQL では求めない (PostgreSQL の統計情報から別途推定する)。
    Skip,
}

/// 上位頻出値 1 件。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProfileValueCount {
    pub value: Value,
    pub count: Value,
}

/// ヒストグラムの 1 区間 `[lower, upper)` (最後の区間のみ上端を含む)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProfileHistogramBucket {
    pub lower: f64,
    pub upper: f64,
    pub count: Value,
}

/// 列プロファイルの結果。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ColumnProfile {
    pub column: String,
    pub data_type: String,
    /// 数値列か (ヒストグラムの対象か)。
    pub numeric: bool,
    pub total_count: Value,
    pub non_null_count: Value,
    pub null_count: Value,
    /// DISTINCT 数 (NULL を除く)。求められなかったときは `None`。
    pub distinct_count: Option<Value>,
    /// `distinct_count` が近似値か。
    pub distinct_approximate: bool,
    pub min_value: Value,
    pub max_value: Value,
    /// 非 NULL 値の出現頻度の上位 (多い順)。
    pub top_values: Vec<ProfileValueCount>,
    /// 数値列のみ。区間は昇順・欠番なし (0 件の区間も含む)。
    pub histogram: Vec<ProfileHistogramBucket>,
    /// 縮退理由コード (`NOTE_*`)。
    pub notes: Vec<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// 純関数: 型判定と SQL 生成
// ─────────────────────────────────────────────────────────────────────────────

/// 列の宣言型が数値 (ヒストグラム対象) か。`int` の部分一致で `interval` /
/// `point` を拾わないよう、SQLite 以外は基底型名の完全一致で判定する。SQLite は
/// 型名から列アフィニティを決める規則 (INT / REAL / FLOA / DOUB / NUMERIC /
/// DECIMAL を含むか) に従う。
pub fn is_numeric_type(driver: DriverKind, data_type: &str) -> bool {
    let t = data_type.trim().to_ascii_lowercase();
    if driver == DriverKind::Sqlite {
        return ["int", "real", "floa", "doub", "numeric", "decimal"]
            .iter()
            .any(|k| t.contains(k));
    }
    let base = t.split('(').next().unwrap_or_default().trim();
    let base = base
        .trim_end_matches(" zerofill")
        .trim_end_matches(" unsigned")
        .trim_end_matches(" signed")
        .trim();
    matches!(
        base,
        "tinyint"
            | "smallint"
            | "mediumint"
            | "int"
            | "integer"
            | "bigint"
            | "int2"
            | "int4"
            | "int8"
            | "hugeint"
            | "utinyint"
            | "usmallint"
            | "uinteger"
            | "ubigint"
            | "uhugeint"
            | "decimal"
            | "numeric"
            | "dec"
            | "fixed"
            | "float"
            | "float4"
            | "float8"
            | "double"
            | "double precision"
            | "real"
            | "money"
            | "smallmoney"
    )
}

/// テーブル参照をドライバ方言で修飾する (`cellEdit.ts::qualifiedTableRef` と同じ規約)。
/// SQLite はファイル単位なので名前空間を付けず、MSSQL は `db.dbo.table` の 3 部構成。
pub fn table_ref(t: &ProfileTarget<'_>) -> String {
    let table = quote_ident(t.driver, t.table);
    if t.driver == DriverKind::Sqlite || t.database.is_empty() {
        return table;
    }
    let db = quote_ident(t.driver, t.database);
    match t.driver {
        DriverKind::Mssql => format!("{db}.[dbo].{table}"),
        _ => format!("{db}.{table}"),
    }
}

/// 行数を数える集計関数。MSSQL の `COUNT` は INT (2^31 で桁あふれ) なので
/// `COUNT_BIG` を使う。
fn count_fn(driver: DriverKind) -> &'static str {
    match driver {
        DriverKind::Mssql => "COUNT_BIG",
        _ => "COUNT",
    }
}

/// 件数・DISTINCT・MIN/MAX を 1 行で返す集計 SQL。列の並びは
/// `total, non_null, [distinct,] min, max` で固定 (位置で読む)。
pub fn build_summary_sql(t: &ProfileTarget<'_>, distinct: DistinctMode) -> String {
    let col = quote_ident(t.driver, t.column);
    let count = count_fn(t.driver);
    let mut parts = vec![
        format!("{count}(*) AS total_count"),
        format!("{count}({col}) AS non_null_count"),
    ];
    match distinct {
        DistinctMode::Exact => parts.push(format!("{count}(DISTINCT {col}) AS distinct_count")),
        DistinctMode::Approx => {
            parts.push(format!("approx_count_distinct({col}) AS distinct_count"))
        }
        DistinctMode::Skip => {}
    }
    parts.push(format!("MIN({col}) AS min_value"));
    parts.push(format!("MAX({col}) AS max_value"));
    format!("SELECT {} FROM {}", parts.join(", "), table_ref(t))
}

/// 件数だけの集計 SQL (`build_summary_sql` が型の都合で通らないときの縮退先)。
pub fn build_count_sql(t: &ProfileTarget<'_>) -> String {
    let col = quote_ident(t.driver, t.column);
    let count = count_fn(t.driver);
    format!(
        "SELECT {count}(*) AS total_count, {count}({col}) AS non_null_count FROM {}",
        table_ref(t)
    )
}

/// 正確な DISTINCT 数だけを求める SQL (PostgreSQL で統計が無いときの縮退先)。
pub fn build_distinct_sql(t: &ProfileTarget<'_>) -> String {
    let col = quote_ident(t.driver, t.column);
    let count = count_fn(t.driver);
    format!(
        "SELECT {count}(DISTINCT {col}) AS distinct_count FROM {}",
        table_ref(t)
    )
}

/// 非 NULL 値の出現頻度の上位 `top_n` 件 (`value, freq` の 2 列、多い順)。
/// MSSQL は `LIMIT` が無いので `TOP (n)`。
pub fn build_top_values_sql(t: &ProfileTarget<'_>, top_n: u32) -> String {
    let col = quote_ident(t.driver, t.column);
    let count = count_fn(t.driver);
    let n = top_n.clamp(1, MAX_TOP_N);
    let from = table_ref(t);
    match t.driver {
        DriverKind::Mssql => format!(
            "SELECT TOP ({n}) {col} AS value, {count}(*) AS freq FROM {from} \
             WHERE {col} IS NOT NULL GROUP BY {col} ORDER BY {count}(*) DESC"
        ),
        _ => format!(
            "SELECT {col} AS value, {count}(*) AS freq FROM {from} \
             WHERE {col} IS NOT NULL GROUP BY {col} ORDER BY {count}(*) DESC LIMIT {n}"
        ),
    }
}

/// 浮動小数を全方言で通る数値リテラルにする (`1.5e0` 形式。負数は括弧で包み、
/// `- -1` が MySQL の `-- ` コメントと紛れないようにする)。
fn float_literal(v: f64) -> String {
    let s = format!("{v:e}");
    if v < 0.0 {
        format!("({s})")
    } else {
        s
    }
}

/// 数値列のヒストグラム SQL (`bucket, freq` の 2 列、区間番号の昇順)。区間は
/// `[min, max]` を `buckets` 等分し、`max` ちょうどの値は最後の区間に入れる。
/// 区間番号は派生表で求めてから GROUP BY する (MSSQL は GROUP BY に別名を
/// 書けないため、全方言で同じ形にそろえる)。`min < max` かつ有限であることは
/// 呼び出し側が保証する。
pub fn build_histogram_sql(t: &ProfileTarget<'_>, min: f64, max: f64, buckets: u32) -> String {
    let col = quote_ident(t.driver, t.column);
    let count = count_fn(t.driver);
    let n = buckets.max(1);
    let scale = f64::from(n) / (max - min);
    let offset = format!(
        "({col} - {}) * {}",
        float_literal(min),
        float_literal(scale)
    );
    // SQLite の FLOOR は数学関数拡張が無いと使えないため CAST で切り捨てる
    // (offset は非負なので切り捨て = 床関数)。
    let floor = match t.driver {
        DriverKind::Sqlite => format!("CAST({offset} AS INTEGER)"),
        _ => format!("FLOOR({offset})"),
    };
    let last = n - 1;
    // SQLite は数値アフィニティ列にも文字列が入りうるので数値だけを数える。
    let numeric_only = match t.driver {
        DriverKind::Sqlite => format!(" AND typeof({col}) IN ('integer', 'real')"),
        _ => String::new(),
    };
    format!(
        "SELECT bucket, {count}(*) AS freq FROM (\
         SELECT CASE WHEN {col} >= {max_lit} THEN {last} ELSE {floor} END AS bucket \
         FROM {from} WHERE {col} IS NOT NULL{numeric_only}\
         ) profile_buckets GROUP BY bucket ORDER BY bucket",
        max_lit = float_literal(max),
        from = table_ref(t),
    )
}

/// PostgreSQL の統計情報 (`pg_stats.n_distinct`) を読む SQL。正の値は DISTINCT 数
/// そのもの、負の値は「行数に対する比率 × -1」(PostgreSQL の定義)。
pub fn build_pg_distinct_estimate_sql(schema: &str, table: &str, column: &str) -> String {
    let lit = |s: &str| format!("'{}'", s.replace('\'', "''"));
    format!(
        "SELECT n_distinct FROM pg_stats WHERE schemaname = {} AND tablename = {} AND attname = {}",
        lit(schema),
        lit(table),
        lit(column)
    )
}

/// `n_distinct` と総行数から DISTINCT 数の推定値を求める。
pub fn pg_distinct_estimate(n_distinct: f64, total_rows: u64) -> Option<u64> {
    if !n_distinct.is_finite() || n_distinct == 0.0 {
        return None;
    }
    let est = if n_distinct > 0.0 {
        n_distinct
    } else {
        -n_distinct * total_rows as f64
    };
    Some(est.round().max(0.0) as u64)
}

/// 要求された近似モードとドライバから DISTINCT の求め方を決める。2 つ目は
/// 「近似を求められたが使えない」ときの理由コード。
pub fn distinct_mode(
    driver: DriverKind,
    approximate: bool,
) -> (DistinctMode, Option<&'static str>) {
    if !approximate {
        return (DistinctMode::Exact, None);
    }
    match driver {
        DriverKind::Postgres => (DistinctMode::Skip, None),
        DriverKind::DuckDb => (DistinctMode::Approx, None),
        DriverKind::Mysql | DriverKind::Sqlite | DriverKind::Mssql => {
            (DistinctMode::Exact, Some(NOTE_APPROX_UNSUPPORTED))
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 純関数: 結果の整形
// ─────────────────────────────────────────────────────────────────────────────

/// 集計結果の件数セルを u64 に読む (ドライバにより Int / UInt / 文字列 / 浮動小数)。
pub fn value_as_u64(v: &Value) -> Option<u64> {
    match v {
        Value::Int(i) => u64::try_from(*i).ok(),
        Value::UInt(u) => Some(*u),
        Value::Float(f) if f.is_finite() && *f >= 0.0 => Some(f.round() as u64),
        Value::String(s) => s.trim().parse::<u64>().ok().or_else(|| {
            s.trim()
                .parse::<f64>()
                .ok()
                .filter(|f| f.is_finite() && *f >= 0.0)
                .map(|f| f.round() as u64)
        }),
        _ => None,
    }
}

/// MIN/MAX などの数値セルを f64 に読む (DECIMAL は文字列で届く)。
pub fn value_as_f64(v: &Value) -> Option<f64> {
    let f = match v {
        Value::Int(i) => *i as f64,
        Value::UInt(u) => *u as f64,
        Value::Float(f) => *f,
        Value::String(s) => s.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    f.is_finite().then_some(f)
}

/// ヒストグラム SQL の結果 (`bucket, freq`) を欠番なしの区間列にする。範囲外の
/// 区間番号は端の区間へ寄せる (浮動小数の丸めで `-0` や `n` が出うるため)。
pub fn histogram_from_rows(
    rows: &[Vec<Value>],
    min: f64,
    max: f64,
    buckets: u32,
) -> Vec<ProfileHistogramBucket> {
    let n = buckets.max(1) as usize;
    let mut counts = vec![0u64; n];
    for row in rows {
        let (Some(b), Some(c)) = (
            row.first().and_then(value_as_f64),
            row.get(1).and_then(value_as_u64),
        ) else {
            continue;
        };
        let idx = (b.max(0.0) as usize).min(n - 1);
        counts[idx] = counts[idx].saturating_add(c);
    }
    let width = (max - min) / n as f64;
    counts
        .into_iter()
        .enumerate()
        .map(|(i, c)| ProfileHistogramBucket {
            lower: min + width * i as f64,
            upper: if i + 1 == n {
                max
            } else {
                min + width * (i + 1) as f64
            },
            count: Value::from_u64_lossless(c),
        })
        .collect()
}

/// 上位頻出値 SQL の結果 (`value, freq`) を整形する。
pub fn top_values_from_rows(rows: &[Vec<Value>]) -> Vec<ProfileValueCount> {
    rows.iter()
        .filter_map(|row| {
            let value = row.first()?.clone();
            let count = row.get(1).and_then(value_as_u64)?;
            Some(ProfileValueCount {
                value,
                count: Value::from_u64_lossless(count),
            })
        })
        .collect()
}

// ─────────────────────────────────────────────────────────────────────────────
// 実行
// ─────────────────────────────────────────────────────────────────────────────

/// 1 列をプロファイルする。書き込みは一切行わない (read_only セッションでも可)。
pub async fn run_column_profile(
    conn: &Connection,
    database: &str,
    table: &str,
    column: &str,
    approximate: bool,
    top_n: u32,
) -> Result<ColumnProfile> {
    if table.trim().is_empty() || column.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "table and column are required".into(),
        ));
    }
    let driver = conn.driver_kind();
    // 列の実在確認と型の取得。存在しない列名で集計 SQL を組まない (識別子は
    // クオートするので注入にはならないが、エラーを分かりやすくする)。
    let columns = conn.columns(database, table).await?;
    let info = columns
        .iter()
        .find(|c| c.name == column)
        .or_else(|| columns.iter().find(|c| c.name.eq_ignore_ascii_case(column)))
        .ok_or_else(|| AppError::InvalidInput(format!("unknown column: {column}")))?;
    let column = info.name.as_str();
    let numeric = is_numeric_type(driver, &info.data_type);
    let target = ProfileTarget {
        driver,
        database,
        table,
        column,
    };
    let mut notes: Vec<String> = Vec::new();

    // ── 件数 / DISTINCT / MIN・MAX ──
    let (mode, approx_note) = distinct_mode(driver, approximate);
    if let Some(n) = approx_note {
        notes.push(n.to_string());
    }
    let (total, non_null, mut distinct, min_value, max_value) =
        match conn.execute(&build_summary_sql(&target, mode), None).await {
            Ok(res) => {
                let row = res.rows.into_iter().next().unwrap_or_default();
                let get = |i: usize| row.get(i).cloned().unwrap_or(Value::Null);
                let has_distinct = mode != DistinctMode::Skip;
                let base = if has_distinct { 3 } else { 2 };
                (
                    value_as_u64(&get(0)).unwrap_or(0),
                    value_as_u64(&get(1)).unwrap_or(0),
                    if has_distinct {
                        value_as_u64(&get(2))
                    } else {
                        None
                    },
                    get(base),
                    get(base + 1),
                )
            }
            Err(_) => {
                // 型の都合で DISTINCT / MIN / MAX が通らない列 (PostgreSQL の
                // boolean は MIN/MAX を持たない、MSSQL の text は比較不能など)。
                // 件数は必ず返し、DISTINCT だけでも通るなら拾う。
                let res = conn.execute(&build_count_sql(&target), None).await?;
                let row = res.rows.into_iter().next().unwrap_or_default();
                notes.push(NOTE_STATS_UNAVAILABLE.to_string());
                let distinct = if mode == DistinctMode::Skip {
                    None
                } else {
                    conn.execute(&build_distinct_sql(&target), None)
                        .await
                        .ok()
                        .and_then(|r| r.rows.into_iter().next())
                        .and_then(|row| row.first().and_then(value_as_u64))
                };
                (
                    row.first().and_then(value_as_u64).unwrap_or(0),
                    row.get(1).and_then(value_as_u64).unwrap_or(0),
                    distinct,
                    Value::Null,
                    Value::Null,
                )
            }
        };
    let stats_ok = !notes.iter().any(|n| n == NOTE_STATS_UNAVAILABLE);
    // 縮退経路 (件数のみ + 正確な DISTINCT) に落ちたときは近似ではない。
    let mut distinct_approximate = mode == DistinctMode::Approx && stats_ok && distinct.is_some();

    // PostgreSQL の近似: 統計情報から推定し、無ければ正確値へ縮退する。
    if mode == DistinctMode::Skip {
        let est_sql = build_pg_distinct_estimate_sql(database, table, column);
        let estimate = conn
            .execute(&est_sql, None)
            .await
            .ok()
            .and_then(|r| r.rows.into_iter().next())
            .and_then(|row| row.first().and_then(value_as_f64))
            .and_then(|nd| pg_distinct_estimate(nd, total));
        match estimate {
            Some(est) => {
                // 推定値が非 NULL 件数を超えることはない。
                distinct = Some(est.min(non_null));
                distinct_approximate = true;
            }
            None => {
                notes.push(NOTE_APPROX_NO_STATS.to_string());
                distinct = conn
                    .execute(&build_distinct_sql(&target), None)
                    .await
                    .ok()
                    .and_then(|r| r.rows.into_iter().next())
                    .and_then(|row| row.first().and_then(value_as_u64));
            }
        }
    }

    // ── 上位頻出値 ──
    let top_values = if non_null == 0 {
        Vec::new()
    } else {
        match conn
            .execute(&build_top_values_sql(&target, top_n), None)
            .await
        {
            Ok(res) => top_values_from_rows(&res.rows),
            Err(_) => {
                notes.push(NOTE_TOP_VALUES_UNAVAILABLE.to_string());
                Vec::new()
            }
        }
    };

    // ── ヒストグラム (数値列のみ) ──
    let mut histogram = Vec::new();
    if numeric && non_null > 0 {
        match (value_as_f64(&min_value), value_as_f64(&max_value)) {
            (Some(lo), Some(hi)) if hi > lo => {
                let sql = build_histogram_sql(&target, lo, hi, HISTOGRAM_BUCKETS);
                match conn.execute(&sql, None).await {
                    Ok(res) => {
                        histogram = histogram_from_rows(&res.rows, lo, hi, HISTOGRAM_BUCKETS)
                    }
                    Err(_) => notes.push(NOTE_HISTOGRAM_UNAVAILABLE.to_string()),
                }
            }
            // 全値が同じ: 区間は 1 つで全件がそこに入る (追加の走査は不要)。
            (Some(lo), Some(hi)) if hi == lo => {
                histogram.push(ProfileHistogramBucket {
                    lower: lo,
                    upper: hi,
                    count: Value::from_u64_lossless(non_null),
                });
            }
            _ => notes.push(NOTE_HISTOGRAM_UNAVAILABLE.to_string()),
        }
    }

    Ok(ColumnProfile {
        column: column.to_string(),
        data_type: info.data_type.clone(),
        numeric,
        total_count: Value::from_u64_lossless(total),
        non_null_count: Value::from_u64_lossless(non_null),
        null_count: Value::from_u64_lossless(total.saturating_sub(non_null)),
        distinct_count: distinct.map(Value::from_u64_lossless),
        distinct_approximate,
        min_value,
        max_value,
        top_values,
        histogram,
        notes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::is_read_only_sql_for;

    const ALL: [DriverKind; 5] = [
        DriverKind::Mysql,
        DriverKind::Postgres,
        DriverKind::Sqlite,
        DriverKind::DuckDb,
        DriverKind::Mssql,
    ];

    fn target(driver: DriverKind) -> ProfileTarget<'static> {
        ProfileTarget {
            driver,
            database: "app",
            table: "users",
            column: "age",
        }
    }

    #[test]
    fn summary_sql_quotes_identifiers_per_dialect() {
        assert_eq!(
            build_summary_sql(&target(DriverKind::Mysql), DistinctMode::Exact),
            "SELECT COUNT(*) AS total_count, COUNT(`age`) AS non_null_count, \
             COUNT(DISTINCT `age`) AS distinct_count, MIN(`age`) AS min_value, \
             MAX(`age`) AS max_value FROM `app`.`users`"
        );
        assert_eq!(
            build_summary_sql(&target(DriverKind::Postgres), DistinctMode::Exact),
            "SELECT COUNT(*) AS total_count, COUNT(\"age\") AS non_null_count, \
             COUNT(DISTINCT \"age\") AS distinct_count, MIN(\"age\") AS min_value, \
             MAX(\"age\") AS max_value FROM \"app\".\"users\""
        );
    }

    #[test]
    fn sqlite_ignores_database_and_mssql_uses_three_part_name() {
        assert!(build_count_sql(&target(DriverKind::Sqlite)).ends_with("FROM \"users\""));
        let mssql = build_count_sql(&target(DriverKind::Mssql));
        assert!(mssql.ends_with("FROM [app].[dbo].[users]"), "{mssql}");
        // MSSQL の COUNT は INT で桁あふれするので COUNT_BIG。
        assert!(mssql.starts_with("SELECT COUNT_BIG(*)"), "{mssql}");
    }

    #[test]
    fn embedded_quote_characters_are_doubled() {
        let evil = |driver| ProfileTarget {
            driver,
            database: "d",
            table: "t",
            column: "a`b\"c]d",
        };
        assert!(build_count_sql(&evil(DriverKind::Mysql)).contains("`a``b\"c]d`"));
        assert!(build_count_sql(&evil(DriverKind::Postgres)).contains("\"a`b\"\"c]d\""));
        assert!(build_count_sql(&evil(DriverKind::Mssql)).contains("[a`b\"c]]d]"));
    }

    #[test]
    fn approx_distinct_uses_engine_specific_function() {
        let sql = build_summary_sql(&target(DriverKind::DuckDb), DistinctMode::Approx);
        assert!(sql.contains("approx_count_distinct(\"age\")"), "{sql}");
        let skip = build_summary_sql(&target(DriverKind::Postgres), DistinctMode::Skip);
        assert!(!skip.contains("DISTINCT"), "{skip}");
    }

    #[test]
    fn distinct_mode_degrades_where_unsupported() {
        assert_eq!(
            distinct_mode(DriverKind::Mysql, false),
            (DistinctMode::Exact, None)
        );
        assert_eq!(
            distinct_mode(DriverKind::Postgres, true),
            (DistinctMode::Skip, None)
        );
        assert_eq!(
            distinct_mode(DriverKind::DuckDb, true),
            (DistinctMode::Approx, None)
        );
        for d in [DriverKind::Mysql, DriverKind::Sqlite, DriverKind::Mssql] {
            assert_eq!(
                distinct_mode(d, true),
                (DistinctMode::Exact, Some(NOTE_APPROX_UNSUPPORTED))
            );
        }
    }

    #[test]
    fn top_values_sql_limits_per_dialect() {
        let my = build_top_values_sql(&target(DriverKind::Mysql), 5);
        assert!(my.ends_with("ORDER BY COUNT(*) DESC LIMIT 5"), "{my}");
        assert!(
            my.contains("WHERE `age` IS NOT NULL GROUP BY `age`"),
            "{my}"
        );
        let ms = build_top_values_sql(&target(DriverKind::Mssql), 5);
        assert!(
            ms.starts_with("SELECT TOP (5) [age] AS value, COUNT_BIG(*)"),
            "{ms}"
        );
        assert!(!ms.contains("LIMIT"), "{ms}");
        // 上限・下限でクランプする。
        assert!(build_top_values_sql(&target(DriverKind::Mysql), 0).ends_with("LIMIT 1"));
        assert!(build_top_values_sql(&target(DriverKind::Mysql), 10_000).ends_with("LIMIT 100"));
    }

    #[test]
    fn histogram_sql_shapes() {
        let pg = build_histogram_sql(&target(DriverKind::Postgres), -10.0, 10.0, 20);
        assert!(pg.contains("FLOOR((\"age\" - (-1e1)) * 1e0)"), "{pg}");
        assert!(pg.contains("WHEN \"age\" >= 1e1 THEN 19"), "{pg}");
        assert!(
            pg.contains(") profile_buckets GROUP BY bucket ORDER BY bucket"),
            "{pg}"
        );
        let lite = build_histogram_sql(&target(DriverKind::Sqlite), 0.0, 4.0, 4);
        assert!(
            lite.contains("CAST((\"age\" - 0e0) * 1e0 AS INTEGER)"),
            "{lite}"
        );
        assert!(
            lite.contains("typeof(\"age\") IN ('integer', 'real')"),
            "{lite}"
        );
        // MySQL の `-- ` コメントと紛れる並びを作らない。
        let my = build_histogram_sql(&target(DriverKind::Mysql), -1.0, 1.0, 2);
        assert!(!my.contains("--"), "{my}");
    }

    #[test]
    fn every_generated_statement_is_read_only() {
        for d in ALL {
            let t = target(d);
            let mut sqls = vec![
                build_summary_sql(&t, DistinctMode::Exact),
                build_summary_sql(&t, DistinctMode::Approx),
                build_summary_sql(&t, DistinctMode::Skip),
                build_count_sql(&t),
                build_distinct_sql(&t),
                build_top_values_sql(&t, 10),
                build_histogram_sql(&t, -3.5, 1e12, HISTOGRAM_BUCKETS),
            ];
            if d == DriverKind::Postgres {
                sqls.push(build_pg_distinct_estimate_sql("public", "users", "age"));
            }
            for sql in sqls {
                assert!(is_read_only_sql_for(d, &sql), "{d:?}: {sql}");
            }
        }
    }

    #[test]
    fn pg_estimate_sql_escapes_literals() {
        let sql = build_pg_distinct_estimate_sql("pub'lic", "t", "c");
        assert!(sql.contains("schemaname = 'pub''lic'"), "{sql}");
    }

    #[test]
    fn pg_distinct_estimate_handles_ratio_and_absolute() {
        assert_eq!(pg_distinct_estimate(42.0, 1000), Some(42));
        assert_eq!(pg_distinct_estimate(-0.5, 1000), Some(500));
        assert_eq!(pg_distinct_estimate(-1.0, 7), Some(7));
        assert_eq!(pg_distinct_estimate(0.0, 1000), None);
        assert_eq!(pg_distinct_estimate(f64::NAN, 1000), None);
    }

    #[test]
    fn numeric_type_detection() {
        for t in [
            "int",
            "INT(11)",
            "bigint unsigned",
            "decimal(10,2)",
            "double precision",
            "numeric",
            "real",
            "HUGEINT",
            "money",
        ] {
            assert!(is_numeric_type(DriverKind::Mysql, t), "{t}");
        }
        for t in [
            "interval",
            "point",
            "varchar(20)",
            "integer[]",
            "bit",
            "text",
            "date",
        ] {
            assert!(!is_numeric_type(DriverKind::Postgres, t), "{t}");
        }
        assert!(is_numeric_type(DriverKind::Sqlite, "UNSIGNED BIG INT"));
        assert!(is_numeric_type(DriverKind::Sqlite, "FLOAT"));
        assert!(!is_numeric_type(DriverKind::Sqlite, "TEXT"));
    }

    #[test]
    fn value_readers_accept_driver_variants() {
        assert_eq!(value_as_u64(&Value::Int(5)), Some(5));
        assert_eq!(value_as_u64(&Value::Int(-1)), None);
        assert_eq!(value_as_u64(&Value::UInt(7)), Some(7));
        assert_eq!(
            value_as_u64(&Value::String("18446744073709551615".into())),
            Some(u64::MAX)
        );
        assert_eq!(value_as_u64(&Value::String("12.0".into())), Some(12));
        assert_eq!(value_as_u64(&Value::Null), None);
        assert_eq!(value_as_f64(&Value::String("1.25".into())), Some(1.25));
        assert_eq!(value_as_f64(&Value::Float(f64::INFINITY)), None);
    }

    #[test]
    fn histogram_rows_fill_gaps_and_clamp() {
        let rows = vec![
            vec![Value::Int(0), Value::Int(3)],
            vec![Value::Float(2.0), Value::Int(1)],
            // 丸めで範囲外に出た区間番号は端へ寄せる。
            vec![Value::Int(9), Value::Int(2)],
            vec![Value::Null, Value::Int(99)],
        ];
        let h = histogram_from_rows(&rows, 0.0, 4.0, 4);
        let counts: Vec<_> = h.iter().map(|b| b.count.clone()).collect();
        assert_eq!(
            counts,
            vec![
                Value::UInt(3),
                Value::UInt(0),
                Value::UInt(1),
                Value::UInt(2)
            ]
        );
        assert_eq!(h[0].lower, 0.0);
        assert_eq!(h[3].upper, 4.0);
        assert_eq!(h[1].lower, 1.0);
    }

    #[test]
    fn top_values_keep_value_and_make_counts_lossless() {
        let big = Value::String("9007199254740993".into());
        let rows = vec![
            vec![big.clone(), Value::String("9007199254740993".into())],
            vec![Value::String("x".into()), Value::Int(2)],
            vec![Value::String("bad".into())],
        ];
        let top = top_values_from_rows(&rows);
        assert_eq!(top.len(), 2);
        assert_eq!(top[0].value, big);
        // 2^53 を超える件数は文字列のまま (JS で丸めない)。
        assert_eq!(top[0].count, Value::String("9007199254740993".into()));
        assert_eq!(top[1].count, Value::UInt(2));
    }
}
