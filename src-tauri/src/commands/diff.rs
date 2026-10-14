//! Schema & data comparison commands.

use std::collections::HashMap;

use tauri::State;

use crate::db::data_diff::{
    compute_data_diff_ignoring, is_binary_type, is_hex_wire, is_numeric_literal, sql_literal,
    DataDiff, RowDiff,
};
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

// ── 全行比較 (キーセットページング, #1539) ──
/// 1 回に各側から読む行数。
const KEYSET_PAGE_ROWS: usize = 2000;
/// 片側あたり読む行数の上限。超えたら打ち切って `truncated` を立てる (DELETE を出さない)。
const KEYSET_MAX_SCAN_ROWS: usize = 5_000_000;
/// 保持する差分行数の上限 (ストア / IPC / 画面の都合)。超えたら打ち切って `truncated`。
const KEYSET_MAX_DIFF_ROWS: usize = 50_000;
/// 1 ページ分の範囲 (前回の最終キー, 今回の最終キー] で target 側から集める行数の上限。
const KEYSET_MAX_CHUNK_ROWS: usize = 100_000;

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
            Err(e) => {
                tracing::warn!(
                    kind = e.kind(),
                    "schema compare: could not load foreign keys of the target"
                );
                // SQLite は DROP TABLE が残る子表の CASCADE を発火させうるが、FK が
                // 取れないと判定できない。破壊的な計画の警告に出す。
                if target_driver == crate::db::DriverKind::Sqlite {
                    diff.warnings.push(
                        "target の外部キーを取得できなかったため、DROP TABLE が残る表の ON DELETE CASCADE / SET NULL で行を消さないか確認できていません。適用前に外部キーを確認してください"
                            .to_string(),
                    );
                }
            }
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
    // 主キーが無い表 (サンドボックスの取り込みなど) は ORDER BY を省く。全列で並べると、
    // json など順序演算子の無い型を含む表で SQL エラーになる。
    if order.is_empty() {
        return format!("SELECT {cols} FROM {table} LIMIT {limit}");
    }
    format!("SELECT {cols} FROM {table} ORDER BY {order} LIMIT {limit}")
}

/// キーセット述語用のキー 1 成分のリテラル。2^53 を超える整数は `Value::String` で来る
/// ので、整数型の列では引用符なしの数値で書く (MySQL は文字列定数と整数列を倍精度で
/// 比較するため、引用符付きだと下位桁が丸まって境界がずれる)。バイナリ列は
/// `Value::String` (16 進) を `Bytes` に戻して `X'..'` / `'\x..'` で書く。
fn key_literal(driver: DriverKind, column_type: &str, value: &Value) -> String {
    match value {
        Value::String(s) if is_binary_type(column_type) && is_hex_wire(s) => {
            sql_literal(driver, &Value::Bytes(s.clone()))
        }
        Value::String(s) if is_integer_type(column_type) && is_numeric_literal(s.trim()) => {
            s.trim().to_string()
        }
        other => sql_literal(driver, other),
    }
}

fn is_integer_type(column_type: &str) -> bool {
    let t = column_type.to_ascii_lowercase();
    t.contains("int") || t.contains("serial")
}

/// `(pk1, pk2) <op> (v1, v2)` (行値比較; MySQL / PostgreSQL / SQLite 3.15+)。単一キーは
/// 素の比較にする。
fn key_predicate(
    driver: DriverKind,
    primary_key: &[String],
    pk_types: &[String],
    op: &str,
    key: &[Value],
) -> String {
    let idents: Vec<String> = primary_key.iter().map(|c| quote_ident(driver, c)).collect();
    let lits: Vec<String> = key
        .iter()
        .zip(pk_types)
        .map(|(v, t)| key_literal(driver, t, v))
        .collect();
    if idents.len() == 1 {
        format!("{} {op} {}", idents[0], lits[0])
    } else if driver == DriverKind::Mysql {
        // MySQL の行値比較は索引を使えず全走査になりうるので、展開形
        // `a > x OR (a = x AND b > y)` で書く (`<=` は途中を `<`、最後だけ `<=`)。
        let strict = if op.starts_with('>') { ">" } else { "<" };
        let n = idents.len();
        let terms: Vec<String> = (0..n)
            .map(|i| {
                let o = if i + 1 == n { op } else { strict };
                let last = format!("{} {o} {}", idents[i], lits[i]);
                if i == 0 {
                    last
                } else {
                    let mut parts: Vec<String> = (0..i)
                        .map(|j| format!("{} = {}", idents[j], lits[j]))
                        .collect();
                    parts.push(last);
                    format!("({})", parts.join(" AND "))
                }
            })
            .collect();
        format!("({})", terms.join(" OR "))
    } else {
        format!("({}) {op} ({})", idents.join(", "), lits.join(", "))
    }
}

