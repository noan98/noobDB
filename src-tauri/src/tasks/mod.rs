//! タスクスケジューラ (#730)。保存済みクエリ→ファイルエクスポート / DB ダンプを
//! 指定した間隔・時刻でアプリ起動中に自動実行する。
//!
//! - `store`: タスク定義の永続化 (`tasks.json`。`snippets/store.rs` と同じ JSON
//!   ストアパターン)。
//! - `schedule`: 次回発火時刻の計算・起動時の追い掛け判定。副作用なしの純粋関数
//!   ("スケジューラ純ロジック" の単体テスト対象)。
//! - `runs`: 実行履歴 (`task_runs.sqlite`。`history/store.rs` と同じ sqlx パターン。
//!   `history.sqlite` とは別ファイルで、クエリ履歴を汚さない)。
//! - `executor`: 1 回分のタスク実行 — プロファイルから接続を張り、アクションを
//!   実行し、切断する (常駐接続を増やさない)。
//! - `scheduler`: バックグラウンド Tokio タスクとしてループし、期限が来たタスクを
//!   `executor` に渡す。

pub mod executor;
pub mod runs;
pub mod schedule;
pub mod scheduler;
pub mod store;

use serde::{Deserialize, Serialize};

use crate::commands::dump::DumpOptions;
use crate::commands::export::ExportFormat;

/// タスクが実行するアクション。読み取り専用に限定される (#730 の受け入れ条件) —
/// `ExportQuery.sql` は保存時 (`commands::tasks::save_task`) と実行時
/// (`executor::run_once`) の両方で `db::is_read_only_sql` を通す。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TaskAction {
    /// SQL を実行し、結果をファイルへエクスポートする (`export_query_stream` と
    /// 同じ実行基盤を共有。#730)。
    ExportQuery {
        sql: String,
        #[serde(default)]
        database: Option<String>,
        format: ExportFormat,
        /// 出力先パス。`{date}` (YYYY-MM-DD) / `{datetime}`
        /// (YYYYMMDD-HHMMSS, UTC) のプレースホルダを実行時に展開する
        /// (`resolve_output_path`)。
        output_path: String,
        /// SQL INSERT 形式のときの対象テーブル名。他形式では無視。
        #[serde(default)]
        sql_table: Option<String>,
        /// SQL INSERT 形式のときの 1 文あたり行数。他形式では無視。
        #[serde(default)]
        sql_batch_size: Option<usize>,
    },
    /// データベース全体をダンプする (`dump_database` と同じ実行基盤を共有)。
    Dump {
        database: String,
        /// 出力先パス。`ExportQuery.output_path` と同じプレースホルダに対応。
        output_path: String,
        #[serde(default)]
        options: DumpOptions,
    },
}

/// タスクの発火スケジュール。時刻はすべて UTC で解釈する
/// (ローカルタイムゾーン変換は未対応。既知の制約として HelpView に明記)。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TaskSchedule {
    /// `minutes` 分ごと (最小 1 分)。
    Interval { minutes: u32 },
    /// 毎日 UTC `hour:minute` に 1 回。
    Daily { hour: u32, minute: u32 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskDefinition {
    /// 短いスラッグ (8 文字)。プロファイル/スニペットと同じ形式。
    pub id: String,
    pub name: String,
    pub profile_id: String,
    pub action: TaskAction,
    pub schedule: TaskSchedule,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
    /// 次回発火予定時刻 (RFC3339, UTC)。`None` はまだ一度もスケジュールされていない
    /// (保存直後に `commands::tasks::save_task` が設定する)。
    #[serde(default)]
    pub next_run_at: Option<String>,
    /// 直近の実行開始時刻 (RFC3339, UTC)。表示用のミラーで、詳細は `runs` ログを見る。
    #[serde(default)]
    pub last_run_at: Option<String>,
    /// 直近の実行結果 ("ok" / "error")。表示用のミラー。
    #[serde(default)]
    pub last_status: Option<String>,
}

fn default_true() -> bool {
    true
}

/// アプリ起動中に未発火のままだったスケジュールを、再起動後どう扱うかの設定。
/// `tasks.json` にタスク一覧と同居させる (プロファイル横断のグローバル設定)。
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct SchedulerSettings {
    /// true: アプリが閉じている間に過ぎたスケジュールを、次回起動時に 1 回だけ
    /// 追い掛け実行する。false (既定): 過ぎた分はスキップし、次の正規のタイミング
    /// まで待つ。
    #[serde(default)]
    pub catch_up_missed: bool,
}

/// 1 回分のタスク実行ログ。`history.sqlite` (クエリ履歴) とは別の
/// `task_runs.sqlite` に保存する。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskRun {
    pub id: i64,
    pub task_id: String,
    pub started_at: String,
    pub finished_at: String,
    /// `"ok"` or `"error"`.
    pub status: String,
    pub error: Option<String>,
    pub output_path: Option<String>,
    pub rows: Option<i64>,
    pub bytes: Option<i64>,
    pub elapsed_ms: i64,
    /// 起動時の追い掛け実行だったか (#730 の「未起動中に過ぎたスケジュール」対応)。
    #[serde(default)]
    pub catch_up: bool,
}

#[derive(Debug, Clone)]
pub struct NewTaskRun {
    pub task_id: String,
    pub started_at: String,
    pub finished_at: String,
    pub status: String,
    pub error: Option<String>,
    pub output_path: Option<String>,
    pub rows: Option<i64>,
    pub bytes: Option<i64>,
    pub elapsed_ms: i64,
    pub catch_up: bool,
}
