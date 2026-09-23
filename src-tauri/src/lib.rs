// 本体コードでの unwrap / expect / panic を段階的に禁止するクレートレベル lint。
// テストコードは src-tauri/clippy.toml の allow-*-in-tests で除外済み。
// やむを得ず残す箇所には #[allow(...)] + 根拠コメントを付けること。
#![warn(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod cache;
mod commands;
mod db;
mod error;
mod flight_recorder;
mod history;
mod logs;
mod perf;
mod profiles;
mod sandboxes;
mod snippets;
mod ssh;
mod state;
mod tasks;
mod timelapse;

/// Test-only re-exports. Not part of the public API; subject to change.
#[doc(hidden)]
pub mod __test_api {
    pub use crate::db::advisor::{
        analyze, AdvisorInput, HealthFinding, RuleId, SchemaHealthReport, Severity, SkippedRule,
        TableMeta, UnusedIndexEntry, UnusedIndexStats,
    };
    pub use crate::db::aws_iam::AwsIamConfig;
    pub use crate::db::data_diff::{
        compute_data_diff, generate_data_sync_sql, DataDiff, RowDiff, RowStatus,
    };
    pub use crate::db::diff::{compute_schema_diff, ColumnDiff, DiffStatus, SchemaDiff, TableDiff};
    pub use crate::db::privileges::{
        generate_alter_password_sql, generate_create_user_sql, generate_drop_user_sql,
        generate_grant_sql, generate_revoke_sql, GrantSpec, PrivilegeFlags, UserSpec,
    };
    pub use crate::db::profile::{ColumnProfile, ProfileHistogramBucket, ProfileValueCount};
    pub use crate::db::sync::{generate_sync_sql, SyncKind, SyncPlan, SyncStatement};
    pub use crate::db::types::{
        Column, DbUserInfo, ForeignKey, IndexInfo, LiveQuery, LocalTableMeta, PreviewResult,
        ProcessInfo, QueryResult, QueryStatsSupport, RoutineParameter, RoutineSignature,
        SchemaObject, ServerInfo, ServerMetrics, ServerVariable, StatementStat, StreamBatch,
        TableColumnInfo, TableComment, TablePrivilegeRow, TableRowEstimate, TableRowIdentity,
        TableSchema, TableSizeInfo, UserPrivileges, Value,
    };
    pub use crate::db::upsert::{ConflictMode, ImportConflict};
    pub use crate::db::{
        apply_auto_limit, apply_auto_limit_for, classify_write_kind, classify_write_kind_for,
        is_read_only_sql, is_read_only_sql_for, is_session_init_sql, Connection, DbConnectOptions,
        DriverKind, SslMode, WriteCapture, WriteKind,
    };
    pub use crate::error::AppError;
    pub use crate::flight_recorder::undo::{build_undo_plan, UndoConflict, UndoPlan};
    pub use crate::flight_recorder::{NewWriteCapture, WriteCaptureRecord, WriteCaptureSummary};
    pub use crate::profiles::{ConnectionProfile, SshAuthMethod, SshJumpProfile, SshProfile};
    pub use crate::ssh::config_parser::{parse_proxy_jump, resolve_host, ResolvedSshHost};
    pub use crate::ssh::known_hosts::KnownHost;
    pub use crate::ssh::{SshConfig, SshJumpConfig, SshTunnel};
    pub use crate::state::{AppState, Session, StreamHandle, StreamKind};

    // コメント/リテラル・マスキングの実装横断ゴールデン (#988)。read-only 判定・
    // auto-limit・stacked 検出・危険 SQL 検出など全安全網が乗る「マスクしてから
    // キーワード走査」という共通土台そのものを固定する。マスク関数
    // (`db::mod::mask_for_analysis_conservative` / `mask_for_driver`) は
    // `Vec<char>` を受け取り `Vec<char>` を返すため、JSON フィクスチャとの
    // 突き合わせに使いやすい `&str -> String` の薄いラッパーをここで公開する
    // (`quote_ident` / `sql_literal` と同じ理由・同じパターン)。
    /// ドライバ非依存の呼び出し口 (`is_read_only_sql` 等) が使う保守的マスク。
    /// バックスラッシュを文字列エスケープと見なさない標準解釈。
    pub fn mask_for_analysis_conservative(sql: &str) -> String {
        let chars: Vec<char> = sql.chars().collect();
        crate::db::mask_for_analysis_conservative(&chars)
            .into_iter()
            .collect()
    }

    /// `driver` の文字列エスケープ規則でマスクする (#852)。MySQL だけ `\` を
    /// エスケープ文字として扱う。
    pub fn mask_for_driver(driver: DriverKind, sql: &str) -> String {
        let chars: Vec<char> = sql.chars().collect();
        crate::db::mask_for_driver(driver, &chars)
            .into_iter()
            .collect()
    }

    /// バックエンドの stacked 文検出 (#852)。文境界ゴールデン (#1074、
    /// `tests/statement_split_golden.rs`) が「フロントの文分割器が 2 文以上と見る
    /// 入力は、バックエンドも必ず stacked と判定する」ことを検証するために公開する。
    pub fn has_stacked_statements_for(driver: DriverKind, sql: &str) -> bool {
        crate::db::has_stacked_statements_for(driver, sql)
    }

