//! 論理リレーション (仮想 FK, #2356) の IPC ラッパー。保存先はアプリ側の非秘密 JSON ストア
//! (`logical_relations.rs`) だけで、DB には何も書かない (DDL もスキーマ同期もダンプも通らない)。
//! そのため `read_only` セッションでも登録・削除できる。フロントは `list_logical_relations` の
//! 結果を宣言済み FK とマージして、FK ジャンプ・関連行・ER 図・JOIN 補完へ渡す。

use tauri::State;

use crate::commands::assertions::blocking_store;
use crate::error::{AppError, Result};
use crate::logical_relations::{
    self, LogicalRelation, LogicalRelationInput, LogicalRelationsImportParse,
};
use crate::state::AppState;

async fn profile_id_of(state: &State<'_, AppState>, session_id: &str) -> Result<Option<String>> {
    let session = state
        .get(session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
    Ok(session.profile_id.clone())
}

/// この接続先 (プロファイル × データベース) の論理リレーション一覧。
#[tauri::command]
pub async fn list_logical_relations(
    session_id: String,
    database: String,
    state: State<'_, AppState>,
) -> Result<Vec<LogicalRelation>> {
    let profile_id = profile_id_of(&state, &session_id).await?;
    blocking_store(move || logical_relations::list(profile_id.as_deref(), &database)).await
}

/// 論理リレーションをまとめて登録する (既存と同じものは無視)。登録後の一覧を返す。
#[tauri::command]
pub async fn save_logical_relations(
    session_id: String,
    database: String,
    relations: Vec<LogicalRelationInput>,
    state: State<'_, AppState>,
) -> Result<Vec<LogicalRelation>> {
    let profile_id = profile_id_of(&state, &session_id).await?;
    // プロファイルを持たない接続 (サンドボックス・ローカル横断) は保存先の単位が無く、
    // 無関係な接続と共有されてしまうので登録させない。
    if profile_id.is_none() {
        return Err(AppError::InvalidInput(
            "logical relations require a saved connection profile".to_string(),
        ));
    }
    blocking_store(move || logical_relations::add_all(profile_id.as_deref(), &database, &relations))
        .await
}

/// 論理リレーションを 1 件削除する。削除後の一覧を返す。
#[tauri::command]
pub async fn delete_logical_relation(
    session_id: String,
    database: String,
    relation: LogicalRelationInput,
    state: State<'_, AppState>,
) -> Result<Vec<LogicalRelation>> {
    let profile_id = profile_id_of(&state, &session_id).await?;
    blocking_store(move || logical_relations::remove(profile_id.as_deref(), &database, &relation))
        .await
}

/// この接続先の論理リレーションを書き出し用の JSON 文字列にする (#2423)。`profile_id`・接続情報・
/// 登録時刻は含めない。呼び出し側が保存ダイアログで選んだパスへ `write_text_file` で書く。
#[tauri::command]
pub async fn export_logical_relations(
    session_id: String,
    database: String,
    state: State<'_, AppState>,
) -> Result<String> {
    let profile_id = profile_id_of(&state, &session_id).await?;
    blocking_store(move || {
        let list = logical_relations::list(profile_id.as_deref(), &database)?;
        logical_relations::export_json(&list)
    })
    .await
}

/// 書き出しファイルの中身を寛容に読む (#2423)。保存はしない (プレビュー用)。壊れた JSON・
/// サイズ / 件数の超過はエラー、解釈できない要素は読み飛ばして `rejected` に返す。
#[tauri::command]
pub async fn parse_logical_relations_import(json: String) -> Result<LogicalRelationsImportParse> {
    logical_relations::parse_import(&json)
}

/// この接続先の論理リレーションを渡した内容で置き換える (取り込みの「上書き」、#2423)。
/// 追加だけで済む取り込みは `save_logical_relations` を使う。置き換え後の一覧を返す。
#[tauri::command]
pub async fn replace_logical_relations(
    session_id: String,
    database: String,
    relations: Vec<LogicalRelationInput>,
    state: State<'_, AppState>,
) -> Result<Vec<LogicalRelation>> {
    let profile_id = profile_id_of(&state, &session_id).await?;
    if profile_id.is_none() {
        return Err(AppError::InvalidInput(
            "logical relations require a saved connection profile".to_string(),
        ));
    }
    blocking_store(move || {
        logical_relations::replace_all(profile_id.as_deref(), &database, &relations)
    })
    .await
}
