//! タスクスケジューラの IPC 層 (#730)。純粋な永続化 (`tasks::store`) /
//! 実行 (`tasks::executor` / `tasks::scheduler`) はどちらも `tasks` モジュールに
//! あり、ここは Tauri コマンドとしての薄いラッパー + 入力検証を担う。

use chrono::Utc;
use serde::Deserialize;
use tauri::AppHandle;

use crate::db::is_read_only_sql;
use crate::error::{AppError, Result};
use crate::profiles;
use crate::tasks::{
    runs, schedule, scheduler, store, SchedulerSettings, TaskAction, TaskDefinition, TaskRun,
    TaskSchedule,
};

#[derive(Debug, Deserialize)]
pub struct SaveTaskRequest {
    /// 空/None なら新規作成。
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub profile_id: String,
    pub action: TaskAction,
    pub schedule: TaskSchedule,
    #[serde(default = "default_task_enabled")]
    pub enabled: bool,
}

fn default_task_enabled() -> bool {
    true
}

/// アクションを検証する。`ExportQuery` の SQL は読み取り専用のみ (#730 の受け入れ
/// 条件: 作成時・実行時の両方で拒否)。空の出力パス / データベース名も弾く。
fn validate_action(action: &TaskAction) -> Result<()> {
    match action {
        TaskAction::ExportQuery {
            sql, output_path, ..
        } => {
            if sql.trim().is_empty() {
                return Err(AppError::InvalidInput("task SQL is empty".into()));
            }
            // ドライバは保存時点では未確定 (profile_id からの解決は接続時に行う)
            // ため、ドライバ非依存の `is_read_only_sql` — `\` を文字列エスケープと
            // 見なさない保守的なマスク — を使う (#852)。MySQL のリテラル内 `\'`
            // を含む文が弾かれる可能性はあるが、fail-closed 側の誤りであり、
            // 実行時 (`tasks::executor::run_once`) にも同じ判定が走る。
            if !is_read_only_sql(sql) {
                return Err(AppError::ReadOnly(
                    "scheduled tasks only support read-only statements (SELECT / SHOW / DESCRIBE / EXPLAIN / WITH)"
                        .into(),
                ));
            }
            if output_path.trim().is_empty() {
                return Err(AppError::InvalidInput("output path is empty".into()));
            }
        }
        TaskAction::Dump {
            database,
            output_path,
            ..
        } => {
            if database.trim().is_empty() {
                return Err(AppError::InvalidInput("database name is empty".into()));
            }
            if output_path.trim().is_empty() {
                return Err(AppError::InvalidInput("output path is empty".into()));
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn list_tasks() -> Result<Vec<TaskDefinition>> {
    store::load_all()
}

#[tauri::command]
pub async fn save_task(req: SaveTaskRequest) -> Result<TaskDefinition> {
    if req.name.trim().is_empty() {
        return Err(AppError::InvalidInput("task name is empty".into()));
    }
    validate_action(&req.action)?;

    // プロファイルが実在することを確認する (孤立タスクの作成を防ぐ)。
    let profiles = profiles::store::load_all()?;
    if !profiles.iter().any(|p| p.id == req.profile_id) {
        return Err(AppError::InvalidInput(format!(
            "unknown profile: {}",
            req.profile_id
        )));
    }

    let id = req
        .id
        .filter(|s| !s.is_empty())
        .unwrap_or_else(store::new_task_id);
    let now = Utc::now();
    let existing = store::load_all()?.into_iter().find(|t| t.id == id);
    let created_at = existing
        .as_ref()
        .map(|t| t.created_at.clone())
        .unwrap_or_else(|| now.to_rfc3339());

    // 保存のたびに「今から」の次回発火時刻を計算し直す (有効なタスクのみ)。
    // スケジュール変更・再有効化・単純な名前変更のいずれでも一貫した挙動になる。
    let next_run_at = if req.enabled {
        Some(schedule::next_run_after(&req.schedule, now).to_rfc3339())
    } else {
        None
    };

    let task = TaskDefinition {
        id,
        name: req.name,
        profile_id: req.profile_id,
        action: req.action,
        schedule: req.schedule,
        enabled: req.enabled,
        created_at,
        updated_at: now.to_rfc3339(),
        next_run_at,
        last_run_at: existing.as_ref().and_then(|t| t.last_run_at.clone()),
        last_status: existing.as_ref().and_then(|t| t.last_status.clone()),
    };
    store::upsert(task.clone())?;
    Ok(task)
}

#[tauri::command]
pub async fn delete_task(id: String) -> Result<()> {
    store::delete(&id)?;
    // ベストエフォート: 実行ログの掃除に失敗してもタスク削除自体は成功扱いにする。
    if let Err(e) = runs::clear(Some(&id)).await {
        tracing::warn!(task_id = %id, error = %e, "failed to clear run log for deleted task");
    }
    Ok(())
}

#[tauri::command]
pub async fn set_task_enabled(id: String, enabled: bool) -> Result<TaskDefinition> {
    // 読み → 変更 → 書きをストアのロック下で一息に行う (途中で `save_task` /
    // `delete_task` が割り込むと、その変更をこの保存が消してしまうため)。
    let mut updated: Option<TaskDefinition> = None;
    store::update_all(|tasks| {
        let task = tasks
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or_else(|| AppError::InvalidInput(format!("task not found: {id}")))?;
        task.enabled = enabled;
        task.next_run_at = if enabled {
            Some(schedule::next_run_after(&task.schedule, Utc::now()).to_rfc3339())
        } else {
            None
        };
        updated = Some(task.clone());
        Ok(())
    })?;
    // `update_all` は `f` を必ず呼び、その中でタスクが見つからなければ上の `?` で
    // 抜けるので、ここに来た時点で必ず `Some`。panic せず通常のエラーにするのは
    // リポジトリ方針 (本体コードで unwrap/panic 禁止)。
    updated.ok_or_else(|| AppError::Other("task update did not produce a result".into()))
}

/// タスクを即座に 1 回実行する。有効/無効に関係なく実行できる (手動確認・
/// トラブルシュート用)。スケジュール自体 (`next_run_at`) には影響しない。
#[tauri::command]
pub async fn run_task_now(app: AppHandle, id: String) -> Result<TaskRun> {
    let task = store::load_all()?
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| AppError::InvalidInput(format!("task not found: {id}")))?;
    validate_action(&task.action)?;

    let event = scheduler::execute_and_log(&app, task.clone(), false).await;
    // 直近の 1 件が今実行したものであるはずなので、それを返す (レースで別の実行が
    // 割り込んだ場合でもタスク単位で最新のログを返すだけなので実害はない)。
    let latest = runs::list(Some(&task.id), 1).await?;
    latest.into_iter().next().ok_or_else(|| {
        AppError::Other(format!(
            "run recorded but not found afterwards (status: {})",
            event.status
        ))
    })
}

#[tauri::command]
pub async fn list_task_runs(task_id: Option<String>, limit: Option<i64>) -> Result<Vec<TaskRun>> {
    runs::list(task_id.as_deref(), limit.unwrap_or(200)).await
}

#[tauri::command]
pub async fn clear_task_runs(task_id: Option<String>) -> Result<u64> {
    runs::clear(task_id.as_deref()).await
}

#[tauri::command]
pub async fn get_scheduler_settings() -> Result<SchedulerSettings> {
    store::load_settings()
}

#[tauri::command]
pub async fn set_scheduler_settings(settings: SchedulerSettings) -> Result<SchedulerSettings> {
    store::save_settings(settings)?;
    Ok(settings)
}
