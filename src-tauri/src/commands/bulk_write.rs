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
    ensure_allowed_for_session, record_write_history, run_query_transaction_inner,
};
use crate::db::data_diff::{is_numeric_literal, sql_literal};
use crate::db::sync::quote_ident;
use crate::db::types::{QueryResult, Value};
use crate::db::upsert::ImportConflict;
use crate::db::DriverKind;
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

/// グループ化された構造化入力から `UPDATE` 文を組み立てる (純関数)。
/// 単一 PK 列で NULL を含まないグループは `WHERE pk IN (…)` を [`IN_CHUNK`] 件ずつ、
/// それ以外 (複合 PK / NULL を含む) は行条件を `OR` で連結して [`OR_CHUNK`] 行ずつ
/// 1 文にする。
pub(crate) fn build_bulk_update_statements(
    driver: DriverKind,
    database: &str,
    table: &str,
    pk_columns: &[String],
    groups: &[BulkUpdateGroup],
) -> Result<Vec<String>> {
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
                out.push(format!(
                    "UPDATE {table_ref} SET {set_sql} WHERE {col} IN ({list});"
                ));
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
                out.push(format!("UPDATE {table_ref} SET {set_sql} WHERE {cond};"));
            }
        }
    }
    Ok(out)
}

/// 結果グリッドのセル編集をまとめて 1 トランザクションで適用する (#1259)。`groups` は
/// 同じ `SET` (列, 値) の行をまとめたもの、`extra_statements` は同じトランザクションに
/// 載せる削除予定行 / 新規行の `DELETE` / `INSERT` 文 (従来どおりフロントが生成)。
/// 全体が all-or-nothing で、read_only ガード・履歴・キャッシュ invalidate は
/// `run_query_transaction` と同一。
#[tauri::command]
pub async fn bulk_update_cells(
    session_id: String,
    database: Option<String>,
    table: String,
    pk_columns: Vec<String>,
    groups: Vec<BulkUpdateGroup>,
    extra_statements: Vec<String>,
    state: State<'_, AppState>,
) -> Result<QueryResult> {
    bulk_update_cells_inner(
        state.inner(),
        session_id,
        database,
        table,
        pk_columns,
        groups,
        extra_statements,
    )
    .await
}

/// Core of [`bulk_update_cells`] without Tauri's `State` wrapper (#881)。
pub(crate) async fn bulk_update_cells_inner(
    state: &AppState,
    session_id: String,
    database: Option<String>,
    table: String,
    pk_columns: Vec<String>,
    groups: Vec<BulkUpdateGroup>,
    extra_statements: Vec<String>,
) -> Result<QueryResult> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    let driver = session.conn.driver_kind();
    let mut statements = if groups.is_empty() {
        Vec::new()
    } else {
        build_bulk_update_statements(
            driver,
            database.as_deref().unwrap_or_default(),
            &table,
            &pk_columns,
            &groups,
        )?
    };
    statements.extend(extra_statements);
    if statements.is_empty() {
        return Ok(QueryResult::empty(0, 0));
    }
    run_query_transaction_inner(state, session_id, statements, database).await
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
