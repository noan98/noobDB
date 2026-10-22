//! 構造化入力を受ける一括書き込みコマンド (#1259)。
//!
//! - [`bulk_update_cells`]: 結果グリッドのセル編集 Apply。従来は JS が 1 行 1 `UPDATE`
//!   (リテラル埋め込み) を組み立てて `run_query_transaction` へ送っていた。ここでは
//!   「同じ (列, 値) の組」ごとにまとめた構造化入力 (テーブル・PK 列・グループ) を受け、
//!   Rust 側で `UPDATE t SET c = v WHERE pk IN (…)` をチャンク化して組み立て、
//!   既存の `run_query_transaction_inner` にそのまま渡す。read_only ガード (緊急モード
//!   含む)・クエリ履歴・スキーマ/結果キャッシュの invalidate は従来と完全に同じ経路を
//!   通る (フライトレコーダーへ記録しない点も従来どおり — 記録するのは
//!   `run_query_stream({ capture: true })` の単文だけ)。
//! - [`insert_generated_rows`]: テストデータ生成 (#602) の投入。従来は 100 行ずつの
//!   リテラル `INSERT` 文を `run_query_transaction` へ送っていたのを、生成行を
//!   `Connection::import_rows` (1 トランザクション・all-or-nothing) に直接渡す。
//!
//! リテラル化は `db::data_diff::sql_literal` (方言別エスケープの単一実装) を使う。
//! プレースホルダのバインドにしないのは、PostgreSQL が型付きパラメータ (text) を
//! 整数列などへ暗黙変換しないため — 既存の import / sync と同じくサーバ側の型強制が
//! 効くリテラルで送る。64bit 整数の主キーは IPC で文字列 (`Value::from_*_lossless`)
//! として届くので、引用リテラルとして等値比較され丸められない。

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::query::{
    ensure_allowed_for_session, record_write_history, run_query_transaction_guarded_inner,
    TransactionRun,
};
use crate::db::data_diff::{is_numeric_literal, sql_literal};
use crate::db::sync::quote_ident;
use crate::db::types::{QueryResult, Value};
use crate::db::upsert::ImportConflict;
use crate::db::DriverKind;
use crate::db::RowExpectation;
use crate::error::{AppError, Result};
use crate::state::AppState;

/// `IN (...)` 1 文に載せる主キー値の上限。
const IN_CHUNK: usize = 500;
/// 複合主キー / NULL を含む主キーで `OR` 連結する行数の上限。
const OR_CHUNK: usize = 100;
/// テストデータ投入の 1 INSERT あたりの行数 (`import_rows` のバッチサイズ)。
const INSERT_BATCH: usize = 100;

/// `SET` に書く値 (フロントが列型に応じて分類済み)。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum BulkSetValue {
    Null,
    /// 数値リテラルとして引用符なしで書く文字列 (`-12` / `3.5` / `1e3`)。数値として
    /// 不正なら拒否する (SQL インジェクション防止)。
    Number {
        text: String,
    },
    Bool {
        value: bool,
    },
    /// 文字列リテラルとして引用する。
    Text {
        text: String,
    },
}

#[derive(Debug, Clone, Deserialize)]
pub struct BulkSetColumn {
    pub column: String,
    pub value: BulkSetValue,
}

/// 同じ `SET` を適用する行の集合。`keys` は各行の**元の**主キー値 (`pk_columns` と同順)。
#[derive(Debug, Clone, Deserialize)]
pub struct BulkUpdateGroup {
    pub set: Vec<BulkSetColumn>,
    pub keys: Vec<Vec<Value>>,
}

/// `bulk_update_cells` の追加オプション (#1777)。後続の検査 (楽観ロック #1766 など) も
/// ここへフィールドを足す。`#[serde(default)]` なので、指定の無い項目は安全側 (= 検査する) になる。
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(default)]
pub struct BulkWriteOptions {
    /// 利用者が確認ダイアログで承認した合計の影響行数。指定すると、文ごとの検査の代わりに
    /// 「合計がこの件数を超えたらロールバック」で再実行する (承認した以上には書かない)。
    /// `row_count_exceeded` が返した `batch_total_rows` をそのまま渡す。
    pub approved_max_rows: Option<u64>,
}

