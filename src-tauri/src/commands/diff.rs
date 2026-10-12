//! Schema & data comparison commands.

use std::collections::HashMap;

use tauri::State;

use crate::db::data_diff::{compute_data_diff, DataDiff};
use crate::db::diff::{compute_schema_diff, SchemaDiff, TableColumns};
use crate::db::sync::quote_ident;
use crate::db::types::{generated_column_names, TableColumnInfo, Value};
use crate::db::{Connection, DriverKind};
use crate::error::{AppError, Result};
use crate::state::AppState;

/// Hard cap on rows read per side for a data comparison. Data sync targets
/// master / configuration tables; bulk tables are out of scope and would make
/// the diff (and the generated DML) unwieldy. `pub(crate)`: `commands::sandbox`
/// applies the same cap to its (structurally identical) desired/conflict diffs.
pub(crate) const MAX_DATA_ROWS: usize = 5000;
pub(crate) const DEFAULT_DATA_ROWS: usize = 1000;

/// Fetches every table in `db` paired with its full column metadata. The
/// columns of the whole database come from one `columns_for_database` round trip
/// (#1255) instead of one `columns` call per table. The table set and order
/// still follow `tables`, so tables the column catalog does not list (e.g.
/// PostgreSQL materialized views) keep appearing with an empty column list, as
/// the per-table loop used to produce.
pub(crate) async fn collect_table_columns(
    conn: &Connection,
    db: &str,
) -> Result<Vec<TableColumns>> {
    let tables = conn.tables(db).await?;
    let mut by_table: HashMap<String, Vec<TableColumnInfo>> = conn
        .columns_for_database(db)
        .await?
        .into_iter()
        .map(|t| (t.name, t.columns))
        .collect();
    Ok(tables
        .into_iter()
        .map(|name| TableColumns {
            columns: by_table.remove(&name).unwrap_or_default(),
            name,
        })
        .collect())
}

/// Compares the schema of `source_database` (on the source session) against
/// `target_database` (on the target session) and returns a per-table /
/// per-column diff. The two sessions may be the same — comparing two schemas on
/// one server is a valid use — but must use the same driver: cross-driver type
/// reconciliation is out of scope.
#[tauri::command]
pub async fn compare_schema(
    source_session_id: String,
    source_database: String,
    target_session_id: String,
    target_database: String,
    state: State<'_, AppState>,
) -> Result<SchemaDiff> {
    let source = state
        .get(&source_session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(source_session_id.clone()))?;
    let target = state
        .get(&target_session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(target_session_id.clone()))?;

    let source_driver = source.conn.driver_kind();
    let target_driver = target.conn.driver_kind();
    if source_driver != target_driver {
        return Err(AppError::InvalidInput(
            "schema comparison requires both connections to use the same driver".into(),
        ));
    }

    let source_tables = collect_table_columns(&source.conn, &source_database).await?;
    let target_tables = collect_table_columns(&target.conn, &target_database).await?;

    let mut diff =
        compute_schema_diff(source_driver, target_driver, &source_tables, &target_tables);
    // CREATE TABLE 同期が外部キーを出せるよう、source 側の制約を載せる。取得に失敗
    // しても比較自体は妨げない (FK 無しの CREATE になる)。
    if diff
        .tables
        .iter()
        .any(|t| t.status == crate::db::diff::DiffStatus::SourceOnly)
    {
        match source.conn.foreign_keys(&source_database).await {
            Ok(fks) => crate::db::diff::attach_source_foreign_keys(&mut diff, &fks),
            Err(e) => tracing::warn!(
                kind = e.kind(),
                "schema compare: could not load foreign keys of the source"
            ),
        }
    }
    // down マイグレーションの DROP TABLE を子 → 親の順に並べるため、target のみに
    // 存在する表の FK も載せる。
    if diff
        .tables
        .iter()
        .any(|t| t.status == crate::db::diff::DiffStatus::TargetOnly)
    {
        match target.conn.foreign_keys(&target_database).await {
            Ok(fks) => crate::db::diff::attach_target_foreign_keys(&mut diff, &fks),
            Err(e) => tracing::warn!(
                kind = e.kind(),
                "schema compare: could not load foreign keys of the target"
            ),
        }
    }
    Ok(diff)
}

