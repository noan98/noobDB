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
    /// 保存済みのデータ品質アサーション (#742) を実行し、合否と observed 値を
    /// `assertion_runs` へ蓄積する (#1170)。実行は `run_assertion_with` (読み取り専用
    /// の `run_lookup_query` 経路) をそのまま通るので新たな書き込み経路は増えない。
    /// 1 件でも違反 / 実行エラーがあればタスク実行は `error` 扱いになり、失敗通知に乗る。
    RunAssertions {
        /// 対象データベース (MySQL のデータベース等)。未指定ならプロファイルの既定。
        #[serde(default)]
        database: Option<String>,
        /// 実行するアサーションの ID。空ならプロファイルのスコープに合うものすべて。
        #[serde(default)]
        assertion_ids: Vec<String>,
        /// true: 失敗 (違反 + 実行エラー) の件数が**前回の実行より増えたときだけ**タスクを
        /// `error` にして通知に乗せる (#1537)。既に知っている違反が残り続けているだけの
        /// 実行は `ok` で終わり、通知が毎回鳴り続けない。合否の記録 (`assertion_runs`) は
        /// どちらでも同じ。既定 false (従来どおり 1 件でも失敗があれば `error`)。
        #[serde(default)]
        notify_only_on_increase: bool,
    },
    /// ウォッチ中のテーブルのスナップショット (テーブル・タイムラプス #739) を無人で
    /// 取得して履歴を積む (#1537)。`timelapse_capture` と同じ実装 (`fetch_snapshot` →
    /// 世代記録) を通るので 3 ドライバ共通で、読み取りのみ。テーブルごとの取得失敗は
    /// タスクの `error` になる (他のテーブルの取得は続ける)。
    TimelapseCapture {
        /// 1 ウォッチあたりの保持世代数の上限。未指定ならタイムラプスの既定値。
        #[serde(default)]
        max_generations: Option<u32>,
    },
    /// ウォッチ中の EXPLAIN (実行計画ウォッチ #743) を無人で再取得し、**警告相当の変化**
    /// (インデックス使用からフルスキャンへの退行・推定行数の桁違いの増加など) が出たときだけ
    /// タスクを `error` にして通知に乗せる (#1537)。情報レベルの変化は世代として記録される
    /// だけで通知しない。判定は `plan_watch::compare_plans` で、画面の手動更新と同一。
    RefreshPlanWatch {
        /// 対象スニペットの ID。空ならこのプロファイルでウォッチ中のものすべて。
        #[serde(default)]
        snippet_ids: Vec<String>,
    },
}

/// 接続段階の自動リトライ設定 (#1537)。夜間バッチが一時的な瞬断や DB 再起動で丸ごと
/// 欠けないよう、**接続の確立に失敗したときだけ**指数バックオフで再試行する。
/// クエリ / エクスポート / ダンプの実行が始まった後の失敗は再試行しない (副作用の二重発生を
/// 避けるため)。`tasks.json` の旧データには無いので、すべて `serde(default)` で読む。
///
/// 待機は `interval_secs` から 2 倍ずつ伸ばし、1 回あたり 15 分で頭打ちにする。最悪の
/// 総待機は 10 回 × 15 分 = 2 時間 30 分。この間 `TASK_MAX_RUN_SECS` (クエリ実行の最大時間)
/// は進まず (接続後に始まる)、実行は「継続中」のままなので次の発火は重複としてスキップされる。
/// 待機のたびにタスク定義を読み直し、削除・無効化されていれば中止する。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectRetry {
    /// 初回に失敗した後の再試行回数。0 (既定) なら再試行しない。
    #[serde(default)]
    pub max_retries: u32,
    /// 最初の待機秒数。以降は 2 倍ずつ伸ばす (上限 `MAX_RETRY_DELAY_SECS`)。
    #[serde(default = "default_retry_interval_secs")]
    pub interval_secs: u32,
}

impl Default for ConnectRetry {
    fn default() -> Self {
        Self {
            max_retries: 0,
            interval_secs: default_retry_interval_secs(),
        }
    }
}

/// 再試行回数の上限 (保存時に丸める)。
pub const MAX_CONNECT_RETRIES: u32 = 10;
/// 最初の待機秒数の下限 / 上限 (保存時に丸める)。
pub const MIN_RETRY_INTERVAL_SECS: u32 = 5;
pub const MAX_RETRY_INTERVAL_SECS: u32 = 3600;
/// バックオフで伸ばした待機秒数の上限 (15 分)。
pub const MAX_RETRY_DELAY_SECS: u64 = 15 * 60;

fn default_retry_interval_secs() -> u32 {
    30
}

impl ConnectRetry {
    /// 保存前に範囲へ丸める (回数 0..=10、間隔 5 秒..=1 時間)。
    pub fn normalized(self) -> Self {
        Self {
            max_retries: self.max_retries.min(MAX_CONNECT_RETRIES),
            interval_secs: self
                .interval_secs
                .clamp(MIN_RETRY_INTERVAL_SECS, MAX_RETRY_INTERVAL_SECS),
        }
    }

