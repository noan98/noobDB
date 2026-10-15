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
/// (本体取得は `build_cell_probe_body_select` に統合したので、今はテストの基準にだけ使う。)
#[cfg(test)]
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

/// probe (サイズ + 先頭 16 進) に加え、**サイズが上限以下のときだけ**本体も 1 文で返す
/// `SELECT` (純関数、#1609)。上限超過の判定はサーバ側の `CASE` で行うので、巨大な値は
/// 転送されず本体の列が NULL になる。probe → 本体の 2 往復を 1 往復にするために使う。
fn build_cell_probe_body_select(
    driver: DriverKind,
    database: Option<&str>,
    table: &str,
    column: &str,
    key: &[CellKeyPart],
) -> Result<String> {
    let max = MAX_CELL_BLOB_BYTES;
    build_cell_query(driver, database, table, column, key, |col| match driver {
        DriverKind::Mysql => format!(
            "OCTET_LENGTH({col}), HEX(SUBSTRING({col}, 1, {PROBE_HEAD_BYTES})), \
             CASE WHEN OCTET_LENGTH({col}) <= {max} THEN {col} END"
        ),
        DriverKind::Postgres => format!(
            "octet_length({col}), encode(substring({col} from 1 for {PROBE_HEAD_BYTES}), 'hex'), \
             CASE WHEN octet_length({col}) <= {max} THEN {col} END"
        ),
        DriverKind::Sqlite => format!(
            "LENGTH(CAST({col} AS BLOB)), HEX(SUBSTR(CAST({col} AS BLOB), 1, {PROBE_HEAD_BYTES})), \
             CASE WHEN LENGTH(CAST({col} AS BLOB)) <= {max} THEN {col} END"
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
fn interpret_probe_row(row: Vec<Value>) -> Result<Option<CellBlobProbe>> {
    interpret_probe_body_row(row).map(|r| r.map(|(probe, _)| probe))
}

/// probe + 本体の結果行 (サイズ, 先頭の 16 進, 本体) を解釈する (#1609)。本体の列が
/// 無い probe 専用の行 (2 列) では本体は `Value::Null` として返す。
fn interpret_probe_body_row(mut row: Vec<Value>) -> Result<Option<(CellBlobProbe, Value)>> {
    if row.len() < 2 {
        return Err(AppError::InvalidInput("unexpected probe result".into()));
    }
    let body = if row.len() > 2 {
        row.swap_remove(2)
    } else {
        Value::Null
    };
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
    Ok(Some((
        CellBlobProbe {
            size,
            mime: kind.as_ref().map(|k| k.mime.to_string()),
            ext: kind.as_ref().map(|k| k.ext.to_string()),
            image: kind.as_ref().is_some_and(|k| k.image),
        },
        body,
    )))
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
    // サイズ確認と本体取得を 1 往復で行う (#1609)。上限超過の判定はサーバ側の
    // `CASE` が行い、巨大な BLOB は全量転送・16 進化されない (#1530)。
    match fetch_probe_and_body(session, database, table, column, key).await? {
        None => Ok(None),
        Some((p, _)) if p.size > MAX_CELL_BLOB_BYTES as u64 => {
            Err(AppError::InvalidInput(format!(
                "value too large ({} bytes, limit {} bytes)",
                p.size, MAX_CELL_BLOB_BYTES
            )))
        }
        Some((_, body)) => Ok(body),
    }
}

/// probe (サイズ + 種別) と、上限以下なら本体を 1 文で取得する (#1609)。NULL セルは
/// `None`。サイズが上限を超えるときは本体を転送せず `(probe, None)`。該当行が 1 行に
/// 定まらないとき・非バイナリ列のときはエラー。`fetch_cell_blob` とフォルダ一括保存
/// (`save_cells_to_folder`) が共有する。
async fn fetch_probe_and_body(
    session: &Session,
    database: Option<&str>,
    table: &str,
    column: &str,
    key: &[CellKeyPart],
) -> Result<Option<(CellBlobProbe, Option<Vec<u8>>)>> {
    let driver = session.conn.driver_kind();
    let sql = build_cell_probe_body_select(driver, database, table, column, key)?;
    let result = session.conn.execute(&sql, database).await?;
    if result.rows.len() != 1 {
        return Err(AppError::InvalidInput(format!(
            "expected exactly one row for the key, got {}",
            result.rows.len()
        )));
    }
    let Some(row) = result.rows.into_iter().next() else {
        return Ok(None);
    };
    let Some((probe, cell)) = interpret_probe_body_row(row)? else {
        return Ok(None);
    };
    if probe.size > MAX_CELL_BLOB_BYTES as u64 {
        return Ok(Some((probe, None)));
    }
    let body = decode_body_cell(cell)?;
    Ok(Some((probe, body)))
}

/// 本体のセル (16 進の `Value::Bytes`) をバイト列へ戻す。NULL は `None`、
/// 非バイナリ列はエラー。
fn decode_body_cell(cell: Value) -> Result<Option<Vec<u8>>> {
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

/// フォルダ一括保存の行数上限。
const MAX_FOLDER_EXPORT_ROWS: usize = 10_000;

/// フォルダ一括保存でスキップ / 失敗した行 1 件。`row` は渡した `keys` の添字。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobFolderIssue {
    pub row: u32,
    pub error: String,
}

/// `save_cells_to_folder` の結果。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobFolderSaveResult {
    /// 保存したファイル数。
    pub saved: u32,
    /// 保存した合計バイト数。
    pub total_bytes: u64,
    /// NULL のセルで保存しなかった行数。
    pub skipped_null: u32,
    /// 上限 (16 MiB) を超えて保存しなかった行数。
    pub skipped_too_large: u32,
    /// 取得・書き込みに失敗した行数。
    pub failed: u32,
    /// 失敗した行の理由 (先頭 20 件まで)。
    pub errors: Vec<BlobFolderIssue>,
    /// 対応表 (CSV) を書いたときのファイル名 (フォルダ内の名前)。書かなかったときは `None` (#1624)。
    pub manifest_file: Option<String>,
}

/// 対応表 (`manifest.csv`) の 1 行ぶん (#1624)。保存の成否にかかわらず 1 行ずつ作る。
struct ManifestRow {
    key: Vec<String>,
    file: Option<String>,
    bytes: Option<u64>,
    mime: Option<String>,
    status: &'static str,
    error: Option<String>,
}

/// 主キーの値を対応表のセルに出す文字列にする (ファイル名用の置換はしない)。
fn manifest_key_text(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::Int(n) => n.to_string(),
        Value::UInt(n) => n.to_string(),
        Value::Float(f) => f.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::String(s) => s.clone(),
        Value::Bytes(h) => format!("0x{h}"),
    }
}

/// 対応表を CSV 本文にする (純関数)。ヘッダは `row`、主キー列ごとの `key_<列名>`、`file`、
/// `bytes`、`mime`、`status`、`error`。エスケープと数式の無害化は CSV エクスポートと同じ。
fn render_manifest(key_columns: &[String], rows: &[ManifestRow]) -> String {
    use crate::commands::export::csv_field;
    let mut out = String::new();
    let mut header: Vec<String> = vec!["row".into()];
    header.extend(key_columns.iter().map(|c| format!("key_{c}")));
    header.extend(
        ["file", "bytes", "mime", "status", "error"]
            .iter()
            .map(|s| s.to_string()),
    );
    out.push_str(
        &header
            .iter()
            .map(|h| csv_field(h).into_owned())
            .collect::<Vec<_>>()
            .join(","),
    );
    out.push_str("\r\n");
    for (i, r) in rows.iter().enumerate() {
        let mut cells: Vec<String> = vec![(i + 1).to_string()];
        cells.extend(r.key.iter().map(|k| csv_field(k).into_owned()));
        cells.push(csv_field(r.file.as_deref().unwrap_or("")).into_owned());
        cells.push(r.bytes.map(|b| b.to_string()).unwrap_or_default());
        cells.push(csv_field(r.mime.as_deref().unwrap_or("")).into_owned());
        cells.push(r.status.to_string());
        cells.push(csv_field(r.error.as_deref().unwrap_or("")).into_owned());
        out.push_str(&cells.join(","));
        out.push_str("\r\n");
    }
    out
}

/// 失敗理由として返す件数の上限 (IPC を肥大させない)。
const MAX_REPORTED_ERRORS: usize = 20;

/// 主キーの値 1 つをファイル名の断片にする。区切り・制御文字・予約記号は `_` に置き換える。
fn key_value_fragment(v: &Value) -> String {
    let raw = match v {
        Value::Null => "null".to_string(),
        Value::Int(n) => n.to_string(),
        Value::UInt(n) => n.to_string(),
        Value::Float(f) => f.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::String(s) => s.clone(),
        Value::Bytes(h) => h.clone(),
    };
    raw.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric()
                || matches!(c, '-' | '_' | '.')
                || (!c.is_ascii() && c.is_alphanumeric())
            {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// ファイル名の幹に使うバイト数の上限 (拡張子・`_N` の連番を足しても 255 バイトに収まる)。
const MAX_STEM_BYTES: usize = 100;

/// 主キーからファイル名の幹 (拡張子なし) を作る (純関数)。複数列のキーは `-` でつなぐ。
/// 先頭のドットは外し (隠しファイル・`..` 対策)、長さを丸め、Windows の予約名
/// (`CON` など) は避ける。空になったら `row<行番号>`。
fn blob_file_stem(key: &[CellKeyPart], row_number: usize) -> String {
    let joined = key
        .iter()
        .map(|p| key_value_fragment(&p.value))
        .collect::<Vec<_>>()
        .join("-");
    // 長さはバイト数で数える (多くのファイルシステムは名前を 255 バイトに制限する)。
    // UTF-8 の文字境界で切る。
    let mut trimmed = joined.trim_start_matches('.').to_string();
    if trimmed.len() > MAX_STEM_BYTES {
        let mut end = MAX_STEM_BYTES;
        while !trimmed.is_char_boundary(end) {
            end -= 1;
        }
        trimmed.truncate(end);
    }
    let trimmed = trimmed.trim_end_matches('.').to_string();
    if trimmed.is_empty() {
        return format!("row{row_number}");
    }
    // Windows は `CON.txt` のように最初のドットより前が予約名ならデバイス扱いにする。
    let base = trimmed.split('.').next().unwrap_or("");
    let upper = base.trim_end().to_ascii_uppercase();
    let reserved = matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (upper.len() == 4
            && (upper.starts_with("COM") || upper.starts_with("LPT"))
            && upper.ends_with(|c: char| c.is_ascii_digit()));
    if reserved {
        format!("_{trimmed}")
    } else {
        trimmed
    }
}

/// `folder` の中で未使用のファイルを排他的に作って返す (既存ファイルは決して上書きしない)。
/// 同じ名前が既にあるか、この一括保存の中で使用済み (大文字小文字を無視) なら `_2`, `_3`… を付ける。
async fn create_unique_file(
    folder: &std::path::Path,
    stem: &str,
    ext: &str,
    used: &mut std::collections::HashSet<String>,
) -> Result<(tokio::fs::File, std::path::PathBuf)> {
    for n in 1..=10_000u32 {
        let name = if n == 1 {
            format!("{stem}.{ext}")
        } else {
            format!("{stem}_{n}.{ext}")
        };
        if used.contains(&name.to_lowercase()) {
            continue;
        }
        let path = folder.join(&name);
        match tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .await
        {
            Ok(f) => {
                used.insert(name.to_lowercase());
                return Ok((f, path));
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                used.insert(name.to_lowercase());
            }
            Err(e) => return Err(e.into()),
        }
    }
    Err(AppError::Other(format!(
        "could not find a free file name for '{stem}'"
    )))
}

/// 複数行の BLOB 列を、主キー由来のファイル名で 1 つのフォルダへ書き出す (#1539)。
/// `keys` は行ごとの主キー (`save_cell_to_file` の `key` と同じ形)。DB → ファイルは
/// Rust 内で完結し BLOB は IPC を通らない。行ごとに probe でサイズと種別を調べ、
/// NULL は飛ばし、上限 (16 MiB) 超過は飛ばし、拡張子は種別 (判別不能は `bin`) から決める。
/// 既存のファイルは上書きせず `_2` などを付ける。1 行の失敗で全体は止めず、件数と
/// 先頭の失敗理由を返す。読み取りの SELECT だけなので read_only セッションでも使える。
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri コマンドの引数は IPC の形そのもので、まとめられない
pub async fn save_cells_to_folder(
    session_id: String,
    database: Option<String>,
    table: String,
    column: String,
    keys: Vec<Vec<CellKeyPart>>,
    folder: String,
    // true なら保存先に対応表 (`manifest.csv`: 行・主キー・保存ファイル名・サイズ・種別・結果) も書く (#1624)。
    write_manifest: Option<bool>,
    state: State<'_, AppState>,
) -> Result<BlobFolderSaveResult> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    save_cells_to_folder_inner(
        &session,
        database.as_deref(),
        &table,
        &column,
        &keys,
        &folder,
        write_manifest.unwrap_or(false),
    )
    .await
}

/// [`save_cells_to_folder`] の本体 (セッションを受ける。統合テストからも呼ぶ)。
pub(crate) async fn save_cells_to_folder_inner(
    session: &Session,
    database: Option<&str>,
    table: &str,
    column: &str,
    keys: &[Vec<CellKeyPart>],
    folder: &str,
    write_manifest: bool,
) -> Result<BlobFolderSaveResult> {
    if folder.trim().is_empty() {
        return Err(AppError::InvalidInput("destination folder is empty".into()));
    }
    if keys.is_empty() {
        return Err(AppError::InvalidInput("no rows to save".into()));
    }
    if keys.len() > MAX_FOLDER_EXPORT_ROWS {
        return Err(AppError::InvalidInput(format!(
            "too many rows ({}, limit {MAX_FOLDER_EXPORT_ROWS})",
            keys.len()
        )));
    }
    let dir = std::path::Path::new(folder);
    if !tokio::fs::metadata(dir)
        .await
        .map(|m| m.is_dir())
        .unwrap_or(false)
    {
        return Err(AppError::InvalidInput(format!(
            "destination is not an existing folder: {folder}"
        )));
    }
    let mut result = BlobFolderSaveResult::default();
    let mut used = std::collections::HashSet::new();
    let mut manifest: Vec<ManifestRow> = Vec::new();
    let report = |result: &mut BlobFolderSaveResult, row: usize, error: String| {
        result.failed += 1;
        if result.errors.len() < MAX_REPORTED_ERRORS {
            result.errors.push(BlobFolderIssue {
                row: row as u32,
                error,
            });
        }
    };
    for (i, key) in keys.iter().enumerate() {
        let mut entry = ManifestRow {
            key: key.iter().map(|p| manifest_key_text(&p.value)).collect(),
            file: None,
            bytes: None,
            mime: None,
            status: "failed",
            error: None,
        };
        // probe と本体を 1 往復で取る (#1609)。1 行あたり 2 往復だったものを 1 往復にする。
        let (probe, bytes) = match fetch_probe_and_body(session, database, table, column, key).await
        {
            Ok(Some((p, _))) if p.size > MAX_CELL_BLOB_BYTES as u64 => {
                result.skipped_too_large += 1;
                entry.status = "skipped_too_large";
                entry.bytes = Some(p.size);
                entry.mime = p.mime.clone();
                manifest.push(entry);
                continue;
            }
            Ok(Some((p, Some(b)))) => (p, b),
            Ok(Some((_, None))) | Ok(None) => {
                result.skipped_null += 1;
                entry.status = "skipped_null";
                manifest.push(entry);
                continue;
            }
            Err(e) => {
                entry.error = Some(e.to_string());
                manifest.push(entry);
                report(&mut result, i, e.to_string());
                continue;
            }
        };
        entry.mime = probe.mime.clone();
        let stem = blob_file_stem(key, i + 1);
        let ext = probe.ext.as_deref().unwrap_or("bin");
        let (mut file, path) = match create_unique_file(dir, &stem, ext, &mut used).await {
            Ok(v) => v,
            Err(e) => {
                entry.error = Some(e.to_string());
                manifest.push(entry);
                report(&mut result, i, e.to_string());
                continue;
            }
        };
        use tokio::io::AsyncWriteExt;
        let written = match file.write_all(&bytes).await {
            Ok(()) => file.flush().await,
            Err(e) => Err(e),
        };
        drop(file);
        match written {
            Ok(()) => {
                result.saved += 1;
                result.total_bytes += bytes.len() as u64;
                entry.status = "saved";
                entry.bytes = Some(bytes.len() as u64);
                entry.file = path.file_name().map(|n| n.to_string_lossy().into_owned());
                manifest.push(entry);
            }
            Err(e) => {
                // 書きかけのファイルは残さない。
                let _ = tokio::fs::remove_file(&path).await;
                entry.error = Some(e.to_string());
                manifest.push(entry);
                report(&mut result, i, e.to_string());
            }
        }
    }
    if write_manifest {
        // 対応表は BLOB と同じ規則で未使用の名前に書く (既存ファイルは上書きしない)。
        let key_columns: Vec<String> = keys
            .first()
            .map(|k| k.iter().map(|p| p.column.clone()).collect())
            .unwrap_or_default();
        let body = render_manifest(&key_columns, &manifest);
        let (mut file, path) = create_unique_file(dir, "manifest", "csv", &mut used).await?;
        use tokio::io::AsyncWriteExt;
        let written = match file.write_all(body.as_bytes()).await {
            Ok(()) => file.flush().await,
            Err(e) => Err(e),
        };
        drop(file);
        if let Err(e) = written {
            let _ = tokio::fs::remove_file(&path).await;
            return Err(e.into());
        }
        result.manifest_file = path.file_name().map(|n| n.to_string_lossy().into_owned());
    }
    Ok(result)
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
    fn probe_body_select_gates_the_body_on_size_per_driver() {
        let k = [key("id", Value::Int(7))];
        let max = MAX_CELL_BLOB_BYTES;
        let my = build_cell_probe_body_select(DriverKind::Mysql, Some("app"), "files", "data", &k)
            .unwrap();
        assert!(my.starts_with("SELECT OCTET_LENGTH(`data`), HEX(SUBSTRING(`data`, 1, 16)), "));
        assert!(my.contains(&format!(
            "CASE WHEN OCTET_LENGTH(`data`) <= {max} THEN `data` END"
        )));
        assert!(my.ends_with("FROM `app`.`files` WHERE `id` = 7 LIMIT 2"));
        let pg =
            build_cell_probe_body_select(DriverKind::Postgres, None, "files", "data", &k).unwrap();
        assert!(pg.contains(&format!(
            "CASE WHEN octet_length(\"data\") <= {max} THEN \"data\" END"
        )));
        let lite =
            build_cell_probe_body_select(DriverKind::Sqlite, None, "files", "data", &k).unwrap();
        assert!(lite.contains(&format!(
            "CASE WHEN LENGTH(CAST(\"data\" AS BLOB)) <= {max} THEN \"data\" END"
        )));
        // キー検査は probe / 本体取得と共通。
        assert!(build_cell_probe_body_select(DriverKind::Mysql, None, "t", "c", &[]).is_err());
    }

    #[test]
    fn probe_body_row_carries_the_body_cell() {
        let (probe, body) = interpret_probe_body_row(vec![
            Value::Int(3),
            Value::String("89504E47".into()),
            Value::Bytes("010203".into()),
        ])
        .unwrap()
        .unwrap();
        assert_eq!(probe.size, 3);
        assert_eq!(decode_body_cell(body).unwrap(), Some(vec![1, 2, 3]));
        // 上限超過の行はサーバ側の CASE で本体が NULL になる。
        let (_, body) = interpret_probe_body_row(vec![
            Value::Int(MAX_CELL_BLOB_BYTES as i64 + 1),
            Value::Null,
            Value::Null,
        ])
        .unwrap()
        .unwrap();
        assert_eq!(decode_body_cell(body).unwrap(), None);
        // NULL セル。
        assert!(
            interpret_probe_body_row(vec![Value::Null, Value::Null, Value::Null])
                .unwrap()
                .is_none()
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

    #[test]
    fn manifest_lists_every_row_with_escaped_cells() {
        let rows = vec![
            ManifestRow {
                key: vec!["1".into()],
                file: Some("1.png".into()),
                bytes: Some(10),
                mime: Some("image/png".into()),
                status: "saved",
                error: None,
            },
            ManifestRow {
                key: vec!["=SUM(A1)".into()],
                file: None,
                bytes: None,
                mime: None,
                status: "failed",
                error: Some("boom, \"bad\"".into()),
            },
            ManifestRow {
                key: vec!["3".into()],
                file: None,
                bytes: None,
                mime: None,
                status: "skipped_null",
                error: None,
            },
        ];
        let csv = render_manifest(&["id".to_string()], &rows);
        let lines: Vec<&str> = csv.split("\r\n").collect();
        assert_eq!(lines[0], "row,key_id,file,bytes,mime,status,error");
        assert_eq!(lines[1], "1,1,1.png,10,image/png,saved,");
        // 数式の先頭文字は無害化され、カンマ・引用符を含むセルはクオートされる。
        assert_eq!(lines[2], "2,'=SUM(A1),,,,failed,\"boom, \"\"bad\"\"\"");
        assert_eq!(lines[3], "3,3,,,,skipped_null,");
        assert_eq!(lines[4], "");
    }

    #[test]
    fn file_stem_comes_from_the_primary_key() {
        assert_eq!(blob_file_stem(&[key("id", Value::Int(7))], 1), "7");
        assert_eq!(
            blob_file_stem(
                &[
                    key("a", Value::Int(1)),
                    key("b", Value::String("x y".into()))
                ],
                1
            ),
            "1-x_y"
        );
        // パス区切り・先頭ドットは無害化される。
        assert_eq!(
            blob_file_stem(&[key("id", Value::String("../etc/passwd".into()))], 1),
            "_etc_passwd"
        );
        assert_eq!(
            blob_file_stem(&[key("id", Value::String("..".into()))], 3),
            "row3"
        );
        // Windows 予約名は避ける。
        assert_eq!(
            blob_file_stem(&[key("id", Value::String("con".into()))], 1),
            "_con"
        );
        assert_eq!(
            blob_file_stem(&[key("id", Value::String("LPT1".into()))], 1),
            "_LPT1"
        );
        // 長いキーは丸める。
        assert_eq!(
            blob_file_stem(&[key("id", Value::String("a".repeat(300)))], 1).len(),
            100
        );
        // 最初のドットより前が予約名なら避ける (`CON.txt` は Windows でデバイス扱い)。
        assert_eq!(
            blob_file_stem(&[key("id", Value::String("con.v2".into()))], 1),
            "_con.v2"
        );
        // 予約名を含むだけの名前は触らない。
        assert_eq!(
            blob_file_stem(&[key("id", Value::String("a.con".into()))], 1),
            "a.con"
        );
        // 長さはバイト数で数え、UTF-8 の文字境界で切る (3 バイト文字 40 個 = 120 バイト)。
        let jp = blob_file_stem(&[key("id", Value::String("あ".repeat(40)))], 1);
        assert!(
            jp.len() <= 100 && jp.chars().all(|c| c == 'あ'),
            "{}",
            jp.len()
        );
        assert_eq!(jp.len(), 99);
    }

    #[tokio::test]
    async fn create_unique_file_never_overwrites_and_avoids_case_collisions() {
        let dir = std::env::temp_dir().join(format!("noobdb_blob_unique_{}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&dir).await;
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::write(dir.join("a.bin"), b"existing")
            .await
            .unwrap();
        let mut used = std::collections::HashSet::new();
        let (_, p1) = create_unique_file(&dir, "a", "bin", &mut used)
            .await
            .unwrap();
        assert_eq!(p1.file_name().unwrap(), "a_2.bin");
        let (_, p2) = create_unique_file(&dir, "A", "bin", &mut used)
            .await
            .unwrap();
        assert_eq!(
            p2.file_name().unwrap(),
            "A_3.bin",
            "大文字小文字違いも別名にする"
        );
        assert_eq!(
            tokio::fs::read(dir.join("a.bin")).await.unwrap(),
            b"existing"
        );
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
}
