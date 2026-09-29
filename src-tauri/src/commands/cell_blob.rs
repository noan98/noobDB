//! BLOB / バイナリセルの生バイト取得 (#1148)。
//!
//! グリッドに載っている値は 16 進文字列の表示用コピーで、大きな値は列プレビューや
//! 切り詰めの対象になりうる。ファイル保存・画像プレビューは「その行のその列の
//! 生バイト」を主キーで引き直して使う。読み取り専用の `SELECT` だけを発行するので
//! `read_only` セッションでも通る (書き戻しは通常の `run_query` 経路で
//! バックエンドの読み取り専用ガードを受ける)。

use serde::Deserialize;
use tauri::State;
use tokio::io::AsyncReadExt;

use crate::db::data_diff::sql_literal;
use crate::db::sync::quote_ident;
use crate::db::types::Value;
use crate::db::DriverKind;
use crate::error::{AppError, Result};
use crate::state::AppState;

/// 取得・読み込みできる BLOB の上限 (16 MiB)。16 進文字列化すると 2 倍になり、
/// IPC と UPDATE 文の両方に載るため `write_binary_file` の上限より小さく取る。
const MAX_CELL_BLOB_BYTES: usize = 16 * 1024 * 1024;

/// 行を特定する主キー 1 列ぶん。
#[derive(Debug, Clone, Deserialize)]
pub struct CellKeyPart {
    pub column: String,
    pub value: Value,
}

/// 単一セルを主キーで引く `SELECT` を組み立てる (純関数)。キーが空・列名が空・
/// 主キー値が NULL/Bytes のときは拒否する (誤った行を引かないための保守的な検査)。
/// 行数の検証のため `LIMIT 2` を付ける。
fn build_cell_select(
    driver: DriverKind,
    database: Option<&str>,
    table: &str,
    column: &str,
    key: &[CellKeyPart],
) -> Result<String> {
    if table.trim().is_empty() || column.trim().is_empty() {
        return Err(AppError::InvalidInput("table / column is empty".into()));
    }
    if key.is_empty() {
        return Err(AppError::InvalidInput(
            "a primary key is required to fetch a cell".into(),
        ));
    }
    let table_ref = match (driver, database.map(str::trim).filter(|d| !d.is_empty())) {
        (DriverKind::Sqlite, _) | (_, None) => quote_ident(driver, table),
        (_, Some(db)) => format!("{}.{}", quote_ident(driver, db), quote_ident(driver, table)),
    };
    let mut conds = Vec::with_capacity(key.len());
    for part in key {
        if part.column.trim().is_empty() {
            return Err(AppError::InvalidInput("key column is empty".into()));
        }
        let lit = match &part.value {
            Value::Null | Value::Bytes(_) => {
                return Err(AppError::InvalidInput(
                    "primary key value must not be NULL or binary".into(),
                ))
            }
            v => sql_literal(driver, v),
        };
        conds.push(format!("{} = {}", quote_ident(driver, &part.column), lit));
    }
    Ok(format!(
        "SELECT {} FROM {} WHERE {} LIMIT 2",
        quote_ident(driver, column),
        table_ref,
        conds.join(" AND ")
    ))
}

/// 主キーで 1 セルの生バイトを取得し、16 進文字列 (小文字) で返す。NULL は `None`。
/// 該当行が 1 行に定まらない (0 件 / 複数件) ときはエラー。
#[tauri::command]
pub async fn fetch_cell_bytes(
    session_id: String,
    database: Option<String>,
    table: String,
    column: String,
    key: Vec<CellKeyPart>,
    state: State<'_, AppState>,
) -> Result<Option<String>> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    let driver = session.conn.driver_kind();
    let sql = build_cell_select(driver, database.as_deref(), &table, &column, &key)?;
    let result = session.conn.execute(&sql, database.as_deref()).await?;
    if result.rows.len() != 1 {
        return Err(AppError::InvalidInput(format!(
            "expected exactly one row for the key, got {}",
            result.rows.len()
        )));
    }
    let cell = result
        .rows
        .into_iter()
        .next()
        .and_then(|r| r.into_iter().next())
        .unwrap_or(Value::Null);
    match cell {
        Value::Null => Ok(None),
        Value::Bytes(hex) => {
            if hex.len() / 2 > MAX_CELL_BLOB_BYTES {
                return Err(AppError::InvalidInput(format!(
                    "value too large ({} bytes, limit {} bytes)",
                    hex.len() / 2,
                    MAX_CELL_BLOB_BYTES
                )));
            }
            Ok(Some(hex))
        }
        _ => Err(AppError::InvalidInput(
            "the column is not a binary column".into(),
        )),
    }
}

