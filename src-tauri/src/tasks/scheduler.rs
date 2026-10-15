//! バックグラウンドスケジューラ本体 (#730)。`lib.rs::run()` の `setup` フックから
//! 一度だけ spawn される Tokio タスクとして常駐し、一定間隔で `tasks.json` を
//! 読み直して期限が来たタスクを `executor::run_once` に渡す。**アプリが起動して
//! いる間だけ**動作する — OS のタスクスケジューラの代替ではない (HelpView に
//! 明記)。
//!
//! 状態はディスク (`tasks.json` / `task_runs.sqlite`) のみで、`AppState` には
//! 何も足さない。IPC 経由でタスクが編集されても、次の tick が `tasks.json` を
//! 読み直すだけで自然に追従する (明示的な再読み込みシグナルは不要)。

use chrono::{DateTime, Utc};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::{executor, runs, schedule, store, NewTaskRun, TaskDefinition};
use crate::error::Result;

/// tick 間隔。分単位のスケジュール精度に対して十分細かく、`tasks.json` を
/// 読み直すだけの軽い処理なので負荷も無視できる。
const TICK_SECS: u64 = 20;

const EV_TASK_RUN_DONE: &str = "task-run:done";
const EV_TASK_RUN_ERROR: &str = "task-run:error";
/// 「今すぐ実行」の進捗 (#1534)。`stream_id` で絞って購読する。
const EV_TASK_RUN_PROGRESS: &str = "task-run:progress";

// `pub` は #825 の zod ⇔ serde ゴールデンパターンに倣った将来のフィクスチャ化に
// 備えたもの。IPC 経路としては引き続きこのモジュール内で完結する。
#[derive(Debug, Clone, Serialize)]
pub struct TaskRunEvent {
    #[serde(rename = "taskId")]
    pub task_id: String,
    #[serde(rename = "taskName")]
    pub task_name: String,
    /// `"ok"` or `"error"`.
    pub status: String,
    pub message: Option<String>,
    #[serde(rename = "outputPath")]
    pub output_path: Option<String>,
    #[serde(rename = "catchUp")]
    pub catch_up: bool,
    /// この失敗で連続失敗の上限に達し、タスクを自動で一時停止した (#1621)。
    #[serde(rename = "autoPaused")]
    pub auto_paused: bool,
}

/// 「今すぐ実行」の進捗 (#1534)。`unit` は `count` の単位 (`rows` / `bytes` / `items`)。
#[derive(Debug, Clone, Serialize)]
pub struct TaskRunProgressEvent {
    #[serde(rename = "streamId")]
    pub stream_id: String,
    #[serde(rename = "taskId")]
    pub task_id: String,
    pub count: u64,
    pub unit: &'static str,
}

/// タスクの進捗の単位。
pub(crate) fn progress_unit(action: &super::TaskAction) -> &'static str {
    match action {
        super::TaskAction::ExportQuery { .. } => "rows",
        super::TaskAction::Dump { .. } => "bytes",
        super::TaskAction::RunAssertions { .. } => "items",
        // ウォッチ中のテーブル / スニペットの件数。
        super::TaskAction::TimelapseCapture { .. } | super::TaskAction::RefreshPlanWatch { .. } => {
            "items"
        }
    }
}

/// `task-run:progress` を 1 回送る。ticker の定期送信と、実行完了直後の最終値の送信
/// (ticker の周期より短い実行でも最終件数が届くように、#1614) で共有する。
pub(crate) fn emit_progress(
    app: &AppHandle,
    stream_id: &str,
    task_id: &str,
    count: u64,
    unit: &'static str,
) {
    let _ = app.emit(
        EV_TASK_RUN_PROGRESS,
        TaskRunProgressEvent {
            stream_id: stream_id.to_string(),
            task_id: task_id.to_string(),
            count,
            unit,
        },
    );
}