/// `SELECT <cols> FROM <t> [WHERE (pk) > (after) AND (pk) <= (upto)] ORDER BY <pk> LIMIT n`。
/// 前回の最終キーより後ろ (`after`) から、`upto` 以下までの行を主キー昇順で読む。
#[allow(clippy::too_many_arguments)]
fn keyset_select_sql(
    driver: DriverKind,
    table: &str,
    columns: &[String],
    primary_key: &[String],
    pk_types: &[String],
    after: Option<&[Value]>,
    upto: Option<&[Value]>,
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
    let mut conds: Vec<String> = Vec::new();
    if let Some(k) = after {
        conds.push(key_predicate(driver, primary_key, pk_types, ">", k));
    }
    if let Some(k) = upto {
        conds.push(key_predicate(driver, primary_key, pk_types, "<=", k));
    }
    let where_clause = if conds.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conds.join(" AND "))
    };
    let table = quote_ident(driver, table);
    format!("SELECT {cols} FROM {table}{where_clause} ORDER BY {order} LIMIT {limit}")
}

/// 相手側に同じ主キーの行が 1 件でもあるか (主キー等価検索。`LIMIT 1`)。見つかった行のキーを返す。
/// 照合順序が違う 2 つの DB では「ORDER BY の窓」で両側の同じ行が食い違い、片側だけの
/// 行に見えることがある。その行が実際は相手側にあるかを、相手側自身の等価比較で確かめる。
async fn any_key_exists(
    conn: &Connection,
    db: &str,
    table: &str,
    primary_key: &[String],
    pk_types: &[String],
    keys: &[&Vec<Value>],
) -> Result<Option<Vec<Value>>> {
    let driver = conn.driver_kind();
    let cols = primary_key
        .iter()
        .map(|c| quote_ident(driver, c))
        .collect::<Vec<_>>()
        .join(", ");
    let table = quote_ident(driver, table);
    for chunk in keys.chunks(200) {
        let terms: Vec<String> = chunk
            .iter()
            .map(|k| {
                let eqs: Vec<String> = primary_key
                    .iter()
                    .zip(pk_types)
                    .zip(k.iter())
                    .map(|((c, t), v)| {
                        format!("{} = {}", quote_ident(driver, c), key_literal(driver, t, v))
                    })
                    .collect();
                format!("({})", eqs.join(" AND "))
            })
            .collect();
        let sql = format!(
            "SELECT {cols} FROM {table} WHERE {} LIMIT 1",
            terms.join(" OR ")
        );
        if let Some(found) = conn.execute(&sql, Some(db)).await?.rows.into_iter().next() {
            return Ok(Some(found));
        }
    }
    Ok(None)
}

fn collation_mismatch_error(example: &[Value]) -> AppError {
    AppError::InvalidInput(format!(
        "the table cannot be compared in full: a primary key value is equal under the database's \
         collation but differs byte-for-byte (case, trailing spaces, ...), or the two sides use \
         different collations for the key. Example key: {example:?}. \
         Align the key collation on both sides"
    ))
}

