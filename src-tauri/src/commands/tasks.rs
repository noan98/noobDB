//! タスクスケジューラの IPC 層 (#730)。純粋な永続化 (`tasks::store`) /
//! 実行 (`tasks::executor` / `tasks::scheduler`) はどちらも `tasks` モジュールに
//! あり、ここは Tauri コマンドとしての薄いラッパー + 入力検証を担う。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use chrono::Utc;
use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::db::is_read_only_sql;
use crate::error::{AppError, Result};
use crate::profiles;
use crate::state::{AppState, StreamHandle, StreamKind};
use crate::tasks::{
    executor, runs, schedule, scheduler, store, AssertionRunRecord, SchedulerSettings, TaskAction,
    TaskDefinition, TaskRun, TaskSchedule,
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
        // アサーションは保存済みの定義を ID で参照するだけで、SQL は実行時に
        // `db::assertions::build_sql` が生成する (生成時に読み取り専用を検証済み)。
        // ここで検証するものは無い。
        TaskAction::RunAssertions { .. } => {}
    }
    Ok(())
}

#[tauri::command]
pub async fn list_tasks() -> Result<Vec<TaskDefinition>> {
    store::load_all()
}

/// `save_task` のロック下で行う純粋な更新部分。`requested_id` が指定されているのに
/// 該当タスクが無いのは、保存中に削除された編集なのでエラーにし、削除済みタスクを
/// 復活させない。既存タスクの `created_at` / `last_run_at` / `last_status` は引き継ぐ。
fn apply_save(
    tasks: &mut Vec<TaskDefinition>,
    requested_id: Option<&str>,
    id: &str,
    req: &SaveTaskRequest,
    next_run_at: Option<String>,
    now: chrono::DateTime<Utc>,
) -> Result<TaskDefinition> {
    let existing = tasks.iter().find(|t| t.id == id).cloned();
    if requested_id.is_some() && existing.is_none() {
        return Err(AppError::InvalidInput(format!("task not found: {id}")));
    }
    let created_at = existing
        .as_ref()
        .map(|t| t.created_at.clone())
        .unwrap_or_else(|| now.to_rfc3339());
    let task = TaskDefinition {
        id: id.to_string(),
        name: req.name.clone(),
        profile_id: req.profile_id.clone(),
        action: req.action.clone(),
        schedule: req.schedule,
        enabled: req.enabled,
        created_at,
        updated_at: now.to_rfc3339(),
        next_run_at,
        last_run_at: existing.as_ref().and_then(|t| t.last_run_at.clone()),
        last_status: existing.as_ref().and_then(|t| t.last_status.clone()),
    };
    match tasks.iter_mut().find(|t| t.id == id) {
        Some(slot) => *slot = task.clone(),
        None => tasks.push(task.clone()),
    }
    Ok(task)
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

    let requested_id = req.id.clone().filter(|s| !s.is_empty());
    let id = requested_id.clone().unwrap_or_else(store::new_task_id);
    let now = Utc::now();

    // 保存のたびに「今から」の次回発火時刻を計算し直す (有効なタスクのみ)。
    // スケジュール変更・再有効化・単純な名前変更のいずれでも一貫した挙動になる。
    let next_run_at = if req.enabled {
        Some(schedule::next_run_after(&req.schedule, now).to_rfc3339())
    } else {
        None
    };

    // 既存タスクの読み出しから書き戻しまでをストアのロック下で一息に行う。
    // 別ロックで読むと、間に割り込んだ `delete_task` の削除を `upsert` が復活させたり、
    // スケジューラが書いた `last_run_at` / `last_status` を古い値で上書きしたりする。
    let mut saved: Option<TaskDefinition> = None;
    store::update_all(|tasks| {
        saved = Some(apply_save(
            tasks,
            requested_id.as_deref(),
            &id,
            &req,
            next_run_at.clone(),
            now,
        )?);
        Ok(())
    })?;
    let task = saved.ok_or_else(|| AppError::Other("task save did not produce a result".into()))?;
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
///
/// `stream_id` で `cancel_stream` から中断できる (#1534)。数時間かかるダンプを手動実行しても
/// UI が応答のない invoke を待ち続けないよう、実行中は `task-run:progress` (`stream_id` で絞る)
/// で進捗の件数を知らせる。中断した実行は「中断された」エラーとして実行ログに残り、
/// 通常どおりその `TaskRun` を返す。
#[tauri::command]
pub async fn run_task_now(
    app: AppHandle,
    id: String,
    stream_id: String,
    state: State<'_, AppState>,
) -> Result<TaskRun> {
    let task = store::load_all()?
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| AppError::InvalidInput(format!("task not found: {id}")))?;
    validate_action(&task.action)?;

    let Some(_run_guard) = scheduler::try_acquire_run(&task.id) else {
        return Err(AppError::InvalidInput(format!(
            "task is already running: {}",
            task.id
        )));
    };

    let started = Utc::now();
    let progress = Arc::new(AtomicU64::new(0));
    let task_for_run = task.clone();
    let app_for_run = app.clone();
    let progress_for_run = progress.clone();
    let handle = tokio::spawn(async move {
        executor::run_once(&app_for_run, &task_for_run, &progress_for_run).await
    });
    let token = state
        .register_stream(
            stream_id.clone(),
            StreamHandle {
                abort: handle.abort_handle(),
                delivered_rows: progress.clone(),
                kind: StreamKind::Task,
                on_cancel: None,
            },
        )
        .await;
    let ticker =
        scheduler::spawn_progress_ticker(app.clone(), stream_id.clone(), &task, progress.clone());

    let joined = handle.await;
    ticker.abort();
    state.forget_stream(&stream_id, token).await;

    let outcome = match joined {
        Ok(outcome) => outcome,
        // `cancel_stream` による中断 (実行の future は破棄済みで、接続は Drop ガードが閉じる)。
        Err(e) if e.is_cancelled() => executor::TaskOutcome::err(format!(
            "cancelled by user (progress: {} {})",
            progress.load(Ordering::SeqCst),
            scheduler::progress_unit(&task.action)
        )),
        Err(e) => executor::TaskOutcome::err(format!("task execution aborted: {e}")),
    };
    let event = scheduler::record_outcome(&app, task.clone(), false, started, outcome).await;
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

/// アサーション実行タスクの合否履歴 (#1170)。新しい順。トレンド表示用。
#[tauri::command]
pub async fn list_assertion_runs(
    task_id: Option<String>,
    assertion_id: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<AssertionRunRecord>> {
    runs::list_assertion_runs(
        task_id.as_deref(),
        assertion_id.as_deref(),
        limit.unwrap_or(200),
    )
    .await
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

#[cfg(test)]
mod apply_save_tests {
    use super::*;
    use crate::tasks::TaskSchedule;

    fn req(id: Option<&str>) -> SaveTaskRequest {
        SaveTaskRequest {
            id: id.map(str::to_string),
            name: "t".into(),
            profile_id: "p".into(),
            action: TaskAction::RunAssertions {
                database: None,
                assertion_ids: vec![],
            },
            schedule: TaskSchedule::Interval { minutes: 5 },
            enabled: true,
        }
    }

    #[test]
    fn editing_a_deleted_task_errors_instead_of_resurrecting_it() {
        let mut tasks = Vec::new();
        let err = apply_save(
            &mut tasks,
            Some("gone"),
            "gone",
            &req(Some("gone")),
            None,
            Utc::now(),
        )
        .unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
        assert!(tasks.is_empty());
    }

    #[test]
    fn new_task_is_added_and_edit_keeps_last_run() {
        let mut tasks = Vec::new();
        let now = Utc::now();
        apply_save(&mut tasks, None, "new1", &req(None), None, now).unwrap();
        assert_eq!(tasks.len(), 1);
        tasks[0].last_status = Some("ok".into());
        let edited = apply_save(
            &mut tasks,
            Some("new1"),
            "new1",
            &req(Some("new1")),
            None,
            now,
        )
        .unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(edited.last_status.as_deref(), Some("ok"));
    }
}
