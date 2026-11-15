//! 論理リレーション (仮想 FK, #2356) の IPC ラッパー。保存先はアプリ側の非秘密 JSON ストア
//! (`logical_relations.rs`) だけで、DB には何も書かない (DDL もスキーマ同期もダンプも通らない)。
//! そのため `read_only` セッションでも登録・削除できる。フロントは `list_logical_relations` の
//! 結果を宣言済み FK とマージして、FK ジャンプ・関連行・ER 図・JOIN 補完へ渡す。

use tauri::State;

use crate::commands::assertions::blocking_store;
use crate::error::{AppError, Result};
use crate::logical_relations::{self, LogicalRelation, LogicalRelationInput};
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