/// 進捗の件数を一定間隔で `task-run:progress` として知らせるタスクを起動する。
/// 返した `JoinHandle` を abort すれば止まる。
pub(crate) fn spawn_progress_ticker(
    app: AppHandle,
    stream_id: String,
    task: &TaskDefinition,
    progress: std::sync::Arc<std::sync::atomic::AtomicU64>,
) -> tokio::task::JoinHandle<()> {
    let task_id = task.id.clone();
    let unit = progress_unit(&task.action);
    tokio::spawn(async move {
        let mut last: Option<u64> = None;
        loop {
            let count = progress.load(std::sync::atomic::Ordering::SeqCst);
            // 変化したときだけ送る (開始直後の 0 は 1 回送り、進行中表示の起点にする)。
            if last != Some(count) {
                last = Some(count);
                emit_progress(&app, &stream_id, &task_id, count, unit);
            }
            tokio::time::sleep(std::time::Duration::from_millis(700)).await;
        }
    })
}

/// スケジューラを起動する。`app` の生存期間 (= アプリのプロセス) と同じだけ
/// バックグラウンドで動き続ける。
pub fn spawn(app: AppHandle) {
    spawn_detached(async move {
        let mut is_startup = true;
        loop {
            if let Err(e) = tick(&app, is_startup).await {
                tracing::error!(error = %e, "task scheduler: tick failed");
            }
            is_startup = false;
            tokio::time::sleep(std::time::Duration::from_secs(TICK_SECS)).await;
        }
    });
}

/// 常駐ループを Tauri のグローバル非同期ランタイムへ投げっぱなしで起動する。
///
/// **`tokio::spawn` を使ってはいけない。** [`spawn`] は `lib.rs::run()` の
/// `setup` フックから呼ばれるが、Tauri は `setup` を**イベントループの
/// `Ready` ハンドラ (= メインスレッド)** から呼び出しており、そこには Tokio
/// ランタイムのコンテキストが入っていない (`tauri::app::setup` は
/// `async_runtime::block_on` を経由しない)。`tokio::spawn` はスレッドローカルの
/// ランタイムハンドルを要求するため、この位置では
/// "there is no reactor running" で panic する。`setup` はウィンドウ生成の**後**に
/// 呼ばれるので、症状は「真っ白なウィンドウが一瞬出てからプロセスが即終了」
/// (v0.9.0 のインストール後クラッシュの原因)。リリースビルドは
/// `windows_subsystem = "windows"` でコンソールを持たないため panic メッセージも
/// 表示されない。
///
/// `tauri::async_runtime::spawn` は Tauri が持つグローバルランタイムのハンドルへ
/// 直接投げるためランタイム外から呼んでも安全で、投入後のタスク内では
/// (ランタイムコンテキストが入るので) `tokio::spawn` / `tokio::time::sleep` を
/// そのまま使える。
fn spawn_detached<F>(fut: F)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    tauri::async_runtime::spawn(fut);
}

/// 同一タスクの実行中に来た予定発火を見送ったことを示す実行履歴の status。
const RUN_STATUS_SKIPPED: &str = "skipped";
const SKIPPED_REASON: &str = "skipped: previous run still in progress";

