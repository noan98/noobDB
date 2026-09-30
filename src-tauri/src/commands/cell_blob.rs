//! BLOB / バイナリセルの生バイト取得 (#1148)。
//!
//! グリッドに載っている値は 16 進文字列の表示用コピーで、大きな値は列プレビューや
//! 切り詰めの対象になりうる。ファイル保存・画像プレビューは「その行のその列の
//! 生バイト」を主キーで引き直して使う。読み取り専用の `SELECT` だけを発行するので
//! `read_only` セッションでも通る (書き戻しは通常の `run_query` 経路で
//! バックエンドの読み取り専用ガードを受ける)。

use serde::{Deserialize, Serialize};
use tauri::ipc::Response;
use tauri::State;
use tokio::io::AsyncReadExt;

use crate::db::data_diff::sql_literal;
use crate::db::sync::quote_ident;
use crate::db::types::Value;
use crate::db::DriverKind;
use crate::error::{AppError, Result};
use crate::state::{AppState, Session};

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
    build_cell_query(driver, database, table, column, key, |col| col.to_string())
}

/// 選択リスト (`project` がクォート済みの列名から式を作る) だけを差し替えた
/// 単一セル引きの SQL。`build_cell_select` と probe が WHERE 句の組み立てを共有する。
fn build_cell_query(
    driver: DriverKind,
    database: Option<&str>,
    table: &str,
    column: &str,
    key: &[CellKeyPart],
    project: impl Fn(&str) -> String,
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
        project(&quote_ident(driver, column)),
        table_ref,
        conds.join(" AND ")
    ))
}

/// probe が先頭から読むバイト数。マジックバイト判定 (PNG の 8 バイトが最長) と
/// BMP の「14 バイト以上」判定に足りる長さ。
const PROBE_HEAD_BYTES: usize = 16;

/// サイズと先頭バイトだけを返す probe 用の `SELECT` (純関数)。BLOB 本体を DB から
/// 転送せずにサイズ・種別を知るため、長さ関数と先頭 16 バイトの部分取得をサーバ側で
/// 評価する (#1258)。3 ドライバで同じ 2 列 (サイズ, 先頭の 16 進) を返す。
fn build_cell_probe_select(
    driver: DriverKind,
    database: Option<&str>,
    table: &str,
    column: &str,
    key: &[CellKeyPart],
) -> Result<String> {
    build_cell_query(driver, database, table, column, key, |col| match driver {
        DriverKind::Mysql => {
            format!("OCTET_LENGTH({col}), HEX(SUBSTRING({col}, 1, {PROBE_HEAD_BYTES}))")
        }
        DriverKind::Postgres => format!(
            "octet_length({col}), encode(substring({col} from 1 for {PROBE_HEAD_BYTES}), 'hex')"
        ),
        // TEXT 型で入った値でも「バイト数」を返すよう BLOB へキャストする
        // (BLOB 値ならキャストは no-op)。
        DriverKind::Sqlite => format!(
            "LENGTH(CAST({col} AS BLOB)), HEX(SUBSTR(CAST({col} AS BLOB), 1, {PROBE_HEAD_BYTES}))"
        ),
    })
}

/// マジックバイトから推定した BLOB の種別。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BlobKind {
    pub mime: &'static str,
    /// 保存ダイアログの既定拡張子 (ドット無し)。
    pub ext: &'static str,
    /// `<img>` でそのまま描画できる画像か。
    pub image: bool,
}

/// 先頭バイトから MIME を推定する。判別できなければ `None`。
/// (フロントの旧 `detectBlobKind` と同じ判定表。判定はこの 1 か所に集約した)
pub fn detect_blob_kind(head: &[u8]) -> Option<BlobKind> {
    let starts = |sig: &[u8], off: usize| {
        head.len() >= off + sig.len() && &head[off..off + sig.len()] == sig
    };
    let kind = |mime, ext, image| Some(BlobKind { mime, ext, image });
    if starts(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0) {
        kind("image/png", "png", true)
    } else if starts(&[0xff, 0xd8, 0xff], 0) {
        kind("image/jpeg", "jpg", true)
    } else if starts(b"GIF87a", 0) || starts(b"GIF89a", 0) {
        kind("image/gif", "gif", true)
    } else if starts(b"RIFF", 0) && starts(b"WEBP", 8) {
        kind("image/webp", "webp", true)
    } else if starts(b"BM", 0) && head.len() >= 14 {
        kind("image/bmp", "bmp", true)
    } else if starts(b"%PDF-", 0) {
        kind("application/pdf", "pdf", false)
    } else if starts(&[0x1f, 0x8b], 0) {
        kind("application/gzip", "gz", false)
    } else if starts(&[0x50, 0x4b, 0x03, 0x04], 0) {
        kind("application/zip", "zip", false)
    } else {
        None
    }
}