/// ファイルを読み、16 進文字列 (小文字) で返す。BLOB 列への書き戻し (UPDATE 生成) 用。
/// 実読み取りバイト数で上限を強制する (`read_text_file` と同じ理由で `take`)。
#[tauri::command]
pub async fn read_binary_file(path: String) -> Result<String> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidInput("file path is empty".into()));
    }
    let file = tokio::fs::File::open(&path).await?;
    let mut limited = file.take(MAX_CELL_BLOB_BYTES as u64 + 1);
    let mut bytes = Vec::new();
    limited.read_to_end(&mut bytes).await?;
    if bytes.len() > MAX_CELL_BLOB_BYTES {
        return Err(AppError::InvalidInput(format!(
            "file too large to load into a cell (limit {MAX_CELL_BLOB_BYTES} bytes)"
        )));
    }
    Ok(data_encoding::HEXLOWER.encode(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(col: &str, v: Value) -> CellKeyPart {
        CellKeyPart {
            column: col.into(),
            value: v,
        }
    }

    #[test]
    fn builds_select_per_driver() {
        let k = [key("id", Value::Int(7))];
        assert_eq!(
            build_cell_select(DriverKind::Mysql, Some("app"), "files", "data", &k).unwrap(),
            "SELECT `data` FROM `app`.`files` WHERE `id` = 7 LIMIT 2"
        );
        assert_eq!(
            build_cell_select(DriverKind::Postgres, Some("public"), "files", "data", &k).unwrap(),
            "SELECT \"data\" FROM \"public\".\"files\" WHERE \"id\" = 7 LIMIT 2"
        );
        assert_eq!(
            build_cell_select(DriverKind::Sqlite, Some("main"), "files", "data", &k).unwrap(),
            "SELECT \"data\" FROM \"files\" WHERE \"id\" = 7 LIMIT 2"
        );
    }

    #[test]
    fn composite_key_and_string_escaping() {
        let k = [
            key("a", Value::String("o'x".into())),
            key("b", Value::Int(2)),
        ];
        let sql = build_cell_select(DriverKind::Sqlite, None, "t", "c", &k).unwrap();
        assert_eq!(
            sql,
            "SELECT \"c\" FROM \"t\" WHERE \"a\" = 'o''x' AND \"b\" = 2 LIMIT 2"
        );
    }

    #[test]
    fn rejects_unsafe_keys() {
        assert!(build_cell_select(DriverKind::Mysql, None, "t", "c", &[]).is_err());
        assert!(
            build_cell_select(DriverKind::Mysql, None, "t", "c", &[key("id", Value::Null)])
                .is_err()
        );
        assert!(build_cell_select(
            DriverKind::Mysql,
            None,
            "t",
            "c",
            &[key("id", Value::Bytes("00".into()))]
        )
        .is_err());
        assert!(build_cell_select(
            DriverKind::Mysql,
            None,
            "",
            "c",
            &[key("id", Value::Int(1))]
        )
        .is_err());
    }

    #[tokio::test]
    async fn read_binary_file_returns_hex() {
        let path = std::env::temp_dir().join(format!("noobdb_blob_{}.bin", std::process::id()));
        tokio::fs::write(&path, [0u8, 0xff, 0x10]).await.unwrap();
        let hex = read_binary_file(path.to_string_lossy().into_owned())
            .await
            .unwrap();
        assert_eq!(hex, "00ff10");
        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn read_binary_file_rejects_empty_path_and_missing() {
        assert!(matches!(
            read_binary_file(" ".into()).await.unwrap_err(),
            AppError::InvalidInput(_)
        ));
        assert!(matches!(
            read_binary_file("/nonexistent/noobdb/x.bin".into())
                .await
                .unwrap_err(),
            AppError::Io(_)
        ));
    }
}
