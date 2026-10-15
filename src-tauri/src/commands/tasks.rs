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
    executor, runs, schedule, scheduler, store, AssertionRunRecord, ConnectRetry,
    SchedulerSettings, TaskAction, TaskDefinition, TaskRun, TaskSchedule, MAX_PAUSE_AFTER_FAILURES,
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
    /// 接続失敗時の自動リトライ (#1537)。省略時は再試行なし。保存時に範囲へ丸める。
    #[serde(default)]
    pub connect_retry: ConnectRetry,
    /// 連続失敗で自動停止するまでの回数 (#1621)。0 / 省略なら停止しない。
    #[serde(default)]
    pub pause_after_failures: u32,
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
        // タイムラプス / 実行計画ウォッチは保存済みのウォッチ登録を読むだけ (#1537)。
        // 実行する SQL は取得側が組み立てる読み取り専用の SELECT / EXPLAIN で、
        // タスク定義にユーザの SQL は載らない。
        TaskAction::TimelapseCapture { .. } | TaskAction::RefreshPlanWatch { .. } => {}
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
        schedule: req.schedule.clone(),
        enabled: req.enabled,
        created_at,
        updated_at: now.to_rfc3339(),
        next_run_at,
        last_run_at: existing.as_ref().and_then(|t| t.last_run_at.clone()),
        last_status: existing.as_ref().and_then(|t| t.last_status.clone()),
        connect_retry: req.connect_retry.normalized(),
        pause_after_failures: req.pause_after_failures.min(MAX_PAUSE_AFTER_FAILURES),
        // 有効のまま保存したときは連続失敗の数え直しを引き継ぎ、無効 → 有効にしたとき
        // (手動の再開) だけ 0 に戻す。自動停止の印も再有効化で消す。
        consecutive_failures: match &existing {
            Some(t) if req.enabled && t.enabled => t.consecutive_failures,
            _ => 0,
        },
        auto_paused_at: match &existing {
            Some(t) if !req.enabled => t.auto_paused_at.clone(),
            _ => None,
        },
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
    schedule::validate_schedule(&req.schedule).map_err(AppError::InvalidInput)?;

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

/// プレビューで返す回数の上限。
const MAX_SCHEDULE_PREVIEW: usize = 10;