/// `probe_cell_blob` の結果。本体を運ばずにサイズと種別だけをフロントへ返す。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellBlobProbe {
    /// 生バイト数。
    pub size: u64,
    /// 推定 MIME (判別不能なら `None`)。
    pub mime: Option<String>,
    /// 保存ダイアログの既定拡張子 (判別不能なら `None`)。
    pub ext: Option<String>,
    /// `<img>` で描画できる画像か。
    pub image: bool,
}

/// probe の結果行 (サイズ, 先頭の 16 進) を解釈する。NULL は `None`。
fn interpret_probe_row(mut row: Vec<Value>) -> Result<Option<CellBlobProbe>> {
    if row.len() < 2 {
        return Err(AppError::InvalidInput("unexpected probe result".into()));
    }
    let head_cell = row.swap_remove(1);
    let size_cell = row.swap_remove(0);
    let size = match size_cell {
        Value::Null => return Ok(None),
        Value::Int(n) if n >= 0 => n as u64,
        Value::UInt(n) => n,
        Value::String(s) => s
            .trim()
            .parse::<u64>()
            .map_err(|_| AppError::InvalidInput("unexpected probe size".into()))?,
        _ => return Err(AppError::InvalidInput("unexpected probe size".into())),
    };
    // HEX() の結果はドライバによって文字列またはバイナリ (= ASCII の 16 進を
    // さらに 16 進化したもの) で届くので、どちらも受ける。
    let head_hex = match head_cell {
        Value::Null => String::new(),
        Value::String(s) => s,
        Value::Bytes(h) => decode_hex(&h)
            .and_then(|b| String::from_utf8(b).ok())
            .unwrap_or_default(),
        _ => String::new(),
    };
    let head = decode_hex(&head_hex).unwrap_or_default();
    let kind = detect_blob_kind(&head);
    Ok(Some(CellBlobProbe {
        size,
        mime: kind.as_ref().map(|k| k.mime.to_string()),
        ext: kind.as_ref().map(|k| k.ext.to_string()),
        image: kind.as_ref().is_some_and(|k| k.image),
    }))
}

/// 大文字・小文字どちらの 16 進文字列もバイト列へ戻す。不正なら `None`。
fn decode_hex(hex: &str) -> Option<Vec<u8>> {
    data_encoding::HEXLOWER_PERMISSIVE
        .decode(hex.as_bytes())
        .ok()
}

/// 主キーで 1 セルの probe (サイズ + 種別) を取得する。NULL は `None`。
/// 該当行が 1 行に定まらないときはエラー。
#[tauri::command]
pub async fn probe_cell_blob(
    session_id: String,
    database: Option<String>,
    table: String,
    column: String,
    key: Vec<CellKeyPart>,
    state: State<'_, AppState>,
) -> Result<Option<CellBlobProbe>> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    probe_blob(&session, database.as_deref(), &table, &column, &key).await
}

/// `probe_cell_blob` の本体 (セッションを受ける。統合テストからも呼ぶ)。
pub(crate) async fn probe_blob(
    session: &Session,
    database: Option<&str>,
    table: &str,
    column: &str,
    key: &[CellKeyPart],
) -> Result<Option<CellBlobProbe>> {
    let driver = session.conn.driver_kind();
    let sql = build_cell_probe_select(driver, database, table, column, key)?;
    let result = session.conn.execute(&sql, database).await?;
    if result.rows.len() != 1 {
        return Err(AppError::InvalidInput(format!(
            "expected exactly one row for the key, got {}",
            result.rows.len()
        )));
    }
    match result.rows.into_iter().next() {
        Some(row) => interpret_probe_row(row),
        None => Ok(None),
    }
}

/// 主キーで 1 セルの生バイトを取得する (NULL は `None`)。上限 (16 MiB) 超過・
/// 非バイナリ列・行が 1 行に定まらないときはエラー。取得とデコードをここに集約し、
/// プレビュー取得 (`fetch_cell_bytes`) とファイル保存 (`save_cell_to_file`) が共有する。
pub(crate) async fn fetch_cell_blob(
    session: &Session,
    database: Option<&str>,
    table: &str,
    column: &str,
    key: &[CellKeyPart],
) -> Result<Option<Vec<u8>>> {
    let driver = session.conn.driver_kind();
    let sql = build_cell_select(driver, database, table, column, key)?;
    let result = session.conn.execute(&sql, database).await?;
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
            decode_hex(&hex)
                .map(Some)
                .ok_or_else(|| AppError::Other("invalid hex in binary cell".into()))
        }
        _ => Err(AppError::InvalidInput(
            "the column is not a binary column".into(),
        )),
    }
}