/// 片側だけにあると判定された行が、相手側に主キー等価で実在しないことを確かめる
/// (照合順序の違いで DELETE / INSERT を誤って出さないための fail-closed 検査)。
async fn verify_one_sided(
    source: (&Connection, &str),
    target: (&Connection, &str),
    table: &str,
    primary_key: &[String],
    pk_types: &[String],
    rows: &[RowDiff],
    seen_target_only: &mut std::collections::HashSet<String>,
) -> Result<()> {
    use crate::db::data_diff::RowStatus;
    let target_only: Vec<&Vec<Value>> = rows
        .iter()
        .filter(|r| r.status == RowStatus::TargetOnly)
        .map(|r| &r.key)
        .collect();
    let source_only: Vec<&Vec<Value>> = rows
        .iter()
        .filter(|r| r.status == RowStatus::SourceOnly)
        .map(|r| &r.key)
        .collect();
    // 同じ target 行が 2 つの窓で TargetOnly になる = 両側の順序が食い違っている。
    // 保持数は差分の上限で頭打ちにする (上限に達すれば比較は打ち切られる)。
    for k in &target_only {
        let sig = format!("{k:?}");
        if seen_target_only.contains(&sig) {
            return Err(collation_mismatch_error(k));
        }
        if seen_target_only.len() < KEYSET_MAX_DIFF_ROWS {
            seen_target_only.insert(sig);
        }
    }
    if !target_only.is_empty() {
        if let Some(found) = any_key_exists(
            source.0,
            source.1,
            table,
            primary_key,
            pk_types,
            &target_only,
        )
        .await?
        {
            return Err(collation_mismatch_error(&found));
        }
    }
    if !source_only.is_empty() {
        if let Some(found) = any_key_exists(
            target.0,
            target.1,
            table,
            primary_key,
            pk_types,
            &source_only,
        )
        .await?
        {
            return Err(collation_mismatch_error(&found));
        }
    }
    Ok(())
}

/// 全行比較の結果。
#[derive(Debug)]
struct KeysetOutcome {
    rows: Vec<RowDiff>,
    source_count: usize,
    target_count: usize,
    /// 行数 / 差分数の上限で途中打ち切りになった (残りは未比較)。
    truncated: bool,
}