/// `bulk_update_cells` の結果 (#1777)。想定外はエラーではなく判別できる値で返し、フロントが
/// 確認を取って承認つきで再実行できるようにする。新しい種類の結果 (楽観ロックの競合など)
/// はバリアントを足して拡張する。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum BulkWriteOutcome {
    /// コミットした。
    Applied { result: QueryResult },
    /// 実影響行数が想定 (編集対象として指定した行数) を外れたのでロールバックした。DB は未変更。
    /// `expected_rows` / `actual_rows` は違反した文だけの合計 (表示用)、`batch_total_rows` は
    /// 全文の合計で、承認して再実行するときの `approved_max_rows` に使う。
    RowCountExceeded {
        expected_rows: u64,
        actual_rows: u64,
        batch_total_rows: u64,
    },
    /// 想定を外れてロールバックしたが、トランザクション非対応の表 (MyISAM など) を含み、
    /// 書き込みの一部が**戻らなかった**。承認して再実行してはいけない (二重に書く)。
    /// 再読込して現状を確認させる。
    RollbackIncomplete {
        expected_rows: u64,
        actual_rows: u64,
    },
}

/// 組み立てた 1 文と、その文に期待する影響行数。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BuiltStatement {
    pub sql: String,
    /// 期待する影響行数 (`UPDATE` チャンクの対象行数)。
    pub expected: u64,
}

/// 追加文 (削除予定行 / 新規行の `DELETE` / `INSERT`) 1 文に期待する影響行数。フロントは
/// 1 文 = 1 行で生成する。
const EXTRA_STATEMENT_ROWS: u64 = 1;

fn qualified_ref(driver: DriverKind, database: &str, table: &str) -> String {
    // SQLite は接続ごとに単一の名前空間なので DB 名で修飾しない (フロントの
    // `qualifiedTableRef` と同じ規約)。
    match driver {
        DriverKind::Sqlite => quote_ident(driver, table),
        DriverKind::Mysql | DriverKind::Postgres => {
            format!(
                "{}.{}",
                quote_ident(driver, database),
                quote_ident(driver, table)
            )
        }
    }
}

fn set_literal(driver: DriverKind, v: &BulkSetValue) -> Result<String> {
    Ok(match v {
        BulkSetValue::Null => "NULL".to_string(),
        BulkSetValue::Number { text } => {
            if !is_numeric_literal(text) {
                return Err(AppError::InvalidInput(format!(
                    "not a numeric literal: {text}"
                )));
            }
            text.clone()
        }
        BulkSetValue::Bool { value } => sql_literal(driver, &Value::Bool(*value)),
        BulkSetValue::Text { text } => sql_literal(driver, &Value::String(text.clone())),
    })
}