/// 主キーで 1 セルの生バイトを取得し、生バイト列のまま返す (#1148 / #1258)。
/// `tauri::ipc::Response` で返すので JS は `ArrayBuffer` で受け取り、16 進文字列や
/// JSON 配列を経由しない。NULL セルと非バイナリ列はエラー (NULL の判別は
/// `probe_cell_blob` が先に行う)。該当行が 1 行に定まらないときもエラー。
#[tauri::command]
pub async fn fetch_cell_bytes(
    session_id: String,
    database: Option<String>,
    table: String,
    column: String,
    key: Vec<CellKeyPart>,
    state: State<'_, AppState>,
) -> Result<Response> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    let bytes = fetch_cell_blob(&session, database.as_deref(), &table, &column, &key)
        .await?
        .ok_or_else(|| AppError::InvalidInput("the cell is NULL".into()))?;
    Ok(Response::new(bytes))
}

/// 主キーで 1 セルの生バイトを取得し、そのままユーザが選んだ `path` へ書き出す
/// (#1258)。DB → ファイルが Rust 内で完結し、BLOB が IPC を一切通らない。書き込んだ
/// バイト数を返す。NULL セルはエラー (フロントは事前に `probe_cell_blob` で判別する)。
#[tauri::command]
pub async fn save_cell_to_file(
    session_id: String,
    database: Option<String>,
    table: String,
    column: String,
    key: Vec<CellKeyPart>,
    path: String,
    state: State<'_, AppState>,
) -> Result<u64> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidInput("save path is empty".into()));
    }
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    let bytes = fetch_cell_blob(&session, database.as_deref(), &table, &column, &key)
        .await?
        .ok_or_else(|| AppError::InvalidInput("the cell is NULL".into()))?;
    tokio::fs::write(&path, &bytes).await?;
    Ok(bytes.len() as u64)
}

/// ファイルを読み、生バイト列のまま返す (#1258)。BLOB 列への書き戻し (UPDATE 生成)
/// 用で、JS は `ArrayBuffer` で受ける。実読み取りバイト数で上限を強制する
/// (`read_text_file` と同じ理由で `take`)。
#[tauri::command]
pub async fn read_binary_file(path: String) -> Result<Response> {
    Ok(Response::new(read_file_limited(&path).await?))
}