    // zod ⇔ serde ゴールデン (#824) が代表インスタンスを組み立てるための追加の
    // レスポンス/永続化型の再エクスポート。いずれも非公開モジュール配下にあるため、
    // 内部モジュールを丸ごと public にせずここでピンポイントに公開する。
    pub use crate::commands::connection::ConnectResponse;
    pub use crate::commands::logs::LogView;
    pub use crate::commands::profiles::{ImportResult, ProfileWithSecretFlags};
    pub use crate::commands::query::CancelStreamResult;
    pub use crate::commands::sandbox::{
        filter_sandbox_data_diff, SandboxCreateResponse, SandboxSchemaDiffResult,
        SandboxTableDiffResult,
    };
    pub use crate::history::HistoryEntry;
    pub use crate::sandboxes::SandboxRecord;
    pub use crate::snippets::{Snippet, SnippetScope};

    // `commands::import::CsvPreview` はコマンドモジュール内に定義されているが、
    // フィクスチャ生成専用のため struct そのものを再公開する。
    pub use crate::commands::import::CsvPreview;

    // 接続間データ転送 (#986)。Tauri を介さずに統合テストから駆動するコア。
    pub use crate::commands::transfer::{
        transfer_data_inner, TransferColumnInfo, TransferOutcome, TransferRequest,
    };
    pub use crate::db::transfer::TransferMode;

    // ローカル横断クエリ (#740) — Tauri を経由せずに統合テストから駆動できるよう、
    // 各 IPC ハンドラの `_inner` コア (State なし) を再公開する。
    pub use crate::commands::local::{
        create_local_session_inner, drop_local_table_inner, list_local_tables_inner,
        register_local_table_inner, save_local_database_inner, RegisterLocalTableRequest,
        MAX_LOCAL_TABLE_ROWS,
    };

    // ストリーミングイベントの emit ペイロード構造体 (#825)。上記と同じくフィクスチャ
    // 生成専用のピンポイント再エクスポート。
    //
    // `commands::query` の Query/Preview ストリーム (#1096) は `app.emit()` の
    // 個別イベント構造体ではなく、Tauri Channel で送る 1 本のタグ付き enum
    // (`QueryStreamMessage` / `PreviewStreamMessage`) に統合済み。Export/Dump/
    // Import は引き続き個別の emit ペイロード構造体のまま。
    pub use crate::commands::connection::ConnectPhaseEvent;
    pub use crate::commands::dump::{DumpDoneEvent, DumpErrorEvent, DumpProgressEvent};
    pub use crate::commands::export::{ExportDoneEvent, ExportErrorEvent, ExportProgressEvent};
    pub use crate::commands::import::{
        ImportDoneEvent, ImportErrorEvent, ImportProgressEvent, ImportStartedEvent, SkippedRowInfo,
    };
    pub use crate::commands::query::{
        PreviewStreamMessage, QueryStreamMessage, StreamCancelledEvent,
    };
    pub use crate::commands::script::{
        ScriptDoneEvent, ScriptErrorEvent, ScriptFailure, ScriptOptions, ScriptProgress,
        ScriptProgressEvent, ScriptRun,
    };

    /// `.sql` スクリプトのストリーミング文分割 (#973) を一括で行い、各文の本文だけを
    /// 返す。フロント `splitSqlStatements` との共有ゴールデン
    /// (`tests/script_split_golden.rs`) 用。
    pub fn split_script(driver: DriverKind, sql: &str) -> Vec<String> {
        crate::db::script::split_script(driver, sql)
            .into_iter()
            .map(|s| s.sql)
            .collect()
    }

    /// `run_sql_script` の本体 (ファイル読み + 文分割 + 文ごとの read-only ガード +
    /// 実行 + トランザクション制御) を Tauri ランタイム無しで駆動する (#973)。
    /// `committed` はキャンセル時に `cancel_stream` が報告する確定済み文数。
    pub async fn run_sql_script_via_core<F>(
        session: std::sync::Arc<Session>,
        path: &str,
        database: Option<&str>,
        options: ScriptOptions,
        committed: std::sync::Arc<std::sync::atomic::AtomicU64>,
        on_progress: F,
    ) -> crate::error::Result<ScriptRun>
    where
        F: FnMut(ScriptProgress),
    {
        let total = crate::commands::script::script_file_size(path).await?;
        let file = tokio::fs::File::open(path).await?;
        crate::commands::script::run_script_core(
            session,
            file,
            total,
            database.map(str::to_string),
            options,
            committed,
            on_progress,
        )
        .await
    }

    /// エクスポート 1 件分を実ファイルではなくメモリへ書き出す (#879)。
    /// `commands::export::write_export_to` — 実ファイル出力と**同じ**振り分け /
    /// ライタ — をそのまま通すので、フロントの `exportPreview.ts` との共有
    /// ゴールデン (`tests/export_format_golden.rs`) は「プレビュー = 実出力」を
    /// 直接検証できる。
    pub fn export_bytes(
        format: crate::commands::export::ExportFormat,
        columns: &[Column],
        rows: &[Vec<Value>],
        query: Option<&str>,
        driver: Option<DriverKind>,
        table: Option<String>,
        batch_size: Option<usize>,
    ) -> crate::error::Result<Vec<u8>> {
        let opts = crate::commands::export::SqlExportOpts::build(driver, table, batch_size);
        let mut buf = Vec::new();
        crate::commands::export::write_export_to(
            &mut buf, format, columns, rows, query, &opts, None,
        )?;
        Ok(buf)
    }