/// Builds `SELECT <cols> FROM <table> ORDER BY <pk> LIMIT <n>` with identifiers
/// quoted for `driver`. The explicit column list (taken from the source) keeps
/// both sides' rows aligned even if column order differs. `pub(crate)`: reused
/// by `commands::sandbox` for its base/live/external row reads (same shape).
pub(crate) fn select_rows_sql(
    driver: DriverKind,
    table: &str,
    columns: &[String],
    primary_key: &[String],
    limit: usize,
) -> String {
    let cols = columns
        .iter()
        .map(|c| quote_ident(driver, c))
        .collect::<Vec<_>>()
        .join(", ");
    let order = primary_key
        .iter()
        .map(|c| quote_ident(driver, c))
        .collect::<Vec<_>>()
        .join(", ");
    let table = quote_ident(driver, table);
    format!("SELECT {cols} FROM {table} ORDER BY {order} LIMIT {limit}")
}

#[cfg(test)]
mod select_rows_sql_tests {
    use super::*;

    #[test]
    fn select_rows_sql_uses_limit_or_top_per_driver() {
        let cols = vec!["id".to_string(), "v".to_string()];
        let pk = vec!["id".to_string()];
        assert_eq!(
            select_rows_sql(DriverKind::Mysql, "t", &cols, &pk, 11),
            "SELECT `id`, `v` FROM `t` ORDER BY `id` LIMIT 11"
        );
        assert_eq!(
            select_rows_sql(DriverKind::Postgres, "t", &cols, &pk, 11),
            "SELECT \"id\", \"v\" FROM \"t\" ORDER BY \"id\" LIMIT 11"
        );
    }
}

/// 数値は数値同士、文字列は文字列同士、バイト列はバイト列同士で比較する。
/// 型が噛み合わない・NULL を含む場合は `None` (比較不能)。
fn cmp_value(a: &Value, b: &Value) -> Option<std::cmp::Ordering> {
    use std::cmp::Ordering;
    fn num(v: &Value) -> Option<f64> {
        match v {
            Value::Int(i) => Some(*i as f64),
            Value::UInt(u) => Some(*u as f64),
            Value::Float(f) => Some(*f),
            _ => None,
        }
    }
    // 2^53 超の BIGINT などは Value::String になるため、両側が整数として読めるなら
    // i128 で数値比較する (Int / UInt / String の混在を含む)。
    fn int(v: &Value) -> Option<i128> {
        match v {
            Value::Int(i) => Some(i128::from(*i)),
            Value::UInt(u) => Some(i128::from(*u)),
            Value::String(s) => s.trim().parse::<i128>().ok(),
            _ => None,
        }
    }
    if let (Some(x), Some(y)) = (int(a), int(b)) {
        return Some(x.cmp(&y));
    }
    match (a, b) {
        (Value::Int(x), Value::Int(y)) => Some(x.cmp(y)),
        (Value::UInt(x), Value::UInt(y)) => Some(x.cmp(y)),
        (Value::String(x), Value::String(y)) | (Value::Bytes(x), Value::Bytes(y)) => Some(x.cmp(y)),
        (Value::Bool(x), Value::Bool(y)) => Some(x.cmp(y)),
        _ => match (num(a), num(b)) {
            (Some(x), Some(y)) => x.partial_cmp(&y).or(Some(Ordering::Equal)),
            _ => None,
        },
    }
}

/// 主キー値の辞書順比較。比較不能な成分があれば `None`。
fn cmp_key(a: &[Value], b: &[Value]) -> Option<std::cmp::Ordering> {
    for (x, y) in a.iter().zip(b.iter()) {
        match cmp_value(x, y)? {
            std::cmp::Ordering::Equal => continue,
            o => return Some(o),
        }
    }
    Some(std::cmp::Ordering::Equal)
}