    /// `attempt` 回目 (0 始まり) の再試行の前に待つ秒数。`interval * 2^attempt` を
    /// `MAX_RETRY_DELAY_SECS` で頭打ちにする (純関数)。
    pub fn delay_secs(&self, attempt: u32) -> u64 {
        let base = u64::from(self.interval_secs.max(1));
        let factor = 1u64.checked_shl(attempt.min(32)).unwrap_or(u64::MAX);
        base.saturating_mul(factor).min(MAX_RETRY_DELAY_SECS)
    }
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
    /// 接続失敗時の自動リトライ設定 (#1537)。旧 `tasks.json` には無く、既定は再試行なし。
    #[serde(default)]
    pub connect_retry: ConnectRetry,
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
    /// 接続を試みた回数 (#1537)。再試行なしの通常実行は 1。2 以上なら接続リトライが働いた。
    #[serde(default = "default_attempts")]
    pub attempts: i64,
}

fn default_attempts() -> i64 {
    1
}

/// アサーション実行タスク (#1170) の 1 アサーション分の結果。`task_runs` の 1 行に
/// 対して複数ぶら下がる (`assertion_runs` テーブル)。トレンド表示に使う。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssertionRunRecord {
    pub id: i64,
    pub task_id: String,
    /// 所属する実行の開始時刻 (`TaskRun.started_at` と同値)。
    pub run_started_at: String,
    pub assertion_id: String,
    /// 実行時点の名前 (後でアサーションが削除・改名されても履歴が読める)。
    pub assertion_name: String,
    pub passed: bool,
    /// `check_sql` の結果。実行エラーで取れなかったときは `None`。
    pub observed: Option<i64>,
    /// 実行エラー (接続断・タイムアウト・削除済みなど)。違反は `passed=false` のみで
    /// ここには入らない。
    pub error: Option<String>,
    pub elapsed_ms: i64,
}

/// `assertion_runs` へ書く前の 1 件 (`task_id` / `run_started_at` は記録側が付ける)。
#[derive(Debug, Clone)]
pub struct NewAssertionResult {
    pub assertion_id: String,
    pub assertion_name: String,
    pub passed: bool,
    pub observed: Option<i64>,
    pub error: Option<String>,
    pub elapsed_ms: i64,
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
    pub attempts: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connect_retry_delay_doubles_and_caps() {
        let r = ConnectRetry {
            max_retries: 5,
            interval_secs: 30,
        };
        assert_eq!(r.delay_secs(0), 30);
        assert_eq!(r.delay_secs(1), 60);
        assert_eq!(r.delay_secs(2), 120);
        assert_eq!(r.delay_secs(4), 480);
        assert_eq!(r.delay_secs(5), MAX_RETRY_DELAY_SECS);
        // 大きな試行回数でもオーバーフローしない。
        assert_eq!(r.delay_secs(u32::MAX), MAX_RETRY_DELAY_SECS);
    }

    #[test]
    fn connect_retry_normalized_clamps_both_fields() {
        let n = ConnectRetry {
            max_retries: 1000,
            interval_secs: 0,
        }
        .normalized();
        assert_eq!(n.max_retries, MAX_CONNECT_RETRIES);
        assert_eq!(n.interval_secs, MIN_RETRY_INTERVAL_SECS);
        let n = ConnectRetry {
            max_retries: 2,
            interval_secs: 999_999,
        }
        .normalized();
        assert_eq!(n.interval_secs, MAX_RETRY_INTERVAL_SECS);
        assert_eq!(ConnectRetry::default().max_retries, 0);
    }

    /// 後方互換: #1537 より前に保存された `tasks.json` (connect_retry も新アクションも
    /// notify_only_on_increase も無い) がそのまま読める。
    #[test]
    fn legacy_task_json_without_new_fields_still_loads() {
        let json = r#"{
            "id": "abcd1234", "name": "n", "profile_id": "p",
            "action": {"kind": "run_assertions", "assertion_ids": ["a1"]},
            "schedule": {"kind": "interval", "minutes": 5},
            "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z"
        }"#;
        let t: TaskDefinition = serde_json::from_str(json).unwrap();
        assert!(t.enabled);
        assert_eq!(t.connect_retry, ConnectRetry::default());
        assert!(matches!(
            t.action,
            TaskAction::RunAssertions {
                notify_only_on_increase: false,
                ..
            }
        ));
    }

    #[test]
    fn new_actions_round_trip() {
        let a: TaskAction = serde_json::from_str(r#"{"kind":"timelapse_capture"}"#).unwrap();
        assert!(matches!(
            a,
            TaskAction::TimelapseCapture {
                max_generations: None
            }
        ));
        let b: TaskAction =
            serde_json::from_str(r#"{"kind":"refresh_plan_watch","snippet_ids":["s1"]}"#).unwrap();
        match b {
            TaskAction::RefreshPlanWatch { snippet_ids } => assert_eq!(snippet_ids, vec!["s1"]),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn task_run_without_attempts_defaults_to_one() {
        let json = r#"{"id":1,"task_id":"t","started_at":"a","finished_at":"b","status":"ok",
            "error":null,"output_path":null,"rows":null,"bytes":null,"elapsed_ms":1}"#;
        let r: TaskRun = serde_json::from_str(json).unwrap();
        assert_eq!(r.attempts, 1);
        assert!(!r.catch_up);
    }
}