    pub use crate::commands::export::{ExportFormat, ExportResult, ExportTruncation};

    /// xlsx エクスポートで 1 つの値がどのセルになるかを文字列で表す (#711)。
    /// 書き出し ([`crate::commands::export_xlsx::XlsxSheetWriter`]) が従う判定
    /// `xlsx_cell` をそのまま通すので、共有ゴールデン
    /// (`tests/export_format_golden.rs`) が xlsx のセル型・値を固定できる。
    /// 表記: 空セル `-` / 真偽 `b:true` / 数値 `n:<f64 の Display>` / 文字列 `s:<本文>`。
    pub fn xlsx_cell_repr(value: &Value, column: Option<&Column>) -> String {
        use crate::commands::export_xlsx::{xlsx_cell, XlsxCell};
        match xlsx_cell(value, column) {
            XlsxCell::Blank => "-".to_string(),
            XlsxCell::Bool(b) => format!("b:{b}"),
            XlsxCell::Number(n) => format!("n:{n}"),
            XlsxCell::Text(s) => format!("s:{s}"),
        }
    }

    /// SQL 識別子引用の単一実装 (`db::sync::quote_ident`)。`pub(crate)` のため
    /// `pub use` で再公開できず、薄いラッパーで露出する。実装横断ゴールデン
    /// (`tests/sql_quoting_golden.rs`、#880) が使う。
    pub fn quote_ident(driver: DriverKind, name: &str) -> String {
        crate::db::sync::quote_ident(driver, name)
    }

    /// SQL リテラルエスケープ (`db::data_diff::sql_literal`)。上と同じ理由の
    /// ラッパー (#880)。
    pub fn sql_literal(driver: DriverKind, value: &Value) -> String {
        crate::db::data_diff::sql_literal(driver, value)
    }
    // サーバ機能系コマンドの State なしコア (#881)。`inspector` / `server` /
    // `process` は env ゲートの MySQL/PostgreSQL 統合テストでしか実行されず、
    // Windows ジョブや env 無しのローカル `cargo test` (SQLite のみ) では
    // コマンド境界が一度も走らなかった。常時実走の `tests/sqlite_integration.rs`
    // から SQLite 短絡パス (非対応エラー / 縮退レスポンス) とセッション未検出の
    // 経路を駆動できるよう、ここでピンポイントに公開する。
    pub use crate::commands::inspector::{
        query_stats_support_inner, sample_live_queries_inner, sample_statement_stats_inner,
    };
    pub use crate::commands::process::list_processes_inner;
    pub use crate::commands::profile::profile_column_inner;
    pub use crate::commands::server::{server_info_inner, server_metrics_inner};

    /// 外部バイナリ非依存の論理ダンプ (#987) をメモリ上の文字列として得る。
    /// `commands::dump::run_dump` が実ファイルへ書くのと同じ
    /// `Connection::native_dump` を通すので、統合テストは「ダンプ → 再実行 →
    /// 同一データ」の往復をそのまま検証できる。
    pub async fn native_dump_sql(
        conn: &Connection,
        database: &str,
        opts: &NativeDumpOptions,
    ) -> crate::error::Result<String> {
        let mut out = String::new();
        conn.native_dump(database, opts, &mut out).await?;
        Ok(out)
    }
    pub use crate::db::native_dump::NativeDumpOptions;

    pub async fn connect(opts: &DbConnectOptions) -> crate::error::Result<Connection> {
        Connection::connect(opts).await
    }

    /// Builds a [`Session`] around a live connection for integration tests, so
    /// they can register it in an [`AppState`] and drive the real query
    /// commands. `skip_history` is forced on to keep tests from touching the
    /// on-disk history database.
    pub fn make_session(
        id: &str,
        conn: Connection,
        opts: DbConnectOptions,
        read_only: bool,
    ) -> Session {
        Session {
            id: id.to_string(),
            profile_id: None,
            conn,
            connect_options: opts,
            read_only,
            emergency_write: std::sync::atomic::AtomicBool::new(false),
            skip_history: true,
            reconnect_ssh: None,
            _tunnel: None,
            local_temp_file: None,
            schema_cache: crate::cache::SchemaCache::default(),
            query_cache: crate::cache::QueryResultCache::default(),
        }
    }

    /// Drives the `set_emergency_mode` IPC command's core path (session lookup
    /// + read-only precondition + flag flip) without a Tauri runtime.
    pub async fn set_emergency_mode_via_command(
        state: &AppState,
        session_id: &str,
        enabled: bool,
    ) -> crate::error::Result<()> {
        crate::commands::query::set_emergency_mode_inner(state, session_id, enabled).await
    }