/// 1 行ぶんの `WHERE` 条件 (`a = 1 AND b IS NULL`)。NULL は `IS NULL` にする
/// (`= NULL` は常に偽)。全列一致の行識別 (#849) では NULL 列が普通に現れる。
fn row_condition(driver: DriverKind, pk_columns: &[String], key: &[Value]) -> String {
    pk_columns
        .iter()
        .zip(key)
        .map(|(c, v)| match v {
            Value::Null => format!("{} IS NULL", quote_ident(driver, c)),
            _ => format!("{} = {}", quote_ident(driver, c), sql_literal(driver, v)),
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}

/// `pk_binary[i]` が真の主キー列 (BLOB/BINARY/BYTEA) の `keys` は、IPC で 16 進文字列
/// (`Value::String`) として届くため、`Value::Bytes` に戻して `sql_literal` にバイナリ
/// リテラルとして書かせる。引用文字列のまま `=` 比較すると BLOB 列には当たらず 0 行になる
/// (all_columns 同定で BLOB 列を含む表)。16 進以外が混じっていればリテラルへ埋め込む前に
/// 拒否する。`pk_binary` が `None` ならそのまま返す (後方互換)。
pub(crate) fn apply_pk_binary(
    mut groups: Vec<BulkUpdateGroup>,
    pk_binary: Option<&[bool]>,
) -> Result<Vec<BulkUpdateGroup>> {
    let Some(flags) = pk_binary else {
        return Ok(groups);
    };
    for group in &mut groups {
        for key in &mut group.keys {
            for (v, is_bin) in key.iter_mut().zip(flags) {
                if !*is_bin {
                    continue;
                }
                if let Value::String(hex) = v {
                    if hex.len() % 2 != 0 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                        return Err(AppError::InvalidInput(
                            "binary key is not a hex string".into(),
                        ));
                    }
                    *v = Value::Bytes(std::mem::take(hex));
                }
            }
        }
    }
    Ok(groups)
}

/// [`build_bulk_update_statements_expected`] の SQL だけ版 (テスト用)。
#[cfg(test)]
pub(crate) fn build_bulk_update_statements(
    driver: DriverKind,
    database: &str,
    table: &str,
    pk_columns: &[String],
    groups: &[BulkUpdateGroup],
) -> Result<Vec<String>> {
    Ok(
        build_bulk_update_statements_expected(driver, database, table, pk_columns, groups)?
            .into_iter()
            .map(|b| b.sql)
            .collect(),
    )
}

/// グループ化された構造化入力から `UPDATE` 文を (期待影響行数つきで) 組み立てる (純関数)。
/// 単一 PK 列で NULL を含まないグループは `WHERE pk IN (…)` を [`IN_CHUNK`] 件ずつ、
/// それ以外 (複合 PK / NULL を含む) は行条件を `OR` で連結して [`OR_CHUNK`] 行ずつ
/// 1 文にする。
pub(crate) fn build_bulk_update_statements_expected(
    driver: DriverKind,
    database: &str,
    table: &str,
    pk_columns: &[String],
    groups: &[BulkUpdateGroup],
) -> Result<Vec<BuiltStatement>> {
    if pk_columns.is_empty() {
        return Err(AppError::InvalidInput(
            "bulk update requires at least one primary key column".into(),
        ));
    }
    let table_ref = qualified_ref(driver, database, table);
    let mut out = Vec::new();
    for group in groups {
        if group.set.is_empty() || group.keys.is_empty() {
            continue;
        }
        if let Some(bad) = group.keys.iter().find(|k| k.len() != pk_columns.len()) {
            return Err(AppError::InvalidInput(format!(
                "primary key value count mismatch: expected {}, got {}",
                pk_columns.len(),
                bad.len()
            )));
        }
        let mut assignments = Vec::with_capacity(group.set.len());
        for s in &group.set {
            assignments.push(format!(
                "{} = {}",
                quote_ident(driver, &s.column),
                set_literal(driver, &s.value)?
            ));
        }
        let set_sql = assignments.join(", ");
        let single_non_null =
            pk_columns.len() == 1 && group.keys.iter().all(|k| !matches!(k[0], Value::Null));
        if single_non_null {
            let col = quote_ident(driver, &pk_columns[0]);
            for chunk in group.keys.chunks(IN_CHUNK) {
                let list = chunk
                    .iter()
                    .map(|k| sql_literal(driver, &k[0]))
                    .collect::<Vec<_>>()
                    .join(", ");
                out.push(BuiltStatement {
                    sql: format!("UPDATE {table_ref} SET {set_sql} WHERE {col} IN ({list});"),
                    expected: chunk.len() as u64,
                });
            }
        } else {
            for chunk in group.keys.chunks(OR_CHUNK) {
                let cond = if chunk.len() == 1 {
                    row_condition(driver, pk_columns, &chunk[0])
                } else {
                    chunk
                        .iter()
                        .map(|k| format!("({})", row_condition(driver, pk_columns, k)))
                        .collect::<Vec<_>>()
                        .join(" OR ")
                };
                out.push(BuiltStatement {
                    sql: format!("UPDATE {table_ref} SET {set_sql} WHERE {cond};"),
                    expected: chunk.len() as u64,
                });
            }
        }
    }
    Ok(out)
}

/// 結果グリッドのセル編集をまとめて 1 トランザクションで適用する (#1259)。`groups` は
/// 同じ `SET` (列, 値) の行をまとめたもの、`extra_statements` は同じトランザクションに
/// 載せる削除予定行 / 新規行の `DELETE` / `INSERT` 文 (従来どおりフロントが生成)。
/// 全体が all-or-nothing で、read_only ガード・履歴・キャッシュ invalidate は
/// `run_query_transaction` と同一。さらに合計 `rows_affected` を想定行数と検算し、超えたら
/// コミットせずロールバックして [`BulkWriteOutcome::RowCountExceeded`] を返す (#1777、画面外の
/// 重複行への多重更新の最終防波堤)。検算は文ごと (UPDATE チャンク = 対象行数、追加文 = 1 行)。
/// 利用者が承認した件数 (`options.approved_max_rows`) があれば、その合計までは通す。
// IPC コマンドの引数は 1 引数 1 フィールドのフラット形が契約 (State 含め 8 個) のため許可する。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn bulk_update_cells(
    session_id: String,
    database: Option<String>,
    table: String,
    pk_columns: Vec<String>,
    groups: Vec<BulkUpdateGroup>,
    extra_statements: Vec<String>,
    pk_binary: Option<Vec<bool>>,
    options: Option<BulkWriteOptions>,
    state: State<'_, AppState>,
) -> Result<BulkWriteOutcome> {
    let groups = apply_pk_binary(groups, pk_binary.as_deref())?;
    bulk_update_cells_inner(
        state.inner(),
        session_id,
        database,
        table,
        pk_columns,
        groups,
        extra_statements,
        options.unwrap_or_default(),
    )
    .await
}

