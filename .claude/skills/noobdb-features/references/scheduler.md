# タスクスケジューラ (#730)

保存済みクエリのファイルエクスポートと DB ダンプを、指定した間隔・時刻で
**アプリ起動中に**自動実行します。OS のタスクスケジューラの代替ではありません
(この制約は `HelpView` に明記)。

## モジュール構成 (`src-tauri/src/tasks/`)

| モジュール | 役割 |
|---|---|
| `store` | タスク定義の永続化 (`tasks.json`)。`snippets/store.rs` と同じ JSON ストアパターン |
| `schedule` | 次回発火時刻の計算・起動時の追い掛け判定。**副作用なしの純関数** |
| `runs` | 実行履歴 (`task_runs.sqlite`)。`history/store.rs` と同じ sqlx パターン |
| `executor` | 1 回分の実行 — プロファイルから接続を張り、アクションを実行し、切断する |
| `scheduler` | 常駐 Tokio タスク。一定間隔で `tasks.json` を読み直し、期限が来たものを `executor` へ渡す |

## 型

- **`TaskAction`** (`#[serde(tag = "kind")]`) — `ExportQuery` (SQL → ファイル。
  `export_query_stream` と同じ実行基盤を共有) と `Dump` (`dump_database` と同じ基盤)
  に加え、`RunAssertions` (#1170) がある。`output_path` は `{date}` (YYYY-MM-DD) / `{datetime}` (YYYYMMDD-HHMMSS, UTC)
  のプレースホルダを実行時に展開します (`resolve_output_path`)。
- **`RunAssertions { database, assertion_ids }`** (#1170) — 保存済みのデータ品質
  アサーション (#742) を実行する。`assertion_ids` が空ならプロファイルのスコープに
  合うもの全部 (`assertions::select_for_task`、判定はフロントの `scopeMatches` と同じ)、
  指定があればその ID (スコープは見ない。存在しない ID は実行エラーとして記録)。
  実行は `commands::assertions::run_assertion_with` (読み取り専用の
  `run_lookup_query` 経路) をそのまま通り、新たな書き込み経路は増えない。1 件でも
  違反 / 実行エラーがあればタスク実行は `error` (`executor::summarize_assertion_failures`
  が要約を `TaskRun.error` に入れる)。つまり既存の `task-run:error` → トースト +
  (アプリが背面なら) OS 通知 (`App.tsx`) の経路が export / dump の失敗と同じく効く。
  1 アサーションごとの合否 / observed は `task_runs.sqlite` の `assertion_runs`
  テーブル (`runs::record_assertion_results`、上限 20,000 行) に蓄積し、
  `list_assertion_runs` で読む (`TaskManager` の履歴に合否ドットのトレンド表示、
  整形は `taskFormat.buildAssertionTrends`)。`task_runs` のスキーマは不変で、
  `assertion_runs` は `CREATE TABLE IF NOT EXISTS` で既存 DB に足すだけ。
  `tasks.json` は `RunAssertions` の追加のみで既存タスクはそのまま読める。
- **`TaskSchedule`** — `Interval { minutes }` (最小 1 分) と
  `Daily { hour, minute }` の 2 種。
- **`SchedulerSettings.catch_up_missed`** — アプリが閉じている間に過ぎた
  スケジュールを次回起動時に 1 回だけ追い掛けるか。既定 `false` (スキップ)。
  タスク一覧と同居してプロファイル横断のグローバル設定として `tasks.json` に入ります。
- **`TaskRun`** — 1 回分の実行ログ。`catch_up` フラグで追い掛け実行を区別します。

## 設計上の要点

- **アクションは読み取り専用に限定されます** (#730 の受け入れ条件)。
  `ExportQuery.sql` は**保存時 (`save_task`) と実行時 (`executor::run_once`) の両方**で
  `db::is_read_only_sql` を通します。保存時の検証はプロファイル解決前に走るため、
  ドライバ非依存の保守的なマスクに倒れます (`noobdb-sql-safety` スキル参照)。
- **時刻はすべて UTC で解釈します。** ローカル時刻の方が直感的ですが、タイムゾーン
  変換 (DST 境界の曖昧さ含む) を持ち込むとテストの決定性が損なわれるため、初版は
  UTC 固定という既知の制約です (`HelpView` に明記)。`schedule` の関数は
  `DateTime<Utc>` を明示的に受け取り `Utc::now()` に依存しないので決定的にテストできます。
- **`AppState` には何も足しません。** 状態はディスク (`tasks.json` /
  `task_runs.sqlite`) のみ。IPC でタスクが編集されても、次の tick が `tasks.json` を
  読み直すだけで自然に追従します (明示的な再読み込みシグナルは不要)。
- tick 間隔は 20 秒 (`TICK_SECS`)。分単位のスケジュール精度に対して十分細かく、
  処理は `tasks.json` の読み直しだけなので負荷は無視できます。
- スケジューラは `lib.rs::run()` の `setup` フックから**一度だけ** spawn されます。
  ここは Tokio ランタイム外なので **`tauri::async_runtime::spawn` を使う**こと
  (回帰テスト: `tasks/scheduler.rs::spawn_detached_works_outside_a_tokio_runtime`)。
- 実行結果は `task-run:done` / `task-run:error` イベントで通知します。

## IPC / フロント

`list_tasks` / `save_task` / `delete_task` / `set_task_enabled` / `run_task_now` /
`list_task_runs` / `list_assertion_runs` / `clear_task_runs` / `get_scheduler_settings` /
`set_scheduler_settings`。UI は `components/TaskManager.tsx`、表示整形の純ロジックは
`components/taskFormat.ts`。