/// 空パスを拒否し、上限 (16 MiB) を超えないことを保証してファイル全体を読む。
async fn read_file_limited(path: &str) -> Result<Vec<u8>> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidInput("file path is empty".into()));
    }
    let file = tokio::fs::File::open(path).await?;
    let mut limited = file.take(MAX_CELL_BLOB_BYTES as u64 + 1);
    let mut bytes = Vec::new();
    limited.read_to_end(&mut bytes).await?;
    if bytes.len() > MAX_CELL_BLOB_BYTES {
        return Err(AppError::InvalidInput(format!(
            "file too large to load into a cell (limit {MAX_CELL_BLOB_BYTES} bytes)"
        )));
    }
    Ok(bytes)
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
    async fn read_file_limited_returns_raw_bytes() {
        let path = std::env::temp_dir().join(format!("noobdb_blob_{}.bin", std::process::id()));
        tokio::fs::write(&path, [0u8, 0xff, 0x10]).await.unwrap();
        let bytes = read_file_limited(&path.to_string_lossy()).await.unwrap();
        assert_eq!(bytes, vec![0u8, 0xff, 0x10]);
        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn read_file_limited_rejects_empty_path_missing_and_oversize() {
        assert!(matches!(
            read_file_limited(" ").await.unwrap_err(),
            AppError::InvalidInput(_)
        ));
        assert!(matches!(
            read_file_limited("/nonexistent/noobdb/x.bin")
                .await
                .unwrap_err(),
            AppError::Io(_)
        ));
        let path = std::env::temp_dir().join(format!("noobdb_blob_big_{}.bin", std::process::id()));
        tokio::fs::write(&path, vec![1u8; MAX_CELL_BLOB_BYTES + 1])
            .await
            .unwrap();
        assert!(matches!(
            read_file_limited(&path.to_string_lossy())
                .await
                .unwrap_err(),
            AppError::InvalidInput(_)
        ));
        let _ = tokio::fs::remove_file(&path).await;
    }

    #[test]
    fn builds_probe_select_per_driver() {
        let k = [key("id", Value::Int(7))];
        assert_eq!(
            build_cell_probe_select(DriverKind::Mysql, Some("app"), "files", "data", &k).unwrap(),
            "SELECT OCTET_LENGTH(`data`), HEX(SUBSTRING(`data`, 1, 16)) FROM `app`.`files` WHERE `id` = 7 LIMIT 2"
        );
        assert_eq!(
            build_cell_probe_select(DriverKind::Postgres, Some("public"), "files", "data", &k)
                .unwrap(),
            "SELECT octet_length(\"data\"), encode(substring(\"data\" from 1 for 16), 'hex') FROM \"public\".\"files\" WHERE \"id\" = 7 LIMIT 2"
        );
        assert_eq!(
            build_cell_probe_select(DriverKind::Sqlite, None, "files", "data", &k).unwrap(),
            "SELECT LENGTH(CAST(\"data\" AS BLOB)), HEX(SUBSTR(CAST(\"data\" AS BLOB), 1, 16)) FROM \"files\" WHERE \"id\" = 7 LIMIT 2"
        );
        assert!(build_cell_probe_select(DriverKind::Mysql, None, "t", "c", &[]).is_err());
    }

    #[test]
    fn detects_blob_kinds() {
        let png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0];
        assert_eq!(
            detect_blob_kind(&png),
            Some(BlobKind {
                mime: "image/png",
                ext: "png",
                image: true
            })
        );
        assert_eq!(
            detect_blob_kind(&[0xff, 0xd8, 0xff, 0xe0]).unwrap().mime,
            "image/jpeg"
        );
        assert_eq!(detect_blob_kind(b"GIF89a....").unwrap().mime, "image/gif");
        assert_eq!(detect_blob_kind(b"GIF87a").unwrap().ext, "gif");
        assert_eq!(
            detect_blob_kind(b"RIFF\0\0\0\0WEBPVP8 ").unwrap().mime,
            "image/webp"
        );
        assert!(detect_blob_kind(b"RIFF\0\0\0\0WAVEfmt ").is_none());
        // BMP は 14 バイト以上のときだけ画像とみなす。
        assert!(detect_blob_kind(b"BM").is_none());
        assert_eq!(
            detect_blob_kind(&[b'B', b'M', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
                .unwrap()
                .mime,
            "image/bmp"
        );
        let pdf = detect_blob_kind(b"%PDF-1.7").unwrap();
        assert_eq!((pdf.mime, pdf.image), ("application/pdf", false));
        assert_eq!(detect_blob_kind(&[0x1f, 0x8b, 8]).unwrap().ext, "gz");
        assert_eq!(
            detect_blob_kind(&[0x50, 0x4b, 0x03, 0x04]).unwrap().ext,
            "zip"
        );
        assert!(detect_blob_kind(&[0x50, 0x4b, 0x05, 0x06]).is_none());
        assert!(detect_blob_kind(&[]).is_none());
        assert!(detect_blob_kind(b"hello world").is_none());
    }

    #[test]
    fn interprets_probe_rows() {
        let png_hex = "89504E470D0A1A0A0000000000000000".to_string();
        let p = interpret_probe_row(vec![Value::Int(1234), Value::String(png_hex.clone())])
            .unwrap()
            .unwrap();
        assert_eq!(p.size, 1234);
        assert_eq!(p.mime.as_deref(), Some("image/png"));
        assert_eq!(p.ext.as_deref(), Some("png"));
        assert!(p.image);

        // HEX() がバイナリ列として届くドライバ (ASCII をさらに 16 進化)。
        let double = data_encoding::HEXLOWER.encode(png_hex.as_bytes());
        let p = interpret_probe_row(vec![Value::UInt(9), Value::Bytes(double)])
            .unwrap()
            .unwrap();
        assert!(p.image);

        // 判別不能・空 BLOB。
        let p = interpret_probe_row(vec![Value::Int(0), Value::String(String::new())])
            .unwrap()
            .unwrap();
        assert_eq!((p.size, p.mime, p.image), (0, None, false));

        // NULL セル。
        assert!(interpret_probe_row(vec![Value::Null, Value::Null])
            .unwrap()
            .is_none());
        assert!(interpret_probe_row(vec![Value::Int(1)]).is_err());
        assert!(interpret_probe_row(vec![Value::Float(1.5), Value::Null]).is_err());
    }
}