/// 1 回分の tick: 期限が来た有効なタスクをすべて実行に回す。`is_startup` は
/// アプリ起動直後の最初の tick かどうかで、そのときだけ
/// `schedule::resolve_startup_next_run` (未起動中に過ぎたスケジュールの追い掛け
/// 判定) を通す。以降の通常 tick は保存済みの `next_run_at` をそのまま比較する
/// (`save_task` / `set_task_enabled` が有効化のたびに正しい値を書いている前提)。
async fn tick(app: &AppHandle, is_startup: bool) -> Result<()> {
    let (settings, tasks) = store::load_settings_and_tasks()?;
    let now = Utc::now();

    for task in tasks {
        if !task.enabled {
            continue;
        }
        let persisted = task
            .next_run_at
            .as_deref()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.with_timezone(&Utc));

        let (effective_next, catch_up) = if is_startup {
            let resolved = schedule::resolve_startup_next_run(
                &task.schedule,
                persisted,
                now,
                settings.catch_up_missed,
            );
            let was_missed = persisted.is_some_and(|p| p <= now);
            (resolved, was_missed && resolved <= now)
        } else {
            (
                persisted.unwrap_or_else(|| schedule::next_run_after(&task.schedule, now)),
                false,
            )
        };

        if schedule::is_due(Some(effective_next), now) {
            // 実行より先に次回発火時刻を書き直す — 実行に tick 間隔以上かかっても
            // 同じ発火を二重に拾わないようにするため (dump は数分かかることもある)。
            let new_next = schedule::next_run_after(&task.schedule, now);
            if let Err(e) = persist_next_run(&task.id, new_next) {
                tracing::error!(task_id = %task.id, error = %e, "task scheduler: failed to persist next_run_at; skipping this tick to avoid a double fire");
                continue;
            }
            // 前回の実行がまだ終わっていないなら今回の発火は見送る (同一タスクの
            // 並行実行は同じ出力ファイルを壊し、接続を溜める)。
            let Some(guard) = try_acquire_run(&task.id) else {
                tracing::warn!(task_id = %task.id, name = %task.name, "task scheduler: previous run still in progress; skipping this firing");
                // 見送った発火も実行履歴に残す (ユーザがスケジュールの動作を判別できるように)。
                // `last_status` のミラーと task-run イベントは、実行していないので触らない。
                let at = now.to_rfc3339();
                let skipped = NewTaskRun {
                    task_id: task.id.clone(),
                    started_at: at.clone(),
                    finished_at: at,
                    status: RUN_STATUS_SKIPPED.to_string(),
                    error: Some(SKIPPED_REASON.to_string()),
                    output_path: None,
                    rows: None,
                    bytes: None,
                    elapsed_ms: 0,
                    catch_up,
                    attempts: 1,
                };
                if let Err(e) = runs::record_skipped(skipped).await {
                    tracing::error!(task_id = %task.id, error = %e, "task scheduler: failed to record skipped run");
                }
                continue;
            };
            let app2 = app.clone();
            tokio::spawn(async move {
                let _guard = guard;
                let _ = execute_and_log(&app2, task, catch_up).await;
            });
        } else if Some(effective_next) != persisted {
            // 新規タスク / 起動時リスケジュールなど、値が変わったときだけ書く。
            let _ = persist_next_run(&task.id, effective_next);
        }
    }
    Ok(())
}

/// 実行中のタスク ID。スケジュール実行と手動実行 (`run_task_now`) で共有し、
/// 同一タスクの重複実行を防ぐ。
static RUNNING: std::sync::Mutex<Option<std::collections::HashSet<String>>> =
    std::sync::Mutex::new(None);

/// 実行中フラグ。Drop で解除される。
pub(crate) struct RunGuard(String);

impl Drop for RunGuard {
    fn drop(&mut self) {
        let mut g = RUNNING.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(set) = g.as_mut() {
            set.remove(&self.0);
        }
    }
}

/// 同じタスクが実行中なら `None`。
pub(crate) fn try_acquire_run(task_id: &str) -> Option<RunGuard> {
    let mut g = RUNNING.lock().unwrap_or_else(|p| p.into_inner());
    let set = g.get_or_insert_with(std::collections::HashSet::new);
    if set.insert(task_id.to_string()) {
        Some(RunGuard(task_id.to_string()))
    } else {
        None
    }
}

/// タスクを実行し、実行ログへ記録し、タスク定義の表示用ミラー
/// (`last_run_at`/`last_status`) を更新し、`task-run:*` イベントを emit する。
/// スケジューラの tick と `commands::tasks::run_task_now` (手動即時実行) の両方
/// から呼ばれる共通経路 (#730)。
pub(crate) async fn execute_and_log(
    app: &AppHandle,
    task: TaskDefinition,
    catch_up: bool,
) -> TaskRunEvent {
    let started = Utc::now();
    let progress = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let outcome = executor::run_once(app, &task, &progress).await;
    record_outcome(app, task, catch_up, started, outcome)
        .await
        .0
}

/// 実行結果をログへ記録し、タスク定義のミラーを更新し、`task-run:*` を emit する。
/// 「今すぐ実行」の中断 (`TaskOutcome` を作って渡す) でも使う。
pub(crate) async fn record_outcome(
    app: &AppHandle,
    task: TaskDefinition,
    catch_up: bool,
    started: DateTime<Utc>,
    outcome: executor::TaskOutcome,
) -> (TaskRunEvent, Option<i64>) {
    record_outcome_counting(app, task, catch_up, started, outcome, true).await
}

