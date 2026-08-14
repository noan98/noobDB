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

/// 1 回分の tick: 期限が来た有効なタスクをすべて実行に回す。`is_startup` は
/// アプリ起動直後の最初の tick かどうかで、そのときだけ
/// `schedule::resolve_startup_next_run` (未起動中に過ぎたスケジュールの追い掛け
/// 判定) を通す。以降の通常 tick は保存済みの `next_run_at` をそのまま比較する
/// (`save_task` / `set_task_enabled` が有効化のたびに正しい値を書いている前提)。
async fn tick(app: &AppHandle, is_startup: bool) -> Result<()> {
    let settings = store::load_settings()?;
    let tasks = store::load_all()?;
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
            let app2 = app.clone();
            tokio::spawn(async move {
                let _ = execute_and_log(&app2, task, catch_up).await;
            });
        } else if Some(effective_next) != persisted {
            // 新規タスク / 起動時リスケジュールなど、値が変わったときだけ書く。
            let _ = persist_next_run(&task.id, effective_next);
        }
    }
    Ok(())
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
    let outcome = executor::run_once(app, &task).await;
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
    };
    if let Err(e) = runs::record(new_run).await {
        tracing::error!(task_id = %task.id, error = %e, "task scheduler: failed to record run log");
    }

    let started_str = started.to_rfc3339();
    if let Err(e) = update_last_run_mirror(&task.id, &started_str, status) {
        tracing::error!(task_id = %task.id, error = %e, "task scheduler: failed to update task's last-run mirror");
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
    };
    let event_name = if outcome.ok {
        EV_TASK_RUN_DONE
    } else {
        EV_TASK_RUN_ERROR
    };
    let _ = app.emit(event_name, event.clone());
    event
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

fn update_last_run_mirror(id: &str, started_at: &str, status: &str) -> Result<()> {
    let started_at = started_at.to_string();
    let status = status.to_string();
    update_task_fields(id, |t| {
        t.last_run_at = Some(started_at);
        t.last_status = Some(status);
    })
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