/// 両側の表をキーセットページングで最後まで比較する (#1539)。
///
/// 順序は**両側とも DB 自身の `ORDER BY pk`** に任せ、Rust 側ではキーの大小を比べない
/// (照合順序の違いで Rust の比較と食い違うのを避ける)。
/// 1. source から `key > 前回の最終キー` を `PAGE` 行読み、その最終キー B を境界にする。
/// 2. target から `前回 < key <= B` の行を (複数ページに分けて) 集める。
/// 3. 両方の窓を `compute_data_diff_ignoring` で突き合わせ、境界を B に進める。
///
/// source が尽きたら、残りの target 行 (`key > 前回`) は全部 TargetOnly になる。
///
/// 窓は常に両側で同じ範囲なので、片側だけ切り詰めたときのような窓ずれは起きない。
///
/// 主キーに NULL を含む行は行値比較で落ちて比較できないため、見つけたらエラーにする
/// (SQLite が非 INTEGER 主キーに許す NULL。黙って読み飛ばして「差分なし」にしない)。
#[allow(clippy::too_many_arguments)]
async fn keyset_compare(
    source: &Connection,
    source_db: &str,
    target: &Connection,
    target_db: &str,
    table: &str,
    columns: &[String],
    column_types: &[String],
    primary_key: &[String],
    pk_idx: &[usize],
    ignore_columns: &[String],
    page_rows: usize,
) -> Result<KeysetOutcome> {
    let driver = source.driver_kind();
    let pk_types: Vec<String> = pk_idx
        .iter()
        .map(|&i| column_types.get(i).cloned().unwrap_or_default())
        .collect();
    let key_of =
        |row: &Vec<Value>| -> Vec<Value> { pk_idx.iter().map(|&i| row[i].clone()).collect() };
    let check_key = |key: &[Value]| -> Result<()> {
        if key.iter().any(|v| matches!(v, Value::Null)) {
            return Err(AppError::InvalidInput(
                "a primary key value is NULL, which keyset paging cannot compare; \
                 use the row-limit comparison instead"
                    .into(),
            ));
        }
        Ok(())
    };

    let mut out = KeysetOutcome {
        rows: Vec::new(),
        source_count: 0,
        target_count: 0,
        truncated: false,
    };
    let mut after: Option<Vec<Value>> = None;
    let mut seen_target: std::collections::HashSet<String> = std::collections::HashSet::new();
    loop {
        let sql = keyset_select_sql(
            driver,
            table,
            columns,
            primary_key,
            &pk_types,
            after.as_deref(),
            None,
            page_rows,
        );
        let src_page = source.execute(&sql, Some(source_db)).await?.rows;
        if src_page.is_empty() {
            break;
        }
        for r in &src_page {
            check_key(&key_of(r))?;
        }
        let boundary = key_of(&src_page[src_page.len() - 1]);

        // target の (after, boundary] を集める。
        let mut tgt_window: Vec<Vec<Value>> = Vec::new();
        let mut cursor = after.clone();
        let mut chunk_overflow = false;
        loop {
            let sql = keyset_select_sql(
                driver,
                table,
                columns,
                primary_key,
                &pk_types,
                cursor.as_deref(),
                Some(&boundary),
                page_rows,
            );
            let page = target.execute(&sql, Some(target_db)).await?.rows;
            let n = page.len();
            for r in &page {
                let k = key_of(r);
                check_key(&k)?;
            }
            if let Some(last) = page.last() {
                cursor = Some(key_of(last));
            }
            tgt_window.extend(page);
            if n < page_rows {
                break;
            }
            if tgt_window.len() >= KEYSET_MAX_CHUNK_ROWS {
                chunk_overflow = true;
                break;
            }
        }
        // 窓が不完全なまま突き合わせると source の行を「target に無い」と誤判定して
        // INSERT を出してしまうので、この窓は比較せずここで打ち切る。
        if chunk_overflow {
            out.truncated = true;
            return Ok(out);
        }

        out.source_count += src_page.len();
        out.target_count += tgt_window.len();
        let window_rows =
            compute_data_diff_ignoring(columns, pk_idx, &src_page, &tgt_window, ignore_columns);
        verify_one_sided(
            (source, source_db),
            (target, target_db),
            table,
            primary_key,
            &pk_types,
            &window_rows,
            &mut seen_target,
        )
        .await?;
        out.rows.extend(window_rows);
        let src_len = src_page.len();
        after = Some(boundary);
        if out.rows.len() >= KEYSET_MAX_DIFF_ROWS || out.source_count >= KEYSET_MAX_SCAN_ROWS {
            // 上限に達した。以降は未比較なので打ち切り扱い (DELETE を出さない)。
            out.truncated = true;
            return Ok(out);
        }
        if src_len < page_rows {
            break;
        }
    }

    // source を読み切った。残りの target 行は source に無い (TargetOnly)。
    loop {
        let sql = keyset_select_sql(
            driver,
            table,
            columns,
            primary_key,
            &pk_types,
            after.as_deref(),
            None,
            page_rows,
        );
        let page = target.execute(&sql, Some(target_db)).await?.rows;
        if page.is_empty() {
            break;
        }
        let n = page.len();
        for r in &page {
            let k = key_of(r);
            check_key(&k)?;
        }
        let last_key = key_of(&page[n - 1]);
        out.target_count += n;
        let tail_rows = compute_data_diff_ignoring(columns, pk_idx, &[], &page, ignore_columns);
        verify_one_sided(
            (source, source_db),
            (target, target_db),
            table,
            primary_key,
            &pk_types,
            &tail_rows,
            &mut seen_target,
        )
        .await?;
        out.rows.extend(tail_rows);
        after = Some(last_key);
        if out.rows.len() >= KEYSET_MAX_DIFF_ROWS || out.target_count >= KEYSET_MAX_SCAN_ROWS {
            out.truncated = true;
            return Ok(out);
        }
        if n < page_rows {
            break;
        }
    }
    Ok(out)
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
        // 主キー無しなら ORDER BY を出さない (json 列などで ORDER BY が失敗するため)。
        assert_eq!(
            select_rows_sql(DriverKind::Postgres, "t", &cols, &[], 11),
            "SELECT \"id\", \"v\" FROM \"t\" LIMIT 11"
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

/// 比較から外す列名を整える: 前後の空白を除き、空・重複を捨て、表に無い列名はエラー。
fn normalize_ignore_columns(
    ignore: Option<Vec<String>>,
    columns: &[String],
) -> Result<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for name in ignore.unwrap_or_default() {
        let name = name.trim().to_string();
        if name.is_empty() || out.contains(&name) {
            continue;
        }
        if !columns.contains(&name) {
            return Err(AppError::InvalidInput(format!(
                "ignore column '{name}' does not exist in the table"
            )));
        }
        out.push(name);
    }
    Ok(out)
}

/// 上限つき比較 (`all_rows = false`) の結果。
#[derive(Debug)]
struct BoundedOutcome {
    rows: Vec<RowDiff>,
    source_count: usize,
    target_count: usize,
    truncated: bool,
}

/// 両側を主キー順に先頭 `want` 行ずつ読んで突き合わせる (上限つき比較)。
///
/// Rust 側はバイト等価・バイト順で行を対応付けるため、照合順序が絡む主キー (MySQL の ci 照合など)
/// では、DB 上は同一の主キーが別行に見えて片側限定の DELETE / INSERT が生成されうる。
/// 全行比較 (keyset) と同じく、片側限定の行が相手側に主キー等価で実在しないかを
/// `verify_one_sided` で確かめ、実在すれば fail-closed でエラーにする。
#[allow(clippy::too_many_arguments)]
async fn bounded_compare(
    source: (&Connection, &str),
    target: (&Connection, &str),
    table: &str,
    columns: &[String],
    column_types: &[String],
    primary_key: &[String],
    pk_idx: &[usize],
    ignore_columns: &[String],
    want: usize,
) -> Result<BoundedOutcome> {
    let driver = source.0.driver_kind();
    let sql = select_rows_sql(driver, table, columns, primary_key, want + 1);
    let source_res = source.0.execute(&sql, Some(source.1)).await?;
    let target_res = target.0.execute(&sql, Some(target.1)).await?;

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
        pk_idx,
    );
    let source_count = source_rows.len();
    let target_count = target_rows.len();

    let rows =
        compute_data_diff_ignoring(columns, pk_idx, &source_rows, &target_rows, ignore_columns);
    let pk_types: Vec<String> = pk_idx
        .iter()
        .map(|&i| column_types.get(i).cloned().unwrap_or_default())
        .collect();
    verify_one_sided(
        source,
        target,
        table,
        primary_key,
        &pk_types,
        &rows,
        &mut std::collections::HashSet::new(),
    )
    .await?;
    Ok(BoundedOutcome {
        rows,
        source_count,
        target_count,
        truncated: source_truncated || target_truncated,
    })
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
// IPC の引数をそのまま受ける Tauri コマンドなので、引数の数は呼び出し側 (フロント) の
// 形に合わせて固定されている。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn compare_table_data(
    source_session_id: String,
    source_database: String,
    target_session_id: String,
    target_database: String,
    table: String,
    limit: Option<usize>,
    // true なら上限 (`limit` / `MAX_DATA_ROWS`) を使わず、主キーのキーセットページングで
    // 全行を比較する (#1539)。省略 / false は従来の上限つき比較。
    all_rows: Option<bool>,
    // 比較から外す列 (`updated_at` など環境ごとに値が違う列, #1539)。表に無い列名は
    // 打ち間違いの可能性が高いのでエラーにする。
    ignore_columns: Option<Vec<String>>,
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

    let ignore_columns = normalize_ignore_columns(ignore_columns, &columns)?;

    if all_rows.unwrap_or(false) {
        let outcome = keyset_compare(
            &source.conn,
            &source_database,
            &target.conn,
            &target_database,
            &table,
            &columns,
            &column_types,
            &primary_key,
            &pk_idx,
            &ignore_columns,
            KEYSET_PAGE_ROWS,
        )
        .await?;
        let diff = DataDiff {
            target_driver: driver,
            table,
            columns,
            column_types,
            primary_key,
            rows: outcome.rows,
            truncated: outcome.truncated,
            source_count: outcome.source_count,
            target_count: outcome.target_count,
            generated_columns,
        };
        let diff_id = state.store_data_diff(
            diff.clone(),
            vec![source_session_id.clone(), target_session_id.clone()],
        );
        return Ok(DataDiffHandle { diff_id, diff });
    }

    // Read one extra row to detect (and flag) truncation without exceeding it.
    let want = limit.unwrap_or(DEFAULT_DATA_ROWS).min(MAX_DATA_ROWS);
    let outcome = bounded_compare(
        (&source.conn, &source_database),
        (&target.conn, &target_database),
        &table,
        &columns,
        &column_types,
        &primary_key,
        &pk_idx,
        &ignore_columns,
        want,
    )
    .await?;

    let diff = DataDiff {
        target_driver: driver,
        table,
        columns,
        column_types,
        primary_key,
        rows: outcome.rows,
        truncated: outcome.truncated,
        source_count: outcome.source_count,
        target_count: outcome.target_count,
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
    use crate::db::data_diff::compute_data_diff;

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

#[cfg(test)]
mod keyset_tests {
    use super::*;
    use crate::db::data_diff::RowStatus;
    use crate::db::DbConnectOptions;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn keyset_sql_uses_row_value_comparison_per_driver() {
        let cols = s(&["a", "b", "v"]);
        let pk = s(&["a", "b"]);
        let types = s(&["int", "varchar(10)"]);
        let after = [Value::Int(1), Value::String("x'y".into())];
        let upto = [Value::Int(9), Value::String("z".into())];
        assert_eq!(
            keyset_select_sql(DriverKind::Mysql, "t", &cols, &pk, &types, Some(&after), Some(&upto), 50),
            "SELECT `a`, `b`, `v` FROM `t` WHERE (`a` > 1 OR (`a` = 1 AND `b` > 'x''y')) AND (`a` < 9 OR (`a` = 9 AND `b` <= 'z')) \
             ORDER BY `a`, `b` LIMIT 50"
        );
        assert_eq!(
            keyset_select_sql(
                DriverKind::Postgres,
                "t",
                &cols,
                &pk,
                &types,
                Some(&after),
                None,
                7
            ),
            "SELECT \"a\", \"b\", \"v\" FROM \"t\" WHERE (\"a\", \"b\") > (1, 'x''y') \
             ORDER BY \"a\", \"b\" LIMIT 7"
        );
        assert_eq!(
            keyset_select_sql(DriverKind::Postgres, "t", &cols, &pk, &types, None, None, 7),
            "SELECT \"a\", \"b\", \"v\" FROM \"t\" ORDER BY \"a\", \"b\" LIMIT 7"
        );
        // 単一キーは素の比較。2^53 超の整数 (String で届く) は引用符なしの数値で書く。
        let big = [Value::String("9007199254740993".into())];
        assert_eq!(
            keyset_select_sql(
                DriverKind::Sqlite,
                "t",
                &s(&["id"]),
                &s(&["id"]),
                &s(&["bigint"]),
                Some(&big),
                None,
                10
            ),
            "SELECT \"id\" FROM \"t\" WHERE \"id\" > 9007199254740993 ORDER BY \"id\" LIMIT 10"
        );
        // バイナリキーは 16 進文字列を Bytes リテラルに戻す。
        let bin = [Value::String("00ff".into())];
        assert!(keyset_select_sql(
            DriverKind::Mysql,
            "t",
            &s(&["k"]),
            &s(&["k"]),
            &s(&["varbinary(8)"]),
            Some(&bin),
            None,
            1
        )
        .contains("`k` > X'00ff'"));
    }

    async fn sqlite_conn(name: &str) -> (Connection, std::path::PathBuf) {
        let path =
            std::env::temp_dir().join(format!("noobdb_keyset_{name}_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        std::fs::File::create(&path).unwrap();
        let opts = DbConnectOptions {
            host: String::new(),
            port: 0,
            user: String::new(),
            password: String::new(),
            database: None,
            driver: DriverKind::Sqlite,
            file_path: Some(path.to_string_lossy().to_string()),
            ssl_mode: None,
            ssl_root_cert: None,
            ssl_client_cert: None,
            ssl_client_key: None,
            init_sql: None,
            aws_iam: None,
        };
        (Connection::connect(&opts).await.unwrap(), path)
    }

    /// 複合主キーの表を 3 行ずつのページで全行比較する: ページをまたぐ INSERT / UPDATE /
    /// DELETE がすべて検出され、無視列の差は拾わない。
    #[tokio::test]
    async fn keyset_compare_walks_all_pages_with_composite_key() {
        let (src, src_path) = sqlite_conn("src").await;
        let (tgt, tgt_path) = sqlite_conn("tgt").await;
        for c in [&src, &tgt] {
            c.execute(
                "CREATE TABLE t (a INTEGER NOT NULL, b INTEGER NOT NULL, v TEXT, updated_at TEXT, PRIMARY KEY (a, b))",
                None,
            )
            .await
            .unwrap();
        }
        // source: a=1..4 × b=1..3 (12 行)。target: 同じ行から (2,2) を欠き、(3,1) の v と
        // 全行の updated_at を変え、source に無い (4,9) / (7,1) を持つ。
        let mut src_vals = Vec::new();
        let mut tgt_vals = Vec::new();
        for a in 1..=4 {
            for b in 1..=3 {
                src_vals.push(format!("({a},{b},'v{a}{b}','s')"));
                if (a, b) == (2, 2) {
                    continue;
                }
                let v = if (a, b) == (3, 1) {
                    "changed".to_string()
                } else {
                    format!("v{a}{b}")
                };
                tgt_vals.push(format!("({a},{b},'{v}','t')"));
            }
        }
        tgt_vals.push("(4,9,'extra','t')".into());
        tgt_vals.push("(7,1,'extra','t')".into());
        src.execute(
            &format!("INSERT INTO t VALUES {}", src_vals.join(",")),
            None,
        )
        .await
        .unwrap();
        tgt.execute(
            &format!("INSERT INTO t VALUES {}", tgt_vals.join(",")),
            None,
        )
        .await
        .unwrap();

        let columns = s(&["a", "b", "v", "updated_at"]);
        let types = s(&["INTEGER", "INTEGER", "TEXT", "TEXT"]);
        let pk = s(&["a", "b"]);
        let run = |ignore: Vec<String>, page: usize| {
            let (src, tgt, columns, types, pk) = (&src, &tgt, &columns, &types, &pk);
            async move {
                keyset_compare(
                    src,
                    "main",
                    tgt,
                    "main",
                    "t",
                    columns,
                    types,
                    pk,
                    &[0, 1],
                    &ignore,
                    page,
                )
                .await
                .unwrap()
            }
        };
        let count =
            |o: &KeysetOutcome, st: RowStatus| o.rows.iter().filter(|r| r.status == st).count();

        for page in [1usize, 3, 5, 100] {
            let o = run(s(&["updated_at"]), page).await;
            assert!(!o.truncated, "page={page}");
            assert_eq!(o.source_count, 12, "page={page}");
            assert_eq!(o.target_count, 13, "page={page}");
            assert_eq!(count(&o, RowStatus::SourceOnly), 1, "page={page}"); // (2,2)
            assert_eq!(count(&o, RowStatus::Different), 1, "page={page}"); // (3,1) v
            assert_eq!(count(&o, RowStatus::TargetOnly), 2, "page={page}"); // (4,9) (7,1)
        }
        // 無視列を指定しないと updated_at の差で全ペア行が Different になる (11 行 = 12 - 欠落 1)。
        let o = run(vec![], 4).await;
        assert_eq!(count(&o, RowStatus::Different), 11);

        let _ = std::fs::remove_file(src_path);
        let _ = std::fs::remove_file(tgt_path);
    }

    /// source が空でも target の残りは全部 TargetOnly になり、NULL の主キーはエラーになる。
    #[tokio::test]
    async fn keyset_compare_handles_empty_source_and_rejects_null_keys() {
        let (src, src_path) = sqlite_conn("e_src").await;
        let (tgt, tgt_path) = sqlite_conn("e_tgt").await;
        for c in [&src, &tgt] {
            c.execute("CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT)", None)
                .await
                .unwrap();
        }
        tgt.execute("INSERT INTO t VALUES ('a','1'),('b','2'),('c','3')", None)
            .await
            .unwrap();
        let columns = s(&["k", "v"]);
        let types = s(&["TEXT", "TEXT"]);
        let pk = s(&["k"]);
        let o = keyset_compare(
            &src,
            "main",
            &tgt,
            "main",
            "t",
            &columns,
            &types,
            &pk,
            &[0],
            &[],
            2,
        )
        .await
        .unwrap();
        assert_eq!(o.rows.len(), 3);
        assert!(o.rows.iter().all(|r| r.status == RowStatus::TargetOnly));
        assert_eq!(o.target_count, 3);

        src.execute("INSERT INTO t VALUES (NULL,'x')", None)
            .await
            .unwrap();
        let err = keyset_compare(
            &src,
            "main",
            &tgt,
            "main",
            "t",
            &columns,
            &types,
            &pk,
            &[0],
            &[],
            2,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
        let _ = std::fs::remove_file(src_path);
        let _ = std::fs::remove_file(tgt_path);
    }

    /// 片側が `COLLATE NOCASE`、片側が BINARY の主キーだと、両側にある行が片側だけの行に
    /// 見えて DELETE が生成されかねない。fail-closed でエラーにする。
    #[tokio::test]
    async fn keyset_compare_rejects_collation_mismatch() {
        let (src, src_path) = sqlite_conn("c_src").await;
        let (tgt, tgt_path) = sqlite_conn("c_tgt").await;
        src.execute("CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT)", None)
            .await
            .unwrap();
        tgt.execute(
            "CREATE TABLE t (k TEXT COLLATE NOCASE PRIMARY KEY, v TEXT)",
            None,
        )
        .await
        .unwrap();
        // source は 'a' と 'B'、target は 'A' と 'b' (NOCASE では同じ行)。
        src.execute("INSERT INTO t VALUES ('a','1'),('B','2')", None)
            .await
            .unwrap();
        tgt.execute("INSERT INTO t VALUES ('A','1'),('b','2')", None)
            .await
            .unwrap();
        let columns = s(&["k", "v"]);
        let types = s(&["TEXT", "TEXT"]);
        let pk = s(&["k"]);
        for (a, b) in [(&src, &tgt), (&tgt, &src)] {
            for page in [1usize, 100] {
                let err = keyset_compare(
                    a,
                    "main",
                    b,
                    "main",
                    "t",
                    &columns,
                    &types,
                    &pk,
                    &[0],
                    &[],
                    page,
                )
                .await
                .unwrap_err();
                assert!(matches!(err, AppError::InvalidInput(_)), "page={page}");
            }
        }
        let _ = std::fs::remove_file(src_path);
        let _ = std::fs::remove_file(tgt_path);
    }

    /// 上限つき比較でも、照合順序で同一の主キーが片側限定行に見えるなら fail-closed。
    #[tokio::test]
    async fn bounded_compare_rejects_collation_mismatch() {
        let (src, src_path) = sqlite_conn("b_src").await;
        let (tgt, tgt_path) = sqlite_conn("b_tgt").await;
        src.execute("CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT)", None)
            .await
            .unwrap();
        tgt.execute(
            "CREATE TABLE t (k TEXT COLLATE NOCASE PRIMARY KEY, v TEXT)",
            None,
        )
        .await
        .unwrap();
        src.execute("INSERT INTO t VALUES ('A1','1')", None)
            .await
            .unwrap();
        tgt.execute("INSERT INTO t VALUES ('a1','1')", None)
            .await
            .unwrap();
        let columns = s(&["k", "v"]);
        let types = s(&["TEXT", "TEXT"]);
        let pk = s(&["k"]);
        for (a, b) in [(&src, &tgt), (&tgt, &src)] {
            let err = bounded_compare(
                (a, "main"),
                (b, "main"),
                "t",
                &columns,
                &types,
                &pk,
                &[0],
                &[],
                1000,
            )
            .await
            .unwrap_err();
            assert!(matches!(err, AppError::InvalidInput(_)));
        }
        // 照合順序が揃っていて本当に片側にしか無い行は従来どおり差分になる。
        tgt.execute("INSERT INTO t VALUES ('zz','9')", None)
            .await
            .unwrap();
        tgt.execute("DELETE FROM t WHERE k = 'a1'", None)
            .await
            .unwrap();
        let ok = bounded_compare(
            (&src, "main"),
            (&tgt, "main"),
            "t",
            &columns,
            &types,
            &pk,
            &[0],
            &[],
            1000,
        )
        .await
        .unwrap();
        assert_eq!(ok.rows.len(), 2);
        let _ = std::fs::remove_file(src_path);
        let _ = std::fs::remove_file(tgt_path);
    }

    #[test]
    fn normalize_ignore_columns_trims_dedups_and_rejects_unknown() {
        let cols = s(&["id", "name", "updated_at"]);
        assert_eq!(
            normalize_ignore_columns(Some(s(&[" updated_at ", "", "updated_at", "name"])), &cols)
                .unwrap(),
            s(&["updated_at", "name"])
        );
        assert!(normalize_ignore_columns(None, &cols).unwrap().is_empty());
        assert!(matches!(
            normalize_ignore_columns(Some(s(&["nope"])), &cols),
            Err(AppError::InvalidInput(_))
        ));
    }
}