    /// Drives the `reconnect` IPC command's core path (session lookup + in-place
    /// transport rebuild + same-id swap) without a Tauri runtime (#712).
    pub async fn reconnect_via_command(
        state: &AppState,
        session_id: &str,
    ) -> crate::error::Result<()> {
        crate::commands::connection::reconnect_inner(state, session_id).await
    }

    /// Drives the `run_query` IPC command's core path (session lookup +
    /// read-only guard + execute) without a Tauri runtime.
    pub async fn run_query_via_command(
        state: &AppState,
        session_id: &str,
        sql: &str,
        database: Option<&str>,
    ) -> crate::error::Result<QueryResult> {
        crate::commands::query::run_query_inner(state, session_id, sql, database).await
    }

    /// Drives the `run_lookup_query` IPC command's core path (#1067): the
    /// always-on read-only guard, the row cap and the timeout.
    pub async fn run_lookup_query_via_command(
        state: &AppState,
        session_id: &str,
        sql: &str,
        database: Option<&str>,
        query_timeout_secs: Option<u64>,
        row_cap: Option<u32>,
    ) -> crate::error::Result<QueryResult> {
        crate::commands::query::run_lookup_query_inner(
            state,
            session_id,
            sql,
            database,
            query_timeout_secs,
            row_cap,
        )
        .await
    }

    /// Drives the `run_query_transaction` IPC command's core path, exercising
    /// the per-statement read-only guard.
    pub async fn run_query_transaction_via_command(
        state: &AppState,
        session_id: &str,
        statements: Vec<String>,
        database: Option<&str>,
    ) -> crate::error::Result<QueryResult> {
        crate::commands::query::run_query_transaction_inner(
            state,
            session_id.to_string(),
            statements,
            database.map(str::to_string),
        )
        .await
    }

    /// Drives the `run_in_transaction` IPC command's core path (session lookup,
    /// read-only guard, execute-in-transaction, cache invalidation) without a
    /// Tauri runtime (#1097's Query Result Cache eager-invalidate path — see
    /// `commands::query::run_in_transaction_inner`'s doc comment).
    pub async fn run_in_transaction_via_command(
        state: &AppState,
        session_id: &str,
        sql: &str,
    ) -> crate::error::Result<QueryResult> {
        crate::commands::query::run_in_transaction_inner(state, session_id, sql).await
    }

    /// ファイル → 新規テーブル作成 → ロードの経路 (#985) を Tauri ランタイム無しで
    /// 駆動する。`import_csv` と同じ検証 (read_only ガード・新規テーブル定義) を
    /// 掛けてから同じコア (`run_import_core`) を走らせる。引数は IPC と同じ JSON
    /// 形 (camelCase) で受け、ワイヤ形のデシリアライズも一緒に検証する。
    /// 戻り値: `Ok(Ok(挿入行数))` / abort モードの行エラーは `Ok(Err(msg))`。
    pub async fn import_file_via_command(
        session: &Session,
        database: Option<&str>,
        table: &str,
        path: &str,
        options: serde_json::Value,
        mapping: serde_json::Value,
        create_table: Option<serde_json::Value>,
    ) -> crate::error::Result<std::result::Result<u64, String>> {
        let bad = |e: serde_json::Error| crate::error::AppError::InvalidInput(e.to_string());
        let options = serde_json::from_value(options).map_err(bad)?;
        let mapping = serde_json::from_value(mapping).map_err(bad)?;
        let create_table = match create_table {
            Some(v) => Some(serde_json::from_value(v).map_err(bad)?),
            None => None,
        };
        crate::commands::import::import_file_for_test(
            session,
            database.map(str::to_string),
            table.to_string(),
            path.to_string(),
            options,
            mapping,
            create_table,
        )
        .await
    }

    /// `preview_create_table_ddl` IPC と同じ DDL 生成 (#985)。
    pub fn render_create_table(
        driver: DriverKind,
        table: &str,
        columns: serde_json::Value,
    ) -> crate::error::Result<String> {
        let columns: Vec<crate::db::create_table::NewColumn> = serde_json::from_value(columns)
            .map_err(|e| crate::error::AppError::InvalidInput(e.to_string()))?;
        crate::db::create_table::render_create_table(driver, table, &columns)
    }

    /// The read-only guard the `import_csv` IPC command applies before any CSV
    /// rows reach the driver.
    pub fn ensure_import_writable(session: &Session) -> crate::error::Result<()> {
        crate::commands::import::ensure_import_writable(session)
    }

    /// Drives the captured-write core path (session lookup + read-only guard +
    /// capture + history recording) without a Tauri runtime (#735). Production
    /// reaches the same core through `run_query_stream({ capture: true })`
    /// (#907 removed the unused non-streaming IPC command).
    pub async fn run_captured_write_via_command(
        state: &AppState,
        session_id: &str,
        sql: &str,
        database: Option<&str>,
        row_cap: Option<u32>,
        retention_days: Option<u32>,
    ) -> crate::error::Result<crate::commands::flight_recorder::CapturedWriteResponse> {
        crate::commands::flight_recorder::run_captured_write_inner(
            state,
            session_id.to_string(),
            sql.to_string(),
            database.map(str::to_string),
            row_cap,
            retention_days,
        )
        .await
    }