/// スケジュールの次回以降の発火時刻 (RFC3339, UTC) を `count` 件返す (#1621)。保存前の
/// 編集中の値で呼べ、DST・曜日マスクを含む実際の計算 (`schedule::next_run_after`) と
/// 同じ経路なので、時刻やタイムゾーンの設定ミスを保存前に確認できる。副作用なし。
#[tauri::command]
pub fn preview_task_schedule(schedule: TaskSchedule, count: usize) -> Result<Vec<String>> {
    schedule::validate_schedule(&schedule).map_err(AppError::InvalidInput)?;
    let count = count.clamp(1, MAX_SCHEDULE_PREVIEW);
    Ok(schedule::upcoming_runs(&schedule, Utc::now(), count)
        .into_iter()
        .map(|t| t.to_rfc3339())
        .collect())
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
        if enabled {
            // 手動の再開 (連続失敗による自動停止からの復帰を含む)。数え直す (#1621)。
            task.consecutive_failures = 0;
            task.auto_paused_at = None;
        }
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
    // ticker を止める前の最後の変化は届いていないことがあるので、最終値を 1 回送る。
    scheduler::emit_progress(
        &app,
        &stream_id,
        &task.id,
        progress.load(Ordering::SeqCst),
        scheduler::progress_unit(&task.action),
    );
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
    let (event, run_id) =
        scheduler::record_outcome(&app, task.clone(), false, started, outcome).await;
    // 記録した行そのものを返す。「最新の 1 件」だと、手動実行中に見送られた予定発火の
    // skipped 行 (started_at が新しい) を取り違える。
    if let Some(id) = run_id {
        if let Some(run) = runs::get(id).await? {
            return Ok(run);
        }
    }
    Err(AppError::Other(format!(
        "run recorded but not found afterwards (status: {})",
        event.status
    )))
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
                notify_only_on_increase: false,
            },
            schedule: TaskSchedule::Interval { minutes: 5 },
            enabled: true,
            connect_retry: ConnectRetry::default(),
            pause_after_failures: 0,
        }
    }

    #[test]
    fn save_clamps_connect_retry_into_range() {
        let mut r = req(None);
        r.connect_retry = ConnectRetry {
            max_retries: 99,
            interval_secs: 1,
        };
        let mut tasks = Vec::new();
        let saved = apply_save(&mut tasks, None, "new1", &r, None, Utc::now()).unwrap();
        assert_eq!(
            saved.connect_retry.max_retries,
            crate::tasks::MAX_CONNECT_RETRIES
        );
        assert_eq!(
            saved.connect_retry.interval_secs,
            crate::tasks::MIN_RETRY_INTERVAL_SECS
        );
    }

    /// #1621: 連続失敗の数え直しは保存で保たれ、再有効化 (無効 → 有効) でだけ 0 に戻る。
    #[test]
    fn save_keeps_failure_streak_until_the_task_is_re_enabled() {
        let mut tasks = Vec::new();
        let now = Utc::now();
        let mut r = req(None);
        r.pause_after_failures = 500; // 上限へ丸められる
        let saved = apply_save(&mut tasks, None, "t1", &r, None, now).unwrap();
        assert_eq!(saved.pause_after_failures, MAX_PAUSE_AFTER_FAILURES);
        // 失敗が溜まった状態。
        tasks[0].consecutive_failures = 4;
        let same = apply_save(&mut tasks, Some("t1"), "t1", &req(Some("t1")), None, now).unwrap();
        assert_eq!(
            same.consecutive_failures, 4,
            "有効のまま保存しても数え直さない"
        );
        // 自動停止後 (無効) に、無効のまま保存すると印は残る。
        tasks[0].enabled = false;
        tasks[0].auto_paused_at = Some("t".into());
        let mut off = req(Some("t1"));
        off.enabled = false;
        let kept = apply_save(&mut tasks, Some("t1"), "t1", &off, None, now).unwrap();
        assert_eq!(kept.auto_paused_at.as_deref(), Some("t"));
        assert_eq!(kept.consecutive_failures, 0);
        // 有効に戻すと印も数え直しも消える。
        tasks[0].consecutive_failures = 5;
        let back = apply_save(&mut tasks, Some("t1"), "t1", &req(Some("t1")), None, now).unwrap();
        assert_eq!(back.consecutive_failures, 0);
        assert_eq!(back.auto_paused_at, None);
    }

    #[test]
    fn preview_returns_validated_future_runs_in_order() {
        let sched = TaskSchedule::Daily {
            hour: 9,
            minute: 0,
            timezone: Some("Asia/Tokyo".into()),
            weekdays: 0b001_1111,
        };
        let runs = preview_task_schedule(sched.clone(), 5).unwrap();
        assert_eq!(runs.len(), 5);
        let parsed: Vec<_> = runs
            .iter()
            .map(|s| chrono::DateTime::parse_from_rfc3339(s).unwrap())
            .collect();
        assert!(parsed.windows(2).all(|w| w[0] < w[1]));
        // どれも JST の平日 9:00。
        for p in &parsed {
            let jst = p.with_timezone(&chrono_tz::Asia::Tokyo);
            assert_eq!(chrono::Timelike::hour(&jst), 9);
            assert!(chrono::Datelike::weekday(&jst).number_from_monday() <= 5);
        }
        // 件数は 1..=10 に丸め、不正なタイムゾーンは拒否する。
        assert_eq!(preview_task_schedule(sched.clone(), 0).unwrap().len(), 1);
        assert_eq!(preview_task_schedule(sched, 999).unwrap().len(), 10);
        let bad = TaskSchedule::Daily {
            hour: 9,
            minute: 0,
            timezone: Some("Nowhere/City".into()),
            weekdays: 0,
        };
        assert!(preview_task_schedule(bad, 5).is_err());
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