/// 行数上限で切り詰められた側があるとき、両側を「切り詰められた側の最後の PK」以下
/// の共通窓へ揃える。揃えないと、窓の外にある行が相手側で「存在しない」ことになり、
/// 実在する行の INSERT (主キー重複で適用失敗) や UPDATE が生成される。
/// 窓の外かどうか判定できない (キー比較不能の) 行は、安全側として落とす。
fn clamp_to_common_window(
    source: &mut Vec<Vec<Value>>,
    target: &mut Vec<Vec<Value>>,
    source_truncated: bool,
    target_truncated: bool,
    pk_idx: &[usize],
) {
    let key_of =
        |row: &Vec<Value>| -> Vec<Value> { pk_idx.iter().map(|&i| row[i].clone()).collect() };
    let mut cutoff: Option<Vec<Value>> = None;
    for (rows, truncated) in [(&*source, source_truncated), (&*target, target_truncated)] {
        if !truncated {
            continue;
        }
        let Some(last) = rows.last() else { continue };
        let k = key_of(last);
        cutoff = match cutoff {
            Some(c) if cmp_key(&k, &c) != Some(std::cmp::Ordering::Less) => Some(c),
            _ => Some(k),
        };
    }
    let Some(cutoff) = cutoff else { return };
    let within = |row: &Vec<Value>| {
        matches!(
            cmp_key(&key_of(row), &cutoff),
            Some(std::cmp::Ordering::Less | std::cmp::Ordering::Equal)
        )
    };
    source.retain(within);
    target.retain(within);
}

/// `compare_table_data` の結果。`diff` は表示用、`diff_id` は Rust 側のストア
/// (`AppState::data_diffs`) に保持した同じ差分の ID で、SQL 生成 (`generate_data_sync_sql`)
/// にはこの ID だけを送り返す (#1259)。不要になったら `release_data_diffs` で破棄する。
#[derive(Debug, serde::Serialize)]
pub struct DataDiffHandle {
    pub diff_id: String,
    pub diff: DataDiff,
}