/// Core of [`bulk_update_cells`] without Tauri's `State` wrapper (#881)。
// コマンドと同じフラットな引数 (State を除く 8 個) をそのまま受けるため許可する。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn bulk_update_cells_inner(
    state: &AppState,
    session_id: String,
    database: Option<String>,
    table: String,
    pk_columns: Vec<String>,
    groups: Vec<BulkUpdateGroup>,
    extra_statements: Vec<String>,
    options: BulkWriteOptions,
) -> Result<BulkWriteOutcome> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    let driver = session.conn.driver_kind();
    let built = if groups.is_empty() {
        Vec::new()
    } else {
        build_bulk_update_statements_expected(
            driver,
            database.as_deref().unwrap_or_default(),
            &table,
            &pk_columns,
            &groups,
        )?
    };
    let mut statements: Vec<String> = Vec::with_capacity(built.len() + extra_statements.len());
    let mut expects: Vec<RowExpectation> = Vec::with_capacity(statements.capacity());
    for b in built {
        expects.push(RowExpectation::at_most(b.expected));
        statements.push(b.sql);
    }
    // 追加文 (DELETE / INSERT) は 1 文 = 1 行。多い側だけを止める (少ない側は従来どおり通す)。
    for sql in extra_statements {
        expects.push(RowExpectation::at_most(EXTRA_STATEMENT_ROWS));
        statements.push(sql);
    }
    if statements.is_empty() {
        return Ok(BulkWriteOutcome::Applied {
            result: QueryResult::empty(0, 0),
        });
    }
    Ok(
        match run_query_transaction_guarded_inner(
            state,
            session_id,
            statements,
            expects,
            database,
            options.approved_max_rows,
        )
        .await?
        {
            TransactionRun::Committed(result) => BulkWriteOutcome::Applied { result },
            TransactionRun::RolledBack(v) => BulkWriteOutcome::RowCountExceeded {
                expected_rows: v.expected,
                actual_rows: v.actual,
                batch_total_rows: v.total,
            },
            TransactionRun::RollbackIncomplete(v) => BulkWriteOutcome::RollbackIncomplete {
                expected_rows: v.expected,
                actual_rows: v.actual,
            },
        },
    )
}

/// `insert_generated_rows` の結果。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct InsertRowsResult {
    pub inserted: u64,
    pub elapsed_ms: u64,
}