    /// Drives the `undo_flight_record` IPC command's core path without a
    /// Tauri runtime (#735).
    pub async fn undo_flight_record_via_command(
        state: &AppState,
        session_id: &str,
        id: i64,
        force: bool,
    ) -> crate::error::Result<crate::commands::flight_recorder::UndoOutcome> {
        crate::commands::flight_recorder::undo_flight_record_inner(
            state,
            session_id.to_string(),
            id,
            force,
        )
        .await
    }

    /// Drives the `preview_undo` IPC command's core path without a Tauri
    /// runtime (#735).
    pub async fn preview_undo_via_command(
        state: &AppState,
        session_id: &str,
        id: i64,
    ) -> crate::error::Result<crate::commands::flight_recorder::UndoPreviewResponse> {
        let (plan, _record) =
            crate::commands::flight_recorder::plan_undo(state, session_id, id, false).await?;
        Ok(crate::commands::flight_recorder::UndoPreviewResponse {
            statements: plan.statements,
            conflicts: plan.conflicts,
            warnings: plan.warnings,
        })
    }

    /// Lists flight-recorder captures directly against the store, for tests
    /// that need to find a capture's id after `run_captured_write_via_command`.
    pub async fn list_flight_records_for_tests(
        profile_id: Option<&str>,
    ) -> crate::error::Result<Vec<crate::flight_recorder::WriteCaptureSummary>> {
        crate::flight_recorder::store::list(profile_id, 100).await
    }

    /// Drives the `kill_process` IPC command's core path (session lookup +
    /// read-only guard + driver kill) without a Tauri runtime.
    pub async fn kill_process_via_command(
        state: &AppState,
        session_id: &str,
        process_id: i64,
    ) -> crate::error::Result<()> {
        crate::commands::process::kill_process_inner(state, session_id, process_id).await
    }

    /// Drives the full schema-comparison path (`commands::diff`) without Tauri:
    /// collects both sides' table / column metadata from live connections and
    /// runs the pure diff. Lets integration tests verify real introspection
    /// feeds the diff correctly, not just the pure function in isolation.
    pub async fn compare_schemas(
        source: &Connection,
        source_db: &str,
        target: &Connection,
        target_db: &str,
    ) -> crate::error::Result<SchemaDiff> {
        let s = crate::commands::diff::collect_table_columns(source, source_db).await?;
        let t = crate::commands::diff::collect_table_columns(target, target_db).await?;
        Ok(compute_schema_diff(
            source.driver_kind(),
            target.driver_kind(),
            &s,
            &t,
        ))
    }

    /// Drives the `refresh_schema_cache` IPC command's core path (session
    /// lookup + `SchemaCache::invalidate_all`) without a Tauri runtime (#1097),
    /// so integration tests can exercise the explicit-Refresh path the same
    /// way the frontend's Schema Browser refresh button does.
    pub async fn refresh_schema_cache_via_command(
        state: &AppState,
        session_id: &str,
    ) -> crate::error::Result<()> {
        crate::commands::schema::refresh_schema_cache_inner(state, session_id).await
    }

    /// Drives the `apply_sync_sql` IPC command's core path (session lookup +
    /// read-only guard + empty-statement guard + transactional apply) without a
    /// Tauri runtime, so integration tests can verify the destructive-write
    /// guards actually fire on the command layer (not just the pure generator).
    pub async fn apply_sync_sql_via_command(
        state: &AppState,
        session_id: &str,
        database: Option<&str>,
        statements: Vec<String>,
    ) -> crate::error::Result<u64> {
        crate::commands::sync::apply_sync_sql_inner(
            state,
            session_id.to_string(),
            database.map(str::to_string),
            statements,
        )
        .await
    }

    /// Drives the `apply_privilege_sql` IPC command's core path (session
    /// lookup + read-only guard + empty-statement guard + transactional
    /// apply) without a Tauri runtime, mirroring
    /// [`apply_sync_sql_via_command`].
    pub async fn apply_privilege_sql_via_command(
        state: &AppState,
        session_id: &str,
        database: Option<&str>,
        statements: Vec<String>,
    ) -> crate::error::Result<u64> {
        crate::commands::privileges::apply_privilege_sql_inner(
            state,
            session_id.to_string(),
            database.map(str::to_string),
            statements,
        )
        .await
    }

    /// Drives the `create_sandbox` IPC command's core path without a Tauri
    /// runtime (#747).
    #[allow(clippy::too_many_arguments)]
    pub async fn create_sandbox_via_command(
        state: &AppState,
        source_session_id: &str,
        source_database: Option<&str>,
        name: &str,
        tables: Vec<String>,
        include_related: bool,
        row_limit: Option<u64>,
    ) -> crate::error::Result<SandboxCreateResponse> {
        crate::commands::sandbox::create_sandbox_inner(
            state,
            source_session_id.to_string(),
            source_database.map(str::to_string),
            name.to_string(),
            tables,
            include_related,
            row_limit,
        )
        .await
    }