/// [`record_outcome`] の本体。`count_streak` が false のとき、この結果を連続失敗の
/// 数え直しに反映しない (手動実行の「中断」は失敗ではないため, #1621)。
pub(crate) async fn record_outcome_counting(
    app: &AppHandle,
    task: TaskDefinition,
    catch_up: bool,
    started: DateTime<Utc>,
    outcome: executor::TaskOutcome,
    count_streak: bool,
) -> (TaskRunEvent, Option<i64>) {
    let finished = Utc::now();
    let elapsed_ms = (finished - started).num_milliseconds().max(0);
    let status = if outcome.ok { "ok" } else { "error" };

    let new_run = NewTaskRun {
        task_id: task.id.clone(),
        started_at: started.to_rfc3339(),
        finished_at: finished.to_rfc3339(),
        status: status.to_string(),
        error: outcome.error.clone(),
        output_path: outcome.output_path.clone(),
        rows: outcome.rows,
        bytes: outcome.bytes,
        elapsed_ms,
        catch_up,
        attempts: i64::from(outcome.attempts.max(1)),
    };
    // 記録した行の id。呼び出し側 (今すぐ実行) は「最新行」ではなくこの行を返す
    // (見送られた予定発火の skipped 行が新しく割り込んでも取り違えない)。
    let run_id = match runs::record(new_run).await {
        Ok(id) => Some(id),
        Err(e) => {
            tracing::error!(task_id = %task.id, error = %e, "task scheduler: failed to record run log");
            None
        }
    };
    // アサーション実行 (#1170): 1 件ごとの合否をトレンド表示用に蓄積する。
    if let Err(e) = runs::record_assertion_results(
        &task.id,
        &started.to_rfc3339(),
        outcome.assertion_results.clone(),
    )
    .await
    {
        tracing::error!(task_id = %task.id, error = %e, "task scheduler: failed to record assertion results");
    }

    let started_str = started.to_rfc3339();
    let auto_paused = match update_last_run_mirror(
        &task.id,
        &started_str,
        status,
        outcome.ok,
        count_streak,
    ) {
        Ok(paused) => paused,
        Err(e) => {
            tracing::error!(task_id = %task.id, error = %e, "task scheduler: failed to update task's last-run mirror");
            false
        }
    };
    if auto_paused {
        tracing::warn!(task_id = %task.id, name = %task.name, limit = task.pause_after_failures, "scheduled task paused after consecutive failures");
    }

    if outcome.ok {
        tracing::info!(task_id = %task.id, name = %task.name, elapsed_ms, "scheduled task completed");
    } else {
        tracing::error!(task_id = %task.id, name = %task.name, error = ?outcome.error, "scheduled task failed");
    }

    let event = TaskRunEvent {
        task_id: task.id.clone(),
        task_name: task.name.clone(),
        status: status.to_string(),
        message: outcome.error,
        output_path: outcome.output_path,
        catch_up,
        auto_paused,
    };
    let event_name = if outcome.ok {
        EV_TASK_RUN_DONE
    } else {
        EV_TASK_RUN_ERROR
    };
    let _ = app.emit(event_name, event.clone());
    (event, run_id)
}

/// タスク定義を読み直し・部分更新・保存し直す共通ヘルパー。タスクが
/// (並行して) 削除済みなら何もしない (エラーにしない — レースはあり得る想定内)。
fn update_task_fields(id: &str, f: impl FnOnce(&mut TaskDefinition)) -> Result<()> {
    // 読み → 変更 → 書きはストアのロック下で一息に行う。`load_all` と
    // `save_all` を別々に呼ぶと、その間に割り込んだ `upsert` / `delete` の
    // 変更をスケジューラの書き戻しが消してしまう (実行のたびに `next_run_at`
    // を書くので、ユーザの編集と競合する窓が繰り返し開く)。
    store::update_all(|tasks| {
        if let Some(t) = tasks.iter_mut().find(|t| t.id == id) {
            f(t);
        }
        Ok(())
    })
}