/// 生成セル (JSON) を `import_rows` が受ける文字列セルへ変換する。真偽値は 3 ドライバの
/// どれでも真偽/整数列へ入る `1` / `0` にする。
fn generated_cell_text(v: &serde_json::Value) -> Result<Option<String>> {
    Ok(match v {
        serde_json::Value::Null => None,
        serde_json::Value::Bool(b) => Some(if *b { "1" } else { "0" }.to_string()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        serde_json::Value::String(s) => Some(s.clone()),
        other => {
            return Err(AppError::InvalidInput(format!(
                "unsupported generated cell value: {other}"
            )))
        }
    })
}

/// テストデータ生成 (#602) の生成行を 1 トランザクションで投入する (#1259)。従来の
/// 「100 行ずつのリテラル `INSERT` を `run_query_transaction` で送る」経路と同じく
/// all-or-nothing。セルは `null` / 真偽 / 数値 / 文字列で、ドライバが列型へ強制変換する。
/// read_only ガード (緊急モード含む)・履歴 (1 行の要約)・キャッシュ invalidate は
/// `run_query_transaction` と揃える。
#[tauri::command]
pub async fn insert_generated_rows(
    session_id: String,
    database: Option<String>,
    table: String,
    columns: Vec<String>,
    rows: Vec<Vec<serde_json::Value>>,
    state: State<'_, AppState>,
) -> Result<InsertRowsResult> {
    insert_generated_rows_inner(
        state.inner(),
        &session_id,
        database,
        &table,
        &columns,
        &rows,
    )
    .await
}

/// Core of [`insert_generated_rows`] without Tauri's `State` wrapper (#881)。
pub(crate) async fn insert_generated_rows_inner(
    state: &AppState,
    session_id: &str,
    database: Option<String>,
    table: &str,
    columns: &[String],
    rows: &[Vec<serde_json::Value>],
) -> Result<InsertRowsResult> {
    let session = state
        .get(session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
    // 従来の INSERT 文経路と同じゲート (読み取り専用セッションは緊急モードでのみ通す)。
    ensure_allowed_for_session(&session, "INSERT INTO t DEFAULT VALUES")?;
    if columns.is_empty() {
        return Err(AppError::InvalidInput("no columns to insert".into()));
    }
    let mut cells: Vec<Vec<Option<String>>> = Vec::with_capacity(rows.len());
    for row in rows {
        if row.len() != columns.len() {
            return Err(AppError::InvalidInput(format!(
                "row has {} cells, expected {}",
                row.len(),
                columns.len()
            )));
        }
        cells.push(row.iter().map(generated_cell_text).collect::<Result<_>>()?);
    }
    let started = std::time::Instant::now();
    let result = session
        .conn
        .import_rows(
            database.as_deref(),
            table,
            columns,
            &cells,
            INSERT_BATCH,
            &ImportConflict::default(),
            |_| Ok(()),
        )
        .await;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let summary = format!(
        "INSERT INTO {} ({}) -- {} generated rows",
        match database.as_deref() {
            Some(db) if !db.is_empty() => format!("{db}.{table}"),
            _ => table.to_string(),
        },
        columns.join(", "),
        rows.len()
    );
    match &result {
        Ok(inserted) => {
            record_write_history(
                &session,
                summary,
                database.as_deref(),
                Some(*inserted as i64),
                Some(elapsed_ms as i64),
                None,
            )
            .await;
            session.query_cache.invalidate_all().await;
        }
        Err(e) => {
            record_write_history(
                &session,
                summary,
                database.as_deref(),
                None,
                None,
                Some(e.to_string()),
            )
            .await;
        }
    }
    Ok(InsertRowsResult {
        inserted: result?,
        elapsed_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set_text(col: &str, text: &str) -> BulkSetColumn {
        BulkSetColumn {
            column: col.into(),
            value: BulkSetValue::Text { text: text.into() },
        }
    }

    fn keys1(vals: &[i64]) -> Vec<Vec<Value>> {
        vals.iter().map(|v| vec![Value::Int(*v)]).collect()
    }

    fn group(set: Vec<BulkSetColumn>, keys: Vec<Vec<Value>>) -> BulkUpdateGroup {
        BulkUpdateGroup { set, keys }
    }

    #[test]
    fn built_statements_carry_per_chunk_expected_rows() {
        let mut keys = keys1(&(1..=501).collect::<Vec<_>>());
        keys.push(vec![Value::Int(900)]);
        let groups = vec![
            group(vec![set_text("a", "x")], keys),
            // 無視されるグループ (空の SET / 空の keys) は文にならない。
            group(vec![], keys1(&[5])),
            group(vec![set_text("a", "z")], vec![]),
        ];
        let built = build_bulk_update_statements_expected(
            DriverKind::Mysql,
            "d",
            "t",
            &["id".to_string()],
            &groups,
        )
        .unwrap_or_default();
        // 502 件 → 500 + 2。
        assert_eq!(
            built.iter().map(|b| b.expected).collect::<Vec<_>>(),
            vec![500, 2]
        );
    }

    #[test]
    fn outcome_serializes_with_status_tag() {
        let v = serde_json::to_value(BulkWriteOutcome::RowCountExceeded {
            expected_rows: 1,
            actual_rows: 2,
            batch_total_rows: 3,
        })
        .unwrap_or_default();
        assert_eq!(
            v,
            serde_json::json!({"status": "row_count_exceeded", "expected_rows": 1, "actual_rows": 2, "batch_total_rows": 3})
        );
    }

    #[test]
    fn binary_pk_keys_become_blob_literals_per_dialect() {
        let groups = vec![group(
            vec![set_text("name", "x")],
            vec![vec![Value::Int(1), Value::String("deadbeef".into())]],
        )];
        let groups = apply_pk_binary(groups, Some(&[false, true])).unwrap();
        let pk = ["id".to_string(), "data".to_string()];
        let my = build_bulk_update_statements(DriverKind::Mysql, "d", "t", &pk, &groups).unwrap();
        assert!(
            my[0].ends_with("WHERE `id` = 1 AND `data` = X'deadbeef';"),
            "{my:?}"
        );
        let pg =
            build_bulk_update_statements(DriverKind::Postgres, "d", "t", &pk, &groups).unwrap();
        assert!(pg[0].contains("\"data\" = '\\xdeadbeef'"), "{pg:?}");
        let sl = build_bulk_update_statements(DriverKind::Sqlite, "d", "t", &pk, &groups).unwrap();
        assert!(sl[0].contains("\"data\" = X'deadbeef'"), "{sl:?}");
    }

    #[test]
    fn binary_pk_without_flags_is_passed_through_and_bad_hex_is_rejected() {
        let g = || {
            vec![group(
                vec![set_text("n", "x")],
                vec![vec![Value::String("zz'; DROP".into())]],
            )]
        };
        let same = apply_pk_binary(g(), None).unwrap();
        assert!(matches!(same[0].keys[0][0], Value::String(_)));
        assert!(apply_pk_binary(g(), Some(&[true])).is_err());
    }

    #[test]
    fn single_pk_groups_use_in_list_per_dialect() {
        let groups = vec![group(vec![set_text("name", "a'b")], keys1(&[1, 2, 3]))];
        let my = build_bulk_update_statements(
            DriverKind::Mysql,
            "shop",
            "users",
            &["id".to_string()],
            &groups,
        )
        .unwrap_or_default();
        assert_eq!(
            my,
            vec!["UPDATE `shop`.`users` SET `name` = 'a''b' WHERE `id` IN (1, 2, 3);".to_string()]
        );
        let pg = build_bulk_update_statements(
            DriverKind::Postgres,
            "public",
            "users",
            &["id".to_string()],
            &groups,
        )
        .unwrap_or_default();
        assert_eq!(
            pg,
            vec![
                "UPDATE \"public\".\"users\" SET \"name\" = 'a''b' WHERE \"id\" IN (1, 2, 3);"
                    .to_string()
            ]
        );
        // SQLite は DB 名で修飾しない。
        let lite = build_bulk_update_statements(
            DriverKind::Sqlite,
            "main",
            "users",
            &["id".to_string()],
            &groups,
        )
        .unwrap_or_default();
        assert!(lite[0].starts_with("UPDATE \"users\" SET"));
    }

    #[test]
    fn mysql_backslash_is_escaped_but_postgres_is_not() {
        let groups = vec![group(vec![set_text("p", "a\\b")], keys1(&[1]))];
        let pk = ["id".to_string()];
        let my = build_bulk_update_statements(DriverKind::Mysql, "d", "t", &pk, &groups)
            .unwrap_or_default();
        assert!(my[0].contains("'a\\\\b'"));
        let pg = build_bulk_update_statements(DriverKind::Postgres, "d", "t", &pk, &groups)
            .unwrap_or_default();
        assert!(pg[0].contains("'a\\b'"));
    }

    #[test]
    fn in_list_is_chunked_and_values_are_lossless_strings() {
        let mut keys = keys1(&(1..=1201).collect::<Vec<_>>());
        keys.push(vec![Value::String("9007199254740993".into())]);
        let groups = vec![group(
            vec![BulkSetColumn {
                column: "n".into(),
                value: BulkSetValue::Number {
                    text: "-1.5e3".into(),
                },
            }],
            keys,
        )];
        let out =
            build_bulk_update_statements(DriverKind::Mysql, "d", "t", &["id".to_string()], &groups)
                .unwrap_or_default();
        // 1202 件 → 500 + 500 + 202。
        assert_eq!(out.len(), 3);
        assert!(out[0].contains("SET `n` = -1.5e3 WHERE"));
        // 64bit 値は引用リテラルのまま (丸められない)。
        assert!(out[2].contains("'9007199254740993'"));
    }

    #[test]
    fn composite_and_null_keys_use_or_of_row_conditions() {
        let groups = vec![group(
            vec![BulkSetColumn {
                column: "c".into(),
                value: BulkSetValue::Null,
            }],
            vec![
                vec![Value::Int(1), Value::String("x".into())],
                vec![Value::Int(2), Value::Null],
            ],
        )];
        let out = build_bulk_update_statements(
            DriverKind::Postgres,
            "public",
            "t",
            &["a".to_string(), "b".to_string()],
            &groups,
        )
        .unwrap_or_default();
        assert_eq!(
            out,
            vec!["UPDATE \"public\".\"t\" SET \"c\" = NULL WHERE (\"a\" = 1 AND \"b\" = 'x') OR (\"a\" = 2 AND \"b\" IS NULL);".to_string()]
        );
        // 単一 PK でも NULL を含めば OR 形式 (IN は NULL に一致しない)。
        let g = vec![group(
            vec![set_text("c", "v")],
            vec![vec![Value::Null], vec![Value::Int(3)]],
        )];
        let out =
            build_bulk_update_statements(DriverKind::Mysql, "d", "t", &["id".to_string()], &g)
                .unwrap_or_default();
        assert!(out[0].contains("`id` IS NULL") && out[0].contains(" OR "));
    }

    #[test]
    fn bool_literal_follows_dialect_and_groups_stay_separate() {
        let groups = vec![
            group(
                vec![BulkSetColumn {
                    column: "f".into(),
                    value: BulkSetValue::Bool { value: true },
                }],
                keys1(&[1]),
            ),
            group(vec![set_text("f", "z")], keys1(&[2])),
        ];
        let pk = ["id".to_string()];
        let pg = build_bulk_update_statements(DriverKind::Postgres, "d", "t", &pk, &groups)
            .unwrap_or_default();
        assert_eq!(pg.len(), 2);
        assert!(pg[0].contains("\"f\" = TRUE"));
        let my = build_bulk_update_statements(DriverKind::Mysql, "d", "t", &pk, &groups)
            .unwrap_or_default();
        assert!(my[0].contains("`f` = 1"));
    }

    #[test]
    fn invalid_input_is_rejected() {
        let pk = ["id".to_string()];
        let bad_number = vec![group(
            vec![BulkSetColumn {
                column: "n".into(),
                value: BulkSetValue::Number {
                    text: "1; DROP TABLE t".into(),
                },
            }],
            keys1(&[1]),
        )];
        assert!(
            build_bulk_update_statements(DriverKind::Mysql, "d", "t", &pk, &bad_number).is_err()
        );
        let ok_group = vec![group(vec![set_text("a", "b")], keys1(&[1]))];
        assert!(build_bulk_update_statements(DriverKind::Mysql, "d", "t", &[], &ok_group).is_err());
        let mismatched = vec![group(
            vec![set_text("a", "b")],
            vec![vec![Value::Int(1), Value::Int(2)]],
        )];
        assert!(
            build_bulk_update_statements(DriverKind::Mysql, "d", "t", &pk, &mismatched).is_err()
        );
        // 空の SET / 空の keys のグループは無視する。
        let empty = vec![
            group(vec![], keys1(&[1])),
            group(vec![set_text("a", "b")], vec![]),
        ];
        assert!(
            build_bulk_update_statements(DriverKind::Mysql, "d", "t", &pk, &empty)
                .unwrap_or_default()
                .is_empty()
        );
    }

    #[test]
    fn generated_cells_convert_to_import_text() {
        use serde_json::json;
        assert_eq!(generated_cell_text(&json!(null)).unwrap_or_default(), None);
        assert_eq!(
            generated_cell_text(&json!(true)).unwrap_or_default(),
            Some("1".into())
        );
        assert_eq!(
            generated_cell_text(&json!(false)).unwrap_or_default(),
            Some("0".into())
        );
        assert_eq!(
            generated_cell_text(&json!(42)).unwrap_or_default(),
            Some("42".into())
        );
        assert_eq!(
            generated_cell_text(&json!("x")).unwrap_or_default(),
            Some("x".into())
        );
        assert!(generated_cell_text(&json!([1])).is_err());
    }
}