    /// Drives the `discard_sandbox` IPC command's core path without a Tauri
    /// runtime (#747).
    pub async fn discard_sandbox_via_command(
        state: &AppState,
        sandbox_id: &str,
        session_id: Option<&str>,
    ) -> crate::error::Result<()> {
        crate::commands::sandbox::discard_sandbox_inner(
            state,
            sandbox_id.to_string(),
            session_id.map(str::to_string),
        )
        .await
    }

    /// Drives the `sandbox_table_diff` IPC command's core path without a
    /// Tauri runtime (#747).
    #[allow(clippy::too_many_arguments)]
    pub async fn sandbox_table_diff_via_command(
        state: &AppState,
        sandbox_id: &str,
        sandbox_session_id: &str,
        table: &str,
        source_session_id: Option<&str>,
        limit: Option<usize>,
    ) -> crate::error::Result<SandboxTableDiffResult> {
        crate::commands::sandbox::sandbox_table_diff_inner(
            state,
            sandbox_id.to_string(),
            sandbox_session_id.to_string(),
            table.to_string(),
            source_session_id.map(str::to_string),
            limit,
        )
        .await
    }

    /// Drives the `sandbox_schema_diff` IPC command's core path without a
    /// Tauri runtime (#747).
    pub async fn sandbox_schema_diff_via_command(
        state: &AppState,
        sandbox_id: &str,
        sandbox_session_id: &str,
        source_session_id: Option<&str>,
    ) -> crate::error::Result<SandboxSchemaDiffResult> {
        crate::commands::sandbox::sandbox_schema_diff_inner(
            state,
            sandbox_id.to_string(),
            sandbox_session_id.to_string(),
            source_session_id.map(str::to_string),
        )
        .await
    }

    /// Drives the `sandbox_advance_base` IPC command's core path without a
    /// Tauri runtime (#747).
    pub async fn sandbox_advance_base_via_command(
        state: &AppState,
        sandbox_id: &str,
        sandbox_session_id: &str,
        table: &str,
        applied: DataDiff,
        allow_delete: bool,
    ) -> crate::error::Result<()> {
        crate::commands::sandbox::sandbox_advance_base_inner(
            state,
            sandbox_id.to_string(),
            sandbox_session_id.to_string(),
            table.to_string(),
            applied,
            allow_delete,
        )
        .await
    }

    /// Lists every sandbox's non-secret metadata (`list_sandboxes` IPC's core;
    /// already Tauri-free so this just re-exports it for test symmetry).
    pub fn list_sandboxes_via_command() -> crate::error::Result<Vec<SandboxRecord>> {
        crate::commands::sandbox::list_sandboxes()
    }

    /// Drives the schema-health advisor's full command path
    /// (`commands::advisor`) without Tauri: collects table / column / index /
    /// foreign-key metadata and unused-index stats from a live connection and
    /// runs the pure rule engine. Lets integration tests verify real
    /// introspection feeds the advisor correctly.
    pub async fn analyze_schema_health(
        conn: &Connection,
        database: &str,
    ) -> crate::error::Result<SchemaHealthReport> {
        crate::commands::advisor::collect_and_analyze(conn, database).await
    }

    /// Runs `sql` against MySQL via the text protocol, for statements the
    /// prepared-statement protocol rejects (e.g. CREATE/DROP PROCEDURE).
    pub async fn mysql_exec_text(opts: &DbConnectOptions, sql: &str) -> crate::error::Result<()> {
        crate::db::mysql::exec_text_protocol(opts, sql).await
    }

    /// Naive parser for `mysql://user:password@host:port/database` used in tests.
    pub fn parse_mysql_url(url: &str) -> Option<DbConnectOptions> {
        parse_tcp_url(url, "mysql://", 3306, DriverKind::Mysql)
    }

    /// Naive parser for `postgres://user:password@host:port/database`.
    pub fn parse_postgres_url(url: &str) -> Option<DbConnectOptions> {
        parse_tcp_url(url, "postgres://", 5432, DriverKind::Postgres)
            .or_else(|| parse_tcp_url(url, "postgresql://", 5432, DriverKind::Postgres))
    }

    /// Naive parser for `mssql://user:password@host:port/database` used in
    /// tests (#729).
    pub fn parse_mssql_url(url: &str) -> Option<DbConnectOptions> {
        parse_tcp_url(url, "mssql://", 1433, DriverKind::Mssql)
    }

    /// Build SQLite connect options from a filesystem path.
    pub fn sqlite_options(path: &str) -> DbConnectOptions {
        DbConnectOptions {
            host: String::new(),
            port: 0,
            user: String::new(),
            password: String::new(),
            database: None,
            driver: DriverKind::Sqlite,
            file_path: Some(path.to_string()),
            ssl_mode: None,
            ssl_root_cert: None,
            ssl_client_cert: None,
            ssl_client_key: None,
            init_sql: None,
            aws_iam: None,
        }
    }

    /// Build DuckDB connect options from a filesystem path (#709).
    pub fn duckdb_options(path: &str) -> DbConnectOptions {
        DbConnectOptions {
            host: String::new(),
            port: 0,
            user: String::new(),
            password: String::new(),
            database: None,
            driver: DriverKind::DuckDb,
            file_path: Some(path.to_string()),
            ssl_mode: None,
            ssl_root_cert: None,
            ssl_client_cert: None,
            ssl_client_key: None,
            init_sql: None,
            aws_iam: None,
        }
    }