fn persist_next_run(id: &str, next: DateTime<Utc>) -> Result<()> {
    let next_str = next.to_rfc3339();
    update_task_fields(id, |t| t.next_run_at = Some(next_str))
}

/// 直近の実行結果のミラーと連続失敗の数え直しを書く。連続失敗の上限に達して
/// タスクを自動停止したら `true` (#1621)。
fn update_last_run_mirror(
    id: &str,
    started_at: &str,
    status: &str,
    ok: bool,
    count_streak: bool,
) -> Result<bool> {
    let started_at = started_at.to_string();
    let status = status.to_string();
    let now = Utc::now().to_rfc3339();
    let mut paused = false;
    update_task_fields(id, |t| {
        t.last_run_at = Some(started_at);
        t.last_status = Some(status);
        if count_streak {
            paused = super::apply_run_result(t, ok, &now);
        }
    })?;
    Ok(paused)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    /// `spawn_detached` が **Tokio ランタイムの外** (通常の同期スレッド) から
    /// 呼ばれても panic しないことを固定する回帰テスト (v0.9.0 の起動即クラッシュ)。
    ///
    /// 本番の [`spawn`] は Tauri の `setup` フック = イベントループのメイン
    /// スレッドから呼ばれ、そこにはランタイムコンテキストが入っていない。この
    /// テスト関数も `#[tokio::test]` ではない素の `#[test]` なので同じ条件を
    /// 再現しており、実装を `tokio::spawn` に戻すと
    /// "there is no reactor running" で落ちる。
    #[test]
    fn spawn_detached_works_outside_a_tokio_runtime() {
        assert!(
            tokio::runtime::Handle::try_current().is_err(),
            "このテストはランタイム外から呼ばれる前提 (#[tokio::test] にしないこと)"
        );

        let ran = Arc::new(AtomicBool::new(false));
        let flag = ran.clone();
        spawn_detached(async move {
            flag.store(true, Ordering::SeqCst);
        });

        // 投入したタスクが実際にランタイム上で走ることまで確認する (投げっぱなし
        // なので JoinHandle は持たず、短いポーリングで待つ)。
        for _ in 0..200 {
            if ran.load(Ordering::SeqCst) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(
            ran.load(Ordering::SeqCst),
            "spawn_detached で投入したタスクが実行されなかった"
        );
    }
}

#[cfg(test)]
mod run_guard_tests {
    use super::*;

    #[test]
    fn same_task_cannot_run_twice_until_guard_dropped() {
        let g = try_acquire_run("guard-test-a");
        assert!(g.is_some());
        assert!(try_acquire_run("guard-test-a").is_none());
        assert!(try_acquire_run("guard-test-b").is_some());
        drop(g);
        assert!(try_acquire_run("guard-test-a").is_some());
    }
}

#[cfg(test)]
mod progress_tests {
    use super::*;
    use crate::tasks::TaskAction;

    #[test]
    fn progress_unit_follows_the_action_and_event_is_camel_case() {
        let a = TaskAction::RunAssertions {
            database: None,
            assertion_ids: Vec::new(),
            notify_only_on_increase: false,
        };
        assert_eq!(progress_unit(&a), "items");
        assert_eq!(
            progress_unit(&TaskAction::TimelapseCapture {
                max_generations: None
            }),
            "items"
        );
        assert_eq!(
            progress_unit(&TaskAction::RefreshPlanWatch {
                snippet_ids: Vec::new()
            }),
            "items"
        );
        let d = TaskAction::Dump {
            database: "db".into(),
            output_path: "x".into(),
            options: Default::default(),
        };
        assert_eq!(progress_unit(&d), "bytes");
        let ev = TaskRunProgressEvent {
            stream_id: "s".into(),
            task_id: "t".into(),
            count: 3,
            unit: "rows",
        };
        assert_eq!(
            serde_json::to_value(ev).unwrap(),
            serde_json::json!({ "streamId": "s", "taskId": "t", "count": 3, "unit": "rows" })
        );
    }
}