/// Compares the rows of one `table` between the source and target databases,
/// pairing by primary key. Reads at most `limit` rows per side (clamped to a
/// master-data-sized cap); a table without a primary key is rejected since
/// there is nothing to pair on. Both connections must use the same driver.
#[tauri::command]
pub async fn compare_table_data(
    source_session_id: String,
    source_database: String,
    target_session_id: String,
    target_database: String,
    table: String,
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<DataDiffHandle> {
    let source = state
        .get(&source_session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(source_session_id.clone()))?;
    let target = state
        .get(&target_session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(target_session_id.clone()))?;

    let driver = source.conn.driver_kind();
    if driver != target.conn.driver_kind() {
        return Err(AppError::InvalidInput(
            "data comparison requires both connections to use the same driver".into(),
        ));
    }

    let col_info = source.conn.columns(&source_database, &table).await?;
    if col_info.is_empty() {
        return Err(AppError::InvalidInput(format!(
            "table '{table}' has no columns (does it exist on the source?)"
        )));
    }
    let columns: Vec<String> = col_info.iter().map(|c| c.name.clone()).collect();
    // `columns` と同じ並びの型名。修正3: BLOB 列が IPC 往復で Value::String に
    // 化けても、この型情報から Value::Bytes へ補正できるようにする
    // (`data_diff::generate_data_sync_sql` 参照)。
    let column_types: Vec<String> = col_info.iter().map(|c| c.data_type.clone()).collect();
    // 生成列は DB が値を計算するので、同期 SQL の INSERT / UPDATE から外す (#1521)。
    // ターゲット側だけが生成列のこともあるので、両側の和集合を除外する。ターゲットの
    // 列定義を取れなければ (テーブル未作成など) ソース側だけで判定する。
    let mut generated_columns = generated_column_names(&col_info);
    if let Ok(target_cols) = target.conn.columns(&target_database, &table).await {
        for name in generated_column_names(&target_cols) {
            if !generated_columns.contains(&name) {
                generated_columns.push(name);
            }
        }
    }
    let primary_key: Vec<String> = col_info
        .iter()
        .filter(|c| c.key.eq_ignore_ascii_case("PRI"))
        .map(|c| c.name.clone())
        .collect();
    if primary_key.is_empty() {
        return Err(AppError::InvalidInput(format!(
            "table '{table}' has no primary key; data sync needs one to pair rows"
        )));
    }
    let pk_idx: Vec<usize> = primary_key
        .iter()
        .filter_map(|name| columns.iter().position(|c| c == name))
        .collect();

    // Read one extra row to detect (and flag) truncation without exceeding it.
    let want = limit.unwrap_or(DEFAULT_DATA_ROWS).min(MAX_DATA_ROWS);
    let sql = select_rows_sql(driver, &table, &columns, &primary_key, want + 1);

    let source_res = source.conn.execute(&sql, Some(&source_database)).await?;
    let target_res = target.conn.execute(&sql, Some(&target_database)).await?;

    let truncated = source_res.rows.len() > want || target_res.rows.len() > want;
    let source_truncated = source_res.rows.len() > want;
    let target_truncated = target_res.rows.len() > want;
    let mut source_rows: Vec<_> = source_res.rows.into_iter().take(want).collect();
    let mut target_rows: Vec<_> = target_res.rows.into_iter().take(want).collect();
    // 片側だけ切り詰められたとき、もう一方の窓の外の行を「存在しない」と誤判定して
    // INSERT してしまわないよう、両側を共通の PK 窓に揃える。
    clamp_to_common_window(
        &mut source_rows,
        &mut target_rows,
        source_truncated,
        target_truncated,
        &pk_idx,
    );
    let source_count = source_rows.len();
    let target_count = target_rows.len();

    let rows = compute_data_diff(&columns, &pk_idx, &source_rows, &target_rows);

    let diff = DataDiff {
        target_driver: driver,
        table,
        columns,
        column_types,
        primary_key,
        rows,
        truncated,
        source_count,
        target_count,
        generated_columns,
    };
    let diff_id = state.store_data_diff(
        diff.clone(),
        vec![source_session_id.clone(), target_session_id.clone()],
    );
    Ok(DataDiffHandle { diff_id, diff })
}

#[cfg(test)]
mod window_tests {
    use super::*;

    fn rows(ids: &[i64]) -> Vec<Vec<Value>> {
        ids.iter().map(|i| vec![Value::Int(*i)]).collect()
    }

    fn ids(r: &[Vec<Value>]) -> Vec<i64> {
        r.iter()
            .map(|row| match row[0] {
                Value::Int(i) => i,
                _ => -1,
            })
            .collect()
    }

    #[test]
    fn one_side_truncated_clamps_other_side() {
        // limit=3: target は 5 行あり先頭 3 行 [1,2,3] に切り詰め。source の PK 4 は窓の外。
        let mut s = rows(&[1, 2, 4]);
        let mut t = rows(&[1, 2, 3]);
        clamp_to_common_window(&mut s, &mut t, false, true, &[0]);
        assert_eq!(ids(&s), vec![1, 2]);
        assert_eq!(ids(&t), vec![1, 2, 3]);
        let diff = compute_data_diff(&["id".to_string()], &[0], &s, &t);
        // 4 の INSERT は生成されない。
        assert!(diff
            .iter()
            .all(|d| d.status != crate::db::data_diff::RowStatus::SourceOnly));
    }

    #[test]
    fn both_truncated_uses_smaller_cutoff() {
        let mut s = rows(&[1, 2, 3]);
        let mut t = rows(&[1, 2, 5]);
        clamp_to_common_window(&mut s, &mut t, true, true, &[0]);
        assert_eq!(ids(&s), vec![1, 2, 3]);
        assert_eq!(ids(&t), vec![1, 2]);
    }

    #[test]
    fn integer_strings_are_compared_numerically() {
        let big = |n: i128| Value::String(n.to_string());
        assert_eq!(
            cmp_value(&big(9_007_199_254_740_993), &big(9_007_199_254_740_992)),
            Some(std::cmp::Ordering::Greater)
        );
        // 文字列比較だと "9" > "10" になってしまう。
        assert_eq!(cmp_value(&big(9), &big(10)), Some(std::cmp::Ordering::Less));
        assert_eq!(
            cmp_value(&Value::Int(5), &big(10)),
            Some(std::cmp::Ordering::Less)
        );
        let mut s = vec![vec![big(9_007_199_254_740_993)]];
        let mut t = vec![vec![Value::Int(5)]];
        clamp_to_common_window(&mut s, &mut t, false, true, &[0]);
        assert!(s.is_empty());
    }

    #[test]
    fn no_truncation_keeps_everything() {
        let mut s = rows(&[1, 9]);
        let mut t = rows(&[2]);
        clamp_to_common_window(&mut s, &mut t, false, false, &[0]);
        assert_eq!(ids(&s), vec![1, 9]);
        assert_eq!(ids(&t), vec![2]);
    }

    #[test]
    fn incomparable_keys_are_dropped_conservatively() {
        let mut s = vec![vec![Value::String("x".into())]];
        let mut t = rows(&[1]);
        clamp_to_common_window(&mut s, &mut t, false, true, &[0]);
        assert!(s.is_empty());
    }
}