    fn parse_tcp_url(
        url: &str,
        scheme: &str,
        default_port: u16,
        driver: DriverKind,
    ) -> Option<DbConnectOptions> {
        let rest = url.strip_prefix(scheme)?;
        let (creds, hostpart) = rest.split_once('@')?;
        let (user, password) = match creds.split_once(':') {
            Some((u, p)) => (u.to_string(), p.to_string()),
            None => (creds.to_string(), String::new()),
        };
        let (hostport, database) = match hostpart.split_once('/') {
            Some((hp, d)) => (
                hp,
                if d.is_empty() {
                    None
                } else {
                    Some(d.to_string())
                },
            ),
            None => (hostpart, None),
        };
        let (host, port) = match hostport.split_once(':') {
            Some((h, p)) => (h.to_string(), p.parse().ok()?),
            None => (hostport.to_string(), default_port),
        };
        Some(DbConnectOptions {
            host,
            port,
            user,
            password,
            database,
            driver,
            file_path: None,
            ssl_mode: None,
            ssl_root_cert: None,
            ssl_client_cert: None,
            ssl_client_key: None,
            init_sql: None,
            aws_iam: None,
        })
    }

    // `is_query_shape` の実装横断ゴールデンテスト (#971)。ストリーミング実行器が
    // fetch 経路 (結果セットを返す) と execute 経路 (rows_affected のみ) の
    // どちらを通すかを決める判定は、`is_read_only_sql` (#444) とは異なり
    // 共有関数ではなく sqlite/mysql/postgres/duckdb/mssql の各モジュールに
    // それぞれ private 関数として個別実装されている。5 実装が一致すべき境界
    // ケースをこの下のディスパッチャ経由で `tests/query_shape_golden.rs` へ
    // 通す。各モジュール本体の関数は挙動を変えず `pub(crate)` へ引き上げただけ
    // (`pub use` では再公開できないため、`quote_ident`/`sql_literal` と同じく
    // 薄いラッパー関数でここへ集約する)。

    /// `db::{driver}::is_query_shape` へディスパッチする。ストリーミング実行器
    /// の fetch/execute 経路振り分けそのものであり、判定ロジックはここでは
    /// 一切変更しない (5 モジュールの private 関数をそのまま呼ぶだけ)。
    pub fn is_query_shape(driver: DriverKind, sql: &str) -> bool {
        match driver {
            DriverKind::Mysql => crate::db::mysql::is_query_shape(sql),
            DriverKind::Postgres => crate::db::postgres::is_query_shape(sql),
            DriverKind::Sqlite => crate::db::sqlite::is_query_shape(sql),
            DriverKind::DuckDb => crate::db::duckdb::is_query_shape(sql),
            DriverKind::Mssql => crate::db::mssql::is_query_shape(sql),
        }
    }
}

use tracing_subscriber::{fmt, prelude::*, EnvFilter};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,sqlx=warn"));

    // Tee events to stdout (terminal during `tauri dev`) and to a size-capped
    // file under the data dir that the Settings log viewer reads. The file layer
    // is dropped when no data dir is available, leaving stdout-only logging.
    let file_layer = logs::init().map(|writer| fmt::layer().with_ansi(false).with_writer(writer));
    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_writer(std::io::stdout))
        .with(file_layer)
        .init();

    tracing::info!(version = env!("CARGO_PKG_VERSION"), "noobDB starting");

    // ローカル横断クエリ (#740) の一時 DB は前回起動のセッション寿命に紐づくため、
    // 新しいプロセスの起動時点で前回分は必ず無効 — 異常終了で残った分をここで掃除する。
    commands::local::cleanup_stale_local_files();
    // ダンプ用の一時資格情報ファイル (`noobdb-dump-*.cnf`/`.pgpass`、平文の DB
    // パスワードを含む) も同じ理由で前回起動分は無効。通常は Drop で消えるが、
    // SIGKILL/OOM/クラッシュなど Drop を経由しない終了だと残ってしまうため、
    // 同じタイミング・同じベストエフォート方針で掃除する。
    commands::dump::cleanup_stale_dump_credential_files();

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // 長時間クエリ完了時の OS デスクトップ通知 (#707)。フロントは
        // @tauri-apps/plugin-notification の JS API を直接呼ぶため、追加の
        // Tauri コマンド登録は不要 (capabilities に notification:default のみ追加)。
        .plugin(tauri_plugin_notification::init());

    // アプリ内自動更新 (#705)。updater / process はデスクトップ専用プラグインなので
    // desktop ターゲットのときだけ登録する (モバイル対応時にビルドが壊れないよう
    // Tauri 公式テンプレートと同じ cfg ガードを踏襲)。更新の検出/ダウンロード/適用は
    // フロント (`updater.ts`) が JS API で駆動し、ユーザ承認時のみ再起動する。
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }

    let result = builder
        .manage(state::AppState::default())
        // タスクスケジューラ (#730)。アプリ起動中のみ発火するバックグラウンド
        // Tokio タスクとして常駐する。状態は tasks.json / task_runs.sqlite の
        // ディスク上のみに持つため、AppState への追加は不要。
        .setup(|app| {
            tasks::scheduler::spawn(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::connection::test_connection,
            commands::connection::connect,
            commands::connection::cancel_connect,
            commands::connection::disconnect,
            commands::connection::reconnect,
            commands::connection::ping_session,
            commands::ssh::list_known_hosts,
            commands::ssh::forget_host_key,
            commands::ssh::trust_host_key,
            commands::ssh::resolve_ssh_config_host,
            commands::query::run_query,
            commands::query::run_query_transaction,
            commands::query::run_lookup_query,
            commands::query::begin_transaction,
            commands::query::run_in_transaction,
            commands::query::finish_transaction,
            commands::query::run_query_stream,
            commands::query::set_emergency_mode,
            commands::query::preview_query_stream,
            commands::query::cancel_stream,
            commands::schema::list_databases,
            commands::schema::list_tables,
            commands::schema::describe_table,
            commands::schema::table_row_identity,
            commands::schema::schema_overview,
            commands::schema::foreign_keys,
            commands::schema::list_indexes,
            commands::schema::list_schema_objects,
            commands::schema::get_object_definition,
            commands::schema::get_routine_signature,
            commands::schema::table_row_estimates,
            commands::schema::list_table_comments,
            commands::schema::table_sizes,
            commands::server::server_info,
            commands::server::server_metrics,
            commands::process::list_processes,
            commands::process::kill_process,
            commands::privileges::list_db_users,
            commands::privileges::list_user_privileges,
            commands::privileges::generate_create_user_sql,
            commands::privileges::generate_drop_user_sql,
            commands::privileges::generate_alter_password_sql,
            commands::privileges::generate_grant_sql,
            commands::privileges::generate_revoke_sql,
            commands::privileges::apply_privilege_sql,
            commands::inspector::query_stats_support,
            commands::inspector::sample_live_queries,
            commands::inspector::sample_statement_stats,
            commands::profile::profile_column,
            commands::advisor::analyze_schema_health,
            commands::diff::compare_schema,
            commands::diff::compare_table_data,
            commands::diff::diff_schema_snapshots,
            commands::sync::generate_sync_sql,
            commands::sync::generate_data_sync_sql,
            commands::sync::apply_sync_sql,
            commands::sandbox::create_sandbox,
            commands::sandbox::list_sandboxes,
            commands::sandbox::discard_sandbox,
            commands::sandbox::sandbox_table_diff,
            commands::sandbox::sandbox_schema_diff,
            commands::sandbox::filter_sandbox_data_diff,
            commands::sandbox::sandbox_advance_base,
            commands::profiles::list_profiles,
            commands::profiles::reveal_profile_secret,
            commands::profiles::save_profile,
            commands::profiles::delete_profile,
            commands::profiles::reorder_profiles,
            commands::profiles::export_profiles,
            commands::profiles::import_profiles,
            commands::profile_backup::export_profiles_encrypted,
            commands::profile_backup::import_profiles_encrypted,
            commands::snippets::list_snippets,
            commands::snippets::save_snippet,
            commands::snippets::delete_snippet,
            commands::history::list_history,
            commands::history::clear_history,
            commands::flight_recorder::list_flight_records,
            commands::flight_recorder::clear_flight_records,
            commands::flight_recorder::preview_undo,
            commands::flight_recorder::undo_flight_record,
            commands::timelapse::timelapse_watch_table,
            commands::timelapse::timelapse_capture,
            commands::timelapse::timelapse_list_watches,
            commands::timelapse::timelapse_diff_generations,
            commands::timelapse::timelapse_unwatch,
            commands::timelapse::timelapse_clear_all,
            commands::logs::read_logs,
            commands::logs::clear_logs,
            commands::export::export_query_result,
            commands::export::export_query_stream,
            commands::export::mask_export_rows,
            commands::dump::dump_database,
            commands::import::parse_csv_preview,
            commands::import::import_csv,
            commands::script::run_sql_script,
            commands::transfer::transfer_data,
            commands::import::preview_create_table_ddl,
            commands::file::read_text_file,
            commands::file::write_binary_file,
            commands::local::create_local_session,
            commands::local::register_local_table,
            commands::local::list_local_tables,
            commands::local::drop_local_table,
            commands::local::save_local_database,
            commands::tasks::list_tasks,
            commands::tasks::save_task,
            commands::tasks::delete_task,
            commands::tasks::set_task_enabled,
            commands::tasks::run_task_now,
            commands::tasks::list_task_runs,
            commands::tasks::clear_task_runs,
            commands::tasks::get_scheduler_settings,
            commands::tasks::set_scheduler_settings,
            commands::schema::refresh_schema_cache,
        ])
        .run(tauri::generate_context!());

    if let Err(e) = result {
        tracing::error!(error = %e, "fatal error while running noobDB");
        // Tauri のイベントループ自体が起動失敗した場合はプロセスを即終了する以外に
        // 回復手段がない。ここでの panic は意図的であり、OS のクラッシュレポートに
        // 原因を残すためにも panic が最適な選択肢となる。
        #[allow(clippy::panic)]
        {
            panic!("error while running noobDB: {e}");
        }
    }
}
